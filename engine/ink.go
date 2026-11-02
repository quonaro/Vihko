// Pure ink-engine logic: pointer points -> smoothed stroke samples
// {x, y, w, a} where w = half-width in px, a = alpha multiplier [0..1].
// This file has no js/wasm build tag so `go test` can exercise it natively;
// the syscall/js bindings live in main.go.

package main

import "math"

type Point struct {
	X, Y, T, P float64
}

type Sample struct {
	X, Y, W, A float64
}

type stroke struct {
	tool  string
	pts   []Point
	seg   int     // last emitted segment index
	smW   float64 // EMA-smoothed half-width
	lastS Sample
	hasS  bool
}

var (
	strokes = map[float64]*stroke{}
	nextID  = 1.0
)

// profile returns base half-width, velocity gain, min/max half-width, alpha.
func profile(tool string) (baseW, velGain, minW, maxW, alpha float64) {
	switch tool {
	case "draw": // fountain pen: faster stroke -> thicker line
		return 1.6, 8.0, 0.9, 10.0, 0.92
	case "write", "shapes": // rollerball and geometric shapes: uniform thin line
		return 2.2, 0.0, 2.2, 2.2, 1.0
	case "outline": // marker: bold, mild widening
		return 6.5, 2.5, 5.0, 10.5, 0.95
	case "sketch": // pencil: soft, moderate variation
		return 2.4, 3.5, 1.0, 6.5, 0.6
	case "color": // watercolor brush: wide, slow pools wider
		return 12.0, 24.0, 8.0, 46.0, 0.045
	case "eraser":
		return 13.0, 5.0, 9.0, 26.0, 1.0
	}
	return 2.5, 0, 2.5, 2.5, 1
}

// targetWidth maps pointer velocity (px/ms) to a half-width target.
// Tools that get thicker with speed use a saturating curve; "color" inverts it
// (slow movement pools more paint => wider).
func targetWidth(tool string, v float64) float64 {
	baseW, velGain, minW, maxW, _ := profile(tool)
	vRef := 0.55 // px/ms reference speed
	k := 1 - math.Exp(-v/vRef)
	t := baseW + velGain*k
	if tool == "color" {
		t = baseW + velGain*(1-k)
	}
	if t < minW {
		t = minW
	}
	if t > maxW {
		t = maxW
	}
	return t
}

func catmull(p0, p1, p2, p3, t float64) float64 {
	t2 := t * t
	t3 := t2 * t
	return 0.5 * (2*p1 + (p2-p0)*t + (2*p0-5*p1+4*p2-p3)*t2 + (3*p1-p0-3*p2+p3)*t3)
}

// emitSegment subdivides the segment p1->p2 with Catmull-Rom and appends
// samples to out. step is in output samples per segment.
func (s *stroke) emitSegment(out *[]Sample, i int, tool string) {
	n := len(s.pts)
	p0 := s.pts[max(0, i-1)]
	p1 := s.pts[i]
	p2 := s.pts[min(n-1, i+1)]
	p3 := s.pts[min(n-1, i+2)]

	dt := math.Max(p2.T-p1.T, 1)
	dist := math.Hypot(p2.X-p1.X, p2.Y-p1.Y)
	vel := dist / dt
	tw := targetWidth(tool, vel)
	if s.smW == 0 {
		s.smW = tw
	}
	s.smW += (tw - s.smW) * 0.35

	_, _, _, _, alpha := profile(tool)

	steps := 6
	if dist > 40 {
		steps = 10
	}
	for k := 1; k <= steps; k++ {
		t := float64(k) / float64(steps)
		x := catmull(p0.X, p1.X, p2.X, p3.X, t)
		y := catmull(p0.Y, p1.Y, p2.Y, p3.Y, t)
		*out = append(*out, Sample{X: x, Y: y, W: s.smW, A: alpha})
	}
}

// samplesFor consumes all unprocessed raw points and returns new samples.
// Keeps a 2-point lookahead buffer for the spline; flush=true on stroke end.
func (s *stroke) samplesFor(flush bool) []Sample {
	out := []Sample{}
	n := len(s.pts)
	limit := n - 2 // need i+1 and i+2 for catmull
	if flush {
		limit = n - 1
	}
	start := 0
	if s.hasS {
		start = s.seg + 1
	}
	for i := start; i <= limit && i < n; i++ {
		if i < 0 {
			continue
		}
		s.emitSegment(&out, i, s.tool)
		s.seg = i
		s.hasS = true
	}
	if len(out) > 0 {
		s.lastS = out[len(out)-1]
	}
	return out
}
