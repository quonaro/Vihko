// Pixel kernels for raster ops (flood fill, filters, wet-mixing).
// Same rules as ink.go: no build tag, pure logic, covered by `go test`;
// the syscall/js bindings live in main.go and the JS mirror in
// src/ink/engine.ts must stay in lockstep.
//
// All kernels operate on straight (non-premultiplied) RGBA bytes in
// Canvas ImageData layout: buf[y*w+x] = {r,g,b,a}.

package main

import "math"

func clamp8(v float64) uint8 {
	if v <= 0 {
		return 0
	}
	if v >= 255 {
		return 255
	}
	return uint8(v + 0.5)
}

// FloodFill repaints the connected region around (sx,sy) whose colors are
// within tol*3 of the seed color (Manhattan distance over RGB). Pixels with
// alpha < athresh read as the paper color (pr,pg,pb) — erased areas keep
// filling like paper instead of breaking the region. Written pixels get
// alpha=255. Returns the number of painted pixels.
func FloodFill(
	buf []byte, w, h, sx, sy int,
	r, g, b uint8, tol float64,
	pr, pg, pb, athresh uint8,
) int {
	if sx < 0 || sy < 0 || sx >= w || sy >= h || len(buf) < w*h*4 {
		return 0
	}
	si := (sy*w + sx) * 4
	var sr, sg, sb uint8
	if buf[si+3] < athresh {
		sr, sg, sb = pr, pg, pb
	} else {
		sr, sg, sb = buf[si], buf[si+1], buf[si+2]
	}
	if absI(int(r)-int(sr))+absI(int(g)-int(sg))+absI(int(b)-int(sb)) < 3 {
		dlog("floodFill: seed already has the target color")
		return 0 // seed pixel already carries the fill color
	}
	tol3 := tol * 3
	erasedMatches := float64(absI(int(pr)-int(sr))+absI(int(pg)-int(sg))+absI(int(pb)-int(sb))) <= tol3
	match := func(i int) bool {
		if buf[i+3] < athresh {
			return erasedMatches
		}
		return float64(absI(int(buf[i])-int(sr))+absI(int(buf[i+1])-int(sg))+absI(int(buf[i+2])-int(sb))) <= tol3
	}
	visited := make([]bool, w*h)
	stack := make([]int, 0, 4096)
	stack = append(stack, sy*w+sx)
	visited[sy*w+sx] = true
	painted := 0
	for len(stack) > 0 {
		p := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		i := p * 4
		if !match(i) {
			continue
		}
		buf[i], buf[i+1], buf[i+2], buf[i+3] = r, g, b, 255
		painted++
		x, y := p%w, p/w
		for _, n := range [][2]int{{x - 1, y}, {x + 1, y}, {x, y - 1}, {x, y + 1}} {
			if n[0] < 0 || n[1] < 0 || n[0] >= w || n[1] >= h {
				continue
			}
			np := n[1]*w + n[0]
			if !visited[np] {
				visited[np] = true
				stack = append(stack, np)
			}
		}
	}
	return painted
}

func absI(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// boxBlurPass blurs one axis in place using a sliding window on floats.
func boxBlurPass(buf []byte, tmp []float64, w, h, r int, horizontal bool) {
	dim, other := w, h
	if !horizontal {
		dim, other = h, w
	}
	win := float64(r*2 + 1)
	for o := 0; o < other; o++ {
		for ch := 0; ch < 3; ch++ {
			acc := 0.0
			for i := -r; i <= r; i++ {
				p := i
				if p < 0 {
					p = 0
				}
				if p >= dim {
					p = dim - 1
				}
				var idx int
				if horizontal {
					idx = (o*w + p) * 4
				} else {
					idx = (p*w + o) * 4
				}
				acc += float64(buf[idx+ch])
			}
			for i := 0; i < dim; i++ {
				tmp[i] = acc / win
				// slide: drop i-r, add i+r+1 (clamped at edges)
				out, in := i-r, i+r+1
				if out < 0 {
					out = 0
				}
				if in >= dim {
					in = dim - 1
				}
				var oi, ii int
				if horizontal {
					oi = (o*w + out) * 4
					ii = (o*w + in) * 4
				} else {
					oi = (out*w + o) * 4
					ii = (in*w + o) * 4
				}
				acc += float64(buf[ii+ch]) - float64(buf[oi+ch])
			}
			for i := 0; i < dim; i++ {
				var idx int
				if horizontal {
					idx = (o*w + i) * 4
				} else {
					idx = (i*w + o) * 4
				}
				buf[idx+ch] = clamp8(tmp[i])
			}
		}
	}
}

// BoxBlur applies a two-pass separable box blur with the given radius.
// Alpha is left untouched so edges stay glued to the layer content.
func BoxBlur(buf []byte, w, h, radius int) {
	if radius < 1 || len(buf) < w*h*4 {
		return
	}
	tmp := make([]float64, max(w, h))
	boxBlurPass(buf, tmp, w, h, radius, true)
	boxBlurPass(buf, tmp, w, h, radius, false)
}

// Sharpen applies an unsharp mask: out = src + (src - blur(src)) * amount.
func Sharpen(buf []byte, w, h int, amount float64) {
	if amount <= 0 || len(buf) < w*h*4 {
		return
	}
	src := make([]byte, len(buf))
	copy(src, buf)
	blur := make([]byte, len(buf))
	copy(blur, buf)
	BoxBlur(blur, w, h, 3)
	for i := 0; i < len(buf); i += 4 {
		for ch := 0; ch < 3; ch++ {
			d := float64(src[i+ch]) - float64(blur[i+ch])
			buf[i+ch] = clamp8(float64(src[i+ch]) + d*amount)
		}
	}
}

// Adjust applies brightness (-1..1 offset), contrast (-1..1 pivot at 0.5)
// and saturation (-1..1 lerp toward luma) per pixel. Alpha untouched.
func Adjust(buf []byte, brightness, contrast, saturation float64) {
	k := 1 + contrast
	for i := 0; i+3 < len(buf); i += 4 {
		r := float64(buf[i]) / 255
		g := float64(buf[i+1]) / 255
		b := float64(buf[i+2]) / 255
		luma := 0.299*r + 0.587*g + 0.114*b
		adj := func(v float64) float64 {
			v += brightness
			v = (v-0.5)*k + 0.5
			v += (v - luma) * saturation
			return v
		}
		buf[i] = clamp8(adj(r) * 255)
		buf[i+1] = clamp8(adj(g) * 255)
		buf[i+2] = clamp8(adj(b) * 255)
	}
}

// WetStroke smears watercolor dabs over the buffer, clean-room spec
// inspired by libmypaint's wet mixing: each dab picks up the average color
// under its footprint (sampled slightly ahead along the stroke direction,
// which drags paint forward) and re-deposits brush*(1-pickup) + picked*pickup
// through a soft round mask. dabs is a flat [x,y,hw,alpha]*n array where hw
// is the dab half-width in buffer pixels.
func WetStroke(buf []byte, w, h int, dabs []float64, r, g, b uint8, pickup float64) {
	n := len(dabs) / 4
	if n == 0 || len(buf) < w*h*4 {
		return
	}
	for i := 0; i < n; i++ {
		x, y, hw, alpha := dabs[i*4], dabs[i*4+1], dabs[i*4+2], dabs[i*4+3]
		if hw < 0.5 || alpha <= 0 {
			continue
		}
		rad := hw * 2
		// pickup sample point: one radius ahead along the stroke direction
		px, py := x, y
		if i+1 < n {
			dx, dy := dabs[i*4+4]-x, dabs[i*4+5]-y
			l := math.Hypot(dx, dy)
			if l > 0 {
				px += dx / l * rad * 0.7
				py += dy / l * rad * 0.7
			}
		}
		// gather the weighted average under the pickup circle
		var pr, pg, pb, pw float64
		x0, x1 := int(px-rad), int(px+rad)+1
		y0, y1 := int(py-rad), int(py+rad)+1
		for yy := y0; yy < y1; yy++ {
			for xx := x0; xx < x1; xx++ {
				if xx < 0 || yy < 0 || xx >= w || yy >= h {
					continue
				}
				d := math.Hypot(float64(xx)-px, float64(yy)-py) / rad
				if d >= 1 {
					continue
				}
				wgt := 1 - d
				ii := (yy*w + xx) * 4
				aw := wgt * float64(buf[ii+3]) / 255
				pr += float64(buf[ii]) * aw
				pg += float64(buf[ii+1]) * aw
				pb += float64(buf[ii+2]) * aw
				pw += aw
			}
		}
		var mr, mg, mb float64
		if pw > 0 {
			mr = float64(r)*(1-pickup) + pr/pw*pickup
			mg = float64(g)*(1-pickup) + pg/pw*pickup
			mb = float64(b)*(1-pickup) + pb/pw*pickup
		} else {
			mr, mg, mb = float64(r), float64(g), float64(b)
		}
		// deposit the dab through a soft mask (normal blend)
		x0, x1 = int(x-rad), int(x+rad)+1
		y0, y1 = int(y-rad), int(y+rad)+1
		for yy := y0; yy < y1; yy++ {
			for xx := x0; xx < x1; xx++ {
				if xx < 0 || yy < 0 || xx >= w || yy >= h {
					continue
				}
				d := math.Hypot(float64(xx)-x, float64(yy)-y) / rad
				if d >= 1 {
					continue
				}
				k := (1 - d) * alpha
				ii := (yy*w + xx) * 4
				buf[ii] = clamp8(float64(buf[ii])*(1-k) + mr*k)
				buf[ii+1] = clamp8(float64(buf[ii+1])*(1-k) + mg*k)
				buf[ii+2] = clamp8(float64(buf[ii+2])*(1-k) + mb*k)
				na := float64(buf[ii+3]) + alpha*(1-d)*255 - float64(buf[ii+3])*alpha*(1-d)
				buf[ii+3] = clamp8(na)
			}
		}
	}
}

// InverseFill paints every pixel NOT in the seed's matching region — the
// "background fill" counterpart of FloodFill. Matching rules are identical
// (alpha < athresh reads as paper); written pixels get alpha=255.
func InverseFill(
	buf []byte, w, h, sx, sy int,
	r, g, b uint8, tol float64,
	pr, pg, pb, athresh uint8,
) int {
	if sx < 0 || sy < 0 || sx >= w || sy >= h || len(buf) < w*h*4 {
		return 0
	}
	si := (sy*w + sx) * 4
	var sr, sg, sb uint8
	if buf[si+3] < athresh {
		sr, sg, sb = pr, pg, pb
	} else {
		sr, sg, sb = buf[si], buf[si+1], buf[si+2]
	}
	tol3 := tol * 3
	erasedMatches := float64(absI(int(pr)-int(sr))+absI(int(pg)-int(sg))+absI(int(pb)-int(sb))) <= tol3
	match := func(i int) bool {
		if buf[i+3] < athresh {
			return erasedMatches
		}
		return float64(absI(int(buf[i])-int(sr))+absI(int(buf[i+1])-int(sg))+absI(int(buf[i+2])-int(sb))) <= tol3
	}
	// Mark the region, then paint the complement.
	visited := make([]bool, w*h)
	stack := []int{sy*w + sx}
	visited[sy*w+sx] = true
	for len(stack) > 0 {
		p := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if !match(p * 4) {
			continue
		}
		x, y := p%w, p/w
		for _, n := range [][2]int{{x - 1, y}, {x + 1, y}, {x, y - 1}, {x, y + 1}} {
			if n[0] < 0 || n[1] < 0 || n[0] >= w || n[1] >= h {
				continue
			}
			np := n[1]*w + n[0]
			if !visited[np] {
				visited[np] = true
				stack = append(stack, np)
			}
		}
	}
	painted := 0
	for p := 0; p < w*h; p++ {
		i := p * 4
		if visited[p] && match(i) {
			continue // inside the region — leave it
		}
		buf[i], buf[i+1], buf[i+2], buf[i+3] = r, g, b, 255
		painted++
	}
	return painted
}

// EraseColor removes the contiguous region of similar color around (sx,sy)
// (magic-wand background removal): matching pixels become fully transparent.
// Unlike fills there is no paper substitution — alpha is matched as-is.
// Returns the number of cleared pixels.
func EraseColor(buf []byte, w, h, sx, sy int, tol float64) int {
	if sx < 0 || sy < 0 || sx >= w || sy >= h || len(buf) < w*h*4 {
		return 0
	}
	si := (sy*w + sx) * 4
	sr, sg, sb, sa := buf[si], buf[si+1], buf[si+2], buf[si+3]
	tol2 := tol * tol
	match := func(i int) bool {
		dr := float64(buf[i]) - float64(sr)
		dg := float64(buf[i+1]) - float64(sg)
		db := float64(buf[i+2]) - float64(sb)
		da := float64(buf[i+3]) - float64(sa)
		return dr*dr+dg*dg+db*db+da*da <= tol2
	}
	visited := make([]bool, w*h)
	stack := []int{sy*w + sx}
	visited[sy*w+sx] = true
	cleared := 0
	for len(stack) > 0 {
		p := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		i := p * 4
		if !match(i) {
			continue
		}
		buf[i+3] = 0
		cleared++
		x, y := p%w, p/w
		for _, n := range [][2]int{{x - 1, y}, {x + 1, y}, {x, y - 1}, {x, y + 1}} {
			if n[0] < 0 || n[1] < 0 || n[0] >= w || n[1] >= h {
				continue
			}
			np := n[1]*w + n[0]
			if !visited[np] {
				visited[np] = true
				stack = append(stack, np)
			}
		}
	}
	return cleared
}
