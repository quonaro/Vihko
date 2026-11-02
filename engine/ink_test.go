package main

import (
	"math"
	"testing"
)

func TestProfile(t *testing.T) {
	cases := []struct {
		tool                       string
		baseW, velGain, minW, maxW float64
		alpha                      float64
	}{
		{"draw", 1.6, 8.0, 0.9, 10.0, 0.92},
		{"write", 2.2, 0.0, 2.2, 2.2, 1.0},
		{"shapes", 2.2, 0.0, 2.2, 2.2, 1.0},
		{"outline", 6.5, 2.5, 5.0, 10.5, 0.95},
		{"sketch", 2.4, 3.5, 1.0, 6.5, 0.6},
		{"color", 12.0, 24.0, 8.0, 46.0, 0.045},
		{"eraser", 13.0, 5.0, 9.0, 26.0, 1.0},
		{"unknown", 2.5, 0, 2.5, 2.5, 1},
	}
	for _, c := range cases {
		b, g, mn, mx, a := profile(c.tool)
		if b != c.baseW || g != c.velGain || mn != c.minW || mx != c.maxW || a != c.alpha {
			t.Errorf("profile(%q) = (%v,%v,%v,%v,%v)", c.tool, b, g, mn, mx, a)
		}
	}
}

func TestTargetWidth(t *testing.T) {
	// "write" has zero velocity gain: width is constant at any speed.
	if w := targetWidth("write", 0); w != 2.2 {
		t.Errorf("write v=0: got %v, want 2.2", w)
	}
	if w := targetWidth("write", 50); w != 2.2 {
		t.Errorf("write v=50: got %v, want 2.2", w)
	}

	// "draw" thickens with speed (monotonic, saturating).
	slow, fast := targetWidth("draw", 0.1), targetWidth("draw", 3)
	if !(slow < fast) {
		t.Errorf("draw should widen with speed: slow=%v fast=%v", slow, fast)
	}
	if w := targetWidth("draw", 0); w != 1.6 {
		t.Errorf("draw v=0: got %v, want base 1.6", w)
	}
	// saturates below maxW
	if w := targetWidth("draw", 1e6); math.Abs(w-9.6) > 1e-9 {
		t.Errorf("draw v=inf: got %v, want ~9.6", w)
	}

	// "color" inverts the curve: slower movement pools more paint.
	if !(targetWidth("color", 0.1) > targetWidth("color", 3)) {
		t.Error("color should widen when slower")
	}
	if w := targetWidth("color", 1e6); math.Abs(w-12.0) > 1e-9 {
		t.Errorf("color v=inf: got %v, want base 12", w)
	}

	// exact known value (parity-checked against the JS fallback engine):
	// v = 10px/16ms = 0.625 px/ms -> tw = 1.6 + 8*(1-exp(-0.625/0.55))
	if w := targetWidth("draw", 0.625); math.Abs(w-7.0321) > 0.0005 {
		t.Errorf("draw v=0.625: got %v, want ~7.0321", w)
	}
}

func TestCatmullEndpoints(t *testing.T) {
	// The spline interpolates its inner control points.
	if got := catmull(1, 10, 20, 30, 0); got != 10 {
		t.Errorf("t=0: got %v, want 10", got)
	}
	if got := catmull(1, 10, 20, 30, 1); got != 20 {
		t.Errorf("t=1: got %v, want 20", got)
	}
}

// feed drives a stroke through the same path jsAddPoint uses.
func feed(s *stroke, pts ...Point) [][]Sample {
	var batches [][]Sample
	for _, p := range pts {
		s.pts = append(s.pts, p)
		batches = append(batches, s.samplesFor(false))
	}
	return batches
}

func count(batches [][]Sample) int {
	n := 0
	for _, b := range batches {
		n += len(b)
	}
	return n
}

func TestStrokeLookaheadAndFlush(t *testing.T) {
	s := &stroke{tool: "write", seg: -1}
	pts := []Point{{0, 0, 0, .5}, {10, 0, 16, .5}, {20, 0, 32, .5}, {30, 0, 48, .5}}
	batches := feed(s, pts...)

	// One point: nothing to emit. Each further point emits one 6-sample
	// segment except the last, which is held for lookahead until flush.
	if len(batches[0]) != 0 {
		t.Fatalf("after 1 point: %d samples, want 0", len(batches[0]))
	}
	if len(batches[1]) != 6 || len(batches[2]) != 6 || len(batches[3]) != 6 {
		t.Fatalf("want 6 samples per segment, got %v",
			[]int{len(batches[1]), len(batches[2]), len(batches[3])})
	}
	tail := s.samplesFor(true)
	if len(tail) != 6 {
		t.Fatalf("flush: %d samples, want 6", len(tail))
	}
	if total := count(batches) + len(tail); total != 24 {
		t.Fatalf("total %d samples, want 24 (4 segments x 6)", total)
	}
	// Second flush emits nothing.
	if again := s.samplesFor(true); len(again) != 0 {
		t.Fatalf("repeated flush emitted %d samples", len(again))
	}
}

func TestStrokeLongSegments(t *testing.T) {
	s := &stroke{tool: "write", seg: -1}
	// 100px per step -> dist > 40 -> 10 samples per segment.
	b := feed(s, Point{0, 0, 0, .5}, Point{100, 0, 16, .5})
	if len(b[1]) != 10 {
		t.Fatalf("long segment: %d samples, want 10", len(b[1]))
	}
}

func TestStrokeSplineHitsControlPoints(t *testing.T) {
	s := &stroke{tool: "write", seg: -1}
	b := feed(s, Point{0, 0, 0, .5}, Point{10, 0, 16, .5}, Point{20, 5, 32, .5})
	// Catmull-Rom at t=1 lands exactly on p2 = the point after the segment start.
	last := b[1][len(b[1])-1]
	if last.X != 10 || last.Y != 0 {
		t.Errorf("segment end: got (%v,%v), want (10,0)", last.X, last.Y)
	}
	last2 := b[2][len(b[2])-1]
	if last2.X != 20 || last2.Y != 5 {
		t.Errorf("segment end: got (%v,%v), want (20,5)", last2.X, last2.Y)
	}
}

func TestStrokeWidthAndAlpha(t *testing.T) {
	s := &stroke{tool: "write", seg: -1}
	b := feed(s, Point{0, 0, 0, .5}, Point{10, 0, 16, .5})
	for i, sm := range b[1] {
		if sm.W != 2.2 || sm.A != 1.0 {
			t.Fatalf("sample %d: got w=%v a=%v, want w=2.2 a=1", i, sm.W, sm.A)
		}
	}

	// First emitted width equals the un-smoothed target width (EMA seed).
	d := &stroke{tool: "draw", seg: -1}
	bd := feed(d, Point{0, 0, 0, .5}, Point{10, 0, 16, .5})
	if w := bd[1][0].W; math.Abs(w-7.0321) > 0.0005 {
		t.Errorf("draw first w: got %v, want ~7.0321", w)
	}

	// Faster stroke -> wider line for "draw".
	fast := &stroke{tool: "draw", seg: -1}
	bf := feed(fast, Point{0, 0, 0, .5}, Point{10, 0, 4, .5})
	if !(bf[1][0].W > bd[1][0].W) {
		t.Errorf("fast stroke w=%v should exceed slow w=%v", bf[1][0].W, bd[1][0].W)
	}
}

func TestStrokesAreIsolated(t *testing.T) {
	a := &stroke{tool: "draw", seg: -1}
	b := &stroke{tool: "write", seg: -1}
	feed(a, Point{0, 0, 0, .5})
	feed(b, Point{100, 100, 0, .5})
	ba := feed(a, Point{10, 0, 16, .5})
	bb := feed(b, Point{110, 100, 16, .5})
	if len(ba[0]) != 6 || len(bb[0]) != 6 {
		t.Fatal("interleaved strokes should progress independently")
	}
	if ba[0][0].A != 0.92 || bb[0][0].A != 1.0 {
		t.Fatal("per-stroke tool profiles leaked across strokes")
	}
}
