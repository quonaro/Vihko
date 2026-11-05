package main

import (
	"math"
	"testing"
)

func TestProfile(t *testing.T) {
	cases := []struct {
		tool                        string
		dia, thinning, streamline   float64
		taperStart, taperEnd, alpha float64
	}{
		{"draw", 3.6, 0.75, 0.5, 2.0, 1.5, 0.92},
		{"write", 4.4, 0.1, 0.5, 0, 0, 1.0},
		{"shapes", 4.4, 0, 0, 0, 0, 1.0},
		{"outline", 13, 0.1, 0.45, 0, 0.5, 0.95},
		{"sketch", 4.8, 0.6, 0.55, 1.5, 1.0, 0.6},
		{"color", 24, 0.9, 0.6, 0.75, 0, 0.045},
		{"eraser", 26, 0, 0.4, 0, 0, 1.0},
		{"unknown", 5, 0.5, 0.5, 0, 0, 1},
	}
	for _, c := range cases {
		p := profile(c.tool)
		if p.dia != c.dia || p.thinning != c.thinning || p.streamline != c.streamline ||
			p.taperStart != c.taperStart || p.taperEnd != c.taperEnd || p.alpha != c.alpha {
			t.Errorf("profile(%q) = %+v", c.tool, p)
		}
	}
}

func TestNewStrokeOptions(t *testing.T) {
	s := newStroke("draw", 2, -1)
	if s.dia != 7.2 {
		t.Errorf("dia: got %v, want 7.2", s.dia)
	}
	if s.tInterp != 0.575 { // 0.15 + (1-0.5)*0.85
		t.Errorf("tInterp: got %v, want 0.575", s.tInterp)
	}
	s = newStroke("draw", 0, 0.9)
	if s.dia != 3.6 { // size<=0 falls back to 1
		t.Errorf("dia: got %v, want 3.6", s.dia)
	}
	if s.tInterp != 0.235 { // 0.15 + (1-0.9)*0.85
		t.Errorf("stabilized tInterp: got %v, want 0.235", s.tInterp)
	}
	if s = newStroke("draw", 1, 2); math.Abs(s.tInterp-0.1925) > 1e-9 { // stab clamped to 0.95
		t.Errorf("clamped tInterp: got %v", s.tInterp)
	}
}

// feed drives a stroke like jsAddPoint does.
func feedPts(s *stroke, pts ...Point) [][]Sample {
	var batches [][]Sample
	for _, p := range pts {
		s.pts = append(s.pts, p)
		out := []Sample{}
		s.feed(p, false, &out)
		batches = append(batches, out)
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

func line(dx, dt float64, n int) []Point {
	pts := make([]Point, 0, n+1)
	for i := 0; i <= n; i++ {
		pts = append(pts, Point{X: dx * float64(i), T: dt * float64(i), P: 0.5})
	}
	return pts
}

func TestMinimumLengthGate(t *testing.T) {
	// write dia=4.4 -> minLen = 2.2. The first point seeds a dot immediately;
	// the next points stay gated until ~0.5px steps accumulate past 2.2.
	s := newStroke("write", 1, -1)
	b := feedPts(s, line(0.5, 16, 12)...)
	if len(b[0]) != 1 {
		t.Fatalf("first point: %d samples, want 1 (seed dot)", len(b[0]))
	}
	for i := 1; i < 4; i++ {
		if len(b[i]) != 0 {
			t.Fatalf("batch %d: %d samples before min length", i, len(b[i]))
		}
	}
	if count(b) == 0 {
		t.Fatal("no samples after passing min length")
	}
}

func TestConstantWidthTool(t *testing.T) {
	// eraser: thinning 0 -> uniform width = dia*0.5 regardless of speed.
	s := newStroke("eraser", 1, -1)
	b := feedPts(s, line(10, 16, 10)...)
	for _, batch := range b {
		for _, sm := range batch {
			if sm.W != 13 || sm.A != 1 {
				t.Fatalf("eraser sample: got w=%v a=%v, want 13,1", sm.W, sm.A)
			}
		}
	}
	if tail := s.flush(); len(tail) == 0 {
		t.Fatal("flush emitted nothing")
	}
}

func TestSimulatedPressureSlowIsWide(t *testing.T) {
	// draw thinning>0 + constant input pressure -> simulated pressure:
	// slow movement pools into high pressure -> wider line.
	// Compare steady-state width: the last sample emitted before flush is
	// past the start taper and the simulated pressure has converged.
	lastW := func(dx float64) float64 {
		s := newStroke("draw", 1, -1)
		w := 0.0
		for _, batch := range feedPts(s, line(dx, 16, 20)...) {
			for _, sm := range batch {
				w = sm.W
			}
		}
		if w == 0 {
			t.Fatalf("no samples for dx=%v", dx)
		}
		return w
	}
	slow, fast := lastW(4), lastW(60)
	if !(slow > fast) {
		t.Errorf("slow stroke w=%v should exceed fast w=%v", slow, fast)
	}
}

func TestRealPressureDetection(t *testing.T) {
	s := newStroke("draw", 1, -1)
	feedPts(s,
		Point{0, 0, 0, .2}, Point{10, 0, 16, .6}, Point{20, 0, 32, .9},
	)
	if !s.realP {
		t.Error("varying pressure should switch to real-pressure mode")
	}
	c := newStroke("draw", 1, -1)
	feedPts(c, Point{0, 0, 0, .5}, Point{10, 0, 16, .5}, Point{20, 0, 32, .5})
	if c.realP {
		t.Error("constant pressure should stay simulated")
	}
}

func TestRealPressureModulatesWidth(t *testing.T) {
	s := newStroke("write", 1, -1) // small thinning, but nonzero
	b := feedPts(s,
		Point{0, 0, 0, .1},
		Point{5, 0, 16, .1},
		Point{10, 0, 32, .9},
		Point{15, 0, 48, .9},
	)
	var first, last float64
	for _, batch := range b {
		for _, sm := range batch {
			if first == 0 {
				first = sm.W
			}
			last = sm.W
		}
	}
	if !(last > first) {
		t.Errorf("higher pressure should widen: first=%v last=%v", first, last)
	}
}

func TestStartTaper(t *testing.T) {
	// draw taperStart = 2*dia: the first emitted sample is narrower than
	// one a few diameters into the stroke.
	s := newStroke("draw", 1, -1)
	b := feedPts(s, line(2, 16, 30)...)
	var first, mid float64
	n := 0
	for _, batch := range b {
		for _, sm := range batch {
			if first == 0 {
				first = sm.W
			}
			mid = sm.W
			n++
		}
	}
	if first == 0 || n < 3 {
		t.Fatalf("not enough samples: first=%v n=%d", first, n)
	}
	if !(first < mid) {
		t.Errorf("start taper: first w=%v should be < mid w=%v", first, mid)
	}
}

func TestEndTaperHeldBackUntilFlush(t *testing.T) {
	// draw taperEnd = 1.5*dia = 5.4: the tail stays buffered until flush.
	s := newStroke("draw", 1, -1)
	b := feedPts(s, line(2, 16, 30)...)
	emitted := count(b)
	tail := s.flush()
	if len(tail) == 0 {
		t.Fatal("end taper zone should be emitted only on flush")
	}
	if emitted == 0 {
		t.Fatal("body samples should emit during the stroke")
	}
	// Tail width shrinks toward the end point.
	if last, firstTail := tail[len(tail)-1].W, tail[0].W; !(last < firstTail) {
		t.Errorf("end taper: last w=%v should be < first tail w=%v", last, firstTail)
	}
}

func TestTailPreviewsFlush(t *testing.T) {
	// tail() must equal what flush() later emits, and leave the stroke open:
	// a repeat call returns the same preview.
	s := newStroke("draw", 1, -1)
	feedPts(s, line(2, 16, 30)...)
	preview := s.tail()
	if len(preview) == 0 {
		t.Fatal("tail preview emitted nothing")
	}
	again := s.tail()
	if len(again) != len(preview) || again[0] != preview[0] {
		t.Fatal("tail is not repeatable — it mutated the stroke")
	}
	real := s.flush()
	if len(real) != len(preview) {
		t.Fatalf("tail/flush length mismatch: %v vs %v", len(preview), len(real))
	}
	for i := range real {
		if real[i] != preview[i] {
			t.Fatalf("tail[%v] = %+v, flush gave %+v", i, preview[i], real[i])
		}
	}
}

func TestTapDrawsDot(t *testing.T) {
	s := newStroke("draw", 1, -1)
	b := feedPts(s, Point{50, 50, 0, .5})
	if count(b) != 0 {
		t.Fatal("single point should not emit during the stroke")
	}
	tail := s.flush()
	if len(tail) != 1 {
		t.Fatalf("dot: got %d samples, want 1", len(tail))
	}
	if tail[0].X != 50 || tail[0].Y != 50 {
		t.Errorf("dot position: got (%v,%v)", tail[0].X, tail[0].Y)
	}
	if tail[0].W < 0.5 {
		t.Errorf("dot too small: w=%v", tail[0].W)
	}
}

func TestStreamlineLagsRawPoint(t *testing.T) {
	// stab=1 -> tInterp 0.15: adjusted point trails far behind the input.
	s := newStroke("shapes", 1, 1) // shapes profile, heavy stabilizer
	b := feedPts(s, Point{0, 0, 0, .5}, Point{100, 0, 16, .5})
	if len(b[1]) == 0 {
		t.Fatal("no samples")
	}
	last := b[1][len(b[1])-1]
	if math.Abs(last.X-19.25) > 0.001 {
		t.Errorf("stabilized x: got %v, want 19.25 (0.1925 toward 100)", last.X)
	}
	// Streamline 0 (shapes default) tracks the raw point exactly.
	s2 := newStroke("shapes", 1, -1)
	b2 := feedPts(s2, Point{0, 0, 0, .5}, Point{100, 0, 16, .5})
	if got := b2[1][len(b2[1])-1].X; got != 100 {
		t.Errorf("raw tracking: got %v, want 100", got)
	}
}

func TestPredictDoesNotMutate(t *testing.T) {
	s := newStroke("draw", 1, -1)
	feedPts(s, Point{0, 0, 0, .5}, Point{10, 0, 16, .5})
	ptsBefore, rlBefore, bufBefore := len(s.pts), s.rl, len(s.buf)
	prev := s.predict(Point{20, 0, 32, .5})
	if len(s.pts) != ptsBefore || s.rl != rlBefore || len(s.buf) != bufBefore {
		t.Fatal("predict mutated stroke state")
	}
	out := []Sample{}
	s.feed(Point{20, 0, 32, .5}, false, &out)
	if len(prev) != len(out) {
		t.Fatalf("predict emitted %d samples, replay emitted %d", len(prev), len(out))
	}
	for i := range prev {
		if prev[i] != out[i] {
			t.Fatalf("predict[%d] = %+v, replay = %+v", i, prev[i], out[i])
		}
	}
}

func TestStrokesAreIsolated(t *testing.T) {
	a := newStroke("draw", 1, -1)
	b := newStroke("write", 1, -1)
	feedPts(a, Point{0, 0, 0, .5})
	feedPts(b, Point{100, 100, 0, .5})
	ba := feedPts(a, Point{10, 0, 16, .5})
	bb := feedPts(b, Point{110, 100, 16, .5})
	if len(ba[0]) == 0 || len(bb[0]) == 0 {
		t.Fatal("interleaved strokes should progress independently")
	}
	if ba[0][0].A != 0.92 || bb[0][0].A != 1.0 {
		t.Fatal("per-stroke tool profiles leaked across strokes")
	}
}
