// Pure ink-engine logic: pointer points -> smoothed stroke samples
// {x, y, w, a} where w = half-width in normalized units (scaled by the
// stroke's brush size at render time), a = alpha multiplier [0..1].
//
// The stroke model is a port of the perfect-freehand algorithm (MIT,
// github.com/steveruizok/perfect-freehand) adapted to incremental
// centerline sampling instead of closed outline polygons:
//   - streamline lerps each raw point toward the previous kept point,
//   - pressure is taken from real stylus input when it varies, otherwise
//     simulated from speed (slow movement -> high pressure),
//   - radius = dia * (0.5 - thinning*(0.5 - pressure)),
//   - start/end tapers shrink the radius near the stroke ends; the end
//     taper is applied to the buffered tail on flush.
//
// This file has no js/wasm build tag so `go test` can exercise it natively;
// the syscall/js bindings live in main.go. Keep src/ink/engine.ts
// (jsEngine) in lockstep — the parity tests assert the same magic values.

package main

import "math"

type Point struct {
	X, Y, T, P float64
}

type Sample struct {
	X, Y, W, A float64
}

// pendSample is an emitted-but-held-back sample; RL is the stroke's running
// length at the sample. Samples are released once they leave the end-taper
// zone so the tail can still be shaped on flush.
type pendSample struct {
	Sample
	RL float64
}

type toolProfile struct {
	dia        float64 // diameter multiplier; half-width at p=0.5 = dia*0.5*size
	thinning   float64 // pressure influence on width, 0..1
	streamline float64 // input smoothing, 0 = raw, 1 = heavy lag
	taperStart float64 // taper length at stroke start, in diameters
	taperEnd   float64 // taper length at stroke end, in diameters
	alpha      float64
}

func profile(tool string) toolProfile {
	switch tool {
	case "draw": // fountain pen: strong pressure response, tapered ends
		return toolProfile{3.6, 0.75, 0.5, 2.0, 1.5, 0.92}
	case "write": // rollerball: near-uniform thin line
		return toolProfile{4.4, 0.1, 0.5, 0, 0, 1.0}
	case "shapes": // geometric shapes: raw input, uniform width
		return toolProfile{4.4, 0, 0, 0, 0, 1.0}
	case "outline": // marker: bold, slight width variation
		return toolProfile{13, 0.1, 0.45, 0, 0.5, 0.95}
	case "sketch": // pencil: soft, moderate variation, tapered
		return toolProfile{4.8, 0.6, 0.55, 1.5, 1.0, 0.6}
	case "color": // watercolor: wide, very pressure-sensitive pooling
		return toolProfile{24, 0.9, 0.6, 0.75, 0, 0.045}
	case "eraser":
		return toolProfile{26, 0, 0.4, 0, 0, 1.0}
	}
	return toolProfile{5, 0.5, 0.5, 0, 0, 1}
}

const (
	rateOfPressureChange = 0.275 // perfect-freehand RATE_OF_PRESSURE_CHANGE
	realPressureDelta    = 0.04  // |p - firstP| beyond this -> real stylus input
	minGap               = 0.25  // drop adjusted points closer than this (noise)
	minW                 = 0.05  // floor for emitted half-widths
)

type stroke struct {
	tool    string
	prof    toolProfile
	dia     float64 // absolute diameter = prof.dia * size
	tInterp float64 // streamline lerp factor toward the raw point

	pts     []Point // raw input points (end() re-feeds the last one exactly)
	prev    Point   // last kept adjusted point (only .X/.Y are used)
	hasPrev bool
	firstP  float64
	prevP   float64 // smoothed pressure
	realP   bool    // pressure came from real input (varied), not simulated
	rl      float64 // running length at the last kept point
	minOK   bool    // passed the minimum-length gate
	lastW   float64 // width of the last buffered sample (for subdivision lerp)
	buf     []pendSample
	emitted bool
}

var (
	strokes = map[float64]*stroke{}
	nextID  = 1.0
)

// newStroke builds a stroke; size is the brush-size multiplier (affects
// simulated-pressure speed normalization and taper distances), stab>=0
// overrides the profile streamline (brush stabilizer).
func newStroke(tool string, size, stab float64) *stroke {
	p := profile(tool)
	if size <= 0 {
		size = 1
	}
	sl := p.streamline
	if stab >= 0 {
		sl = math.Min(0.95, math.Max(0, stab))
	}
	return &stroke{
		tool:    tool,
		prof:    p,
		dia:     p.dia * size,
		tInterp: 0.15 + (1-sl)*0.85,
	}
}

func (s *stroke) minLen() float64 {
	return math.Min(math.Max(s.dia*0.5, 1.5), 10)
}

func (s *stroke) pressureFor(p Point, dist float64) float64 {
	if !s.realP && math.Abs(p.P-s.firstP) > realPressureDelta {
		s.realP = true
	}
	if s.realP {
		s.prevP += (p.P - s.prevP) * 0.6
		return s.prevP
	}
	sp := math.Min(1, dist/s.dia)
	rp := math.Min(1, 1-sp)
	s.prevP = math.Min(1, s.prevP+(rp-s.prevP)*(sp*rateOfPressureChange))
	return s.prevP
}

func (s *stroke) widthFor(pr float64) float64 {
	w := s.prof.dia * (0.5 - s.prof.thinning*(0.5-pr))
	ts := s.prof.taperStart * s.dia
	if ts > 0 && s.rl < ts {
		f := s.rl / ts
		w *= math.Max(0.02, f*(2-f)) // taperStartEase
	}
	return math.Max(minW, w)
}

// buffer pushes one sample and releases everything that has left the
// end-taper zone (teDist behind the head). teDist=0 drains immediately.
func (s *stroke) buffer(x, y, rl, w float64, out *[]Sample) {
	s.buf = append(s.buf, pendSample{Sample{X: x, Y: y, W: w, A: s.prof.alpha}, rl})
	te := s.prof.taperEnd * s.dia
	for len(s.buf) > 0 && s.rl-s.buf[0].RL >= te {
		*out = append(*out, s.buf[0].Sample)
		s.buf = s.buf[1:]
		s.emitted = true
	}
}

// feed consumes one raw point. With last=true (stroke end) the point is used
// verbatim instead of the lagged streamline interpolation.
func (s *stroke) feed(p Point, last bool, out *[]Sample) {
	if !s.hasPrev {
		s.hasPrev = true
		s.prev = p
		s.prevP = p.P
		s.firstP = p.P
		w := s.widthFor(p.P)
		s.lastW = w
		s.buffer(p.X, p.Y, 0, w, out)
		return
	}
	ax, ay := p.X, p.Y
	if !last {
		ax = s.prev.X + (p.X-s.prev.X)*s.tInterp
		ay = s.prev.Y + (p.Y-s.prev.Y)*s.tInterp
	}
	dist := math.Hypot(ax-s.prev.X, ay-s.prev.Y)
	if dist < minGap && !last {
		return
	}
	prevRL := s.rl
	s.rl += dist
	// Suppress leading noise until the stroke reaches its minimum length;
	// the final point always passes (PF does the same via `i < max`).
	if !s.minOK && !last && s.rl < s.minLen() {
		return
	}
	s.minOK = true

	pr := s.pressureFor(p, dist)
	w := s.widthFor(pr)

	// Subdivide long jumps so the renderer's quads stay smooth.
	step := math.Max(2, 0.3*s.dia)
	n := int(math.Ceil(dist / step))
	if n < 1 {
		n = 1
	}
	for k := 1; k <= n; k++ {
		f := float64(k) / float64(n)
		s.buffer(
			s.prev.X+(ax-s.prev.X)*f,
			s.prev.Y+(ay-s.prev.Y)*f,
			prevRL+dist*f,
			s.lastW+(w-s.lastW)*f,
			out,
		)
	}
	s.lastW = w
	s.prev.X, s.prev.Y = ax, ay
}

// flush re-feeds the final raw point exactly, then shapes the held-back tail
// with the end taper and emits a dot for strokes that produced nothing.
func (s *stroke) flush() []Sample {
	out := []Sample{}
	if len(s.pts) > 0 {
		last := s.pts[len(s.pts)-1]
		// Re-feeding only matters when the raw point still lags behind the
		// streamline-adjusted head; identical points would emit a duplicate.
		if math.Hypot(last.X-s.prev.X, last.Y-s.prev.Y) > 0 {
			s.feed(last, true, &out)
		}
	}
	te := s.prof.taperEnd * s.dia
	for _, e := range s.buf {
		if te > 0 {
			rem := s.rl - e.RL
			if rem < te {
				f := math.Max(0, rem/te)
				e.W *= math.Max(0.02, 1-(1-f)*(1-f)*(1-f)) // taperEndEase
				if e.W < minW {
					e.W = minW
				}
			}
		}
		out = append(out, e.Sample)
	}
	s.buf = nil
	if s.hasPrev && s.rl < s.minLen() {
		// A tap or sub-min-length squiggle still leaves a full-size dot.
		w := s.prof.dia * (0.5 - s.prof.thinning*(0.5-s.prevP))
		out = []Sample{{X: s.prev.X, Y: s.prev.Y, W: math.Max(minW, w), A: s.prof.alpha}}
	}
	if len(out) > 0 {
		s.emitted = true
	}
	return out
}

// predict computes the samples a point would produce without committing to
// them (pointer prediction preview). The stroke state is untouched.
func (s *stroke) predict(p Point) []Sample {
	c := *s
	c.buf = append([]pendSample{}, s.buf...)
	out := []Sample{}
	c.feed(p, false, &out)
	return out
}

// tail returns the samples a flush would emit if the stroke ended now — the
// held-back buffer shaped by the end taper — without ending the stroke.
func (s *stroke) tail() []Sample {
	c := *s
	c.buf = append([]pendSample{}, s.buf...)
	return c.flush()
}
