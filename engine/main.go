//go:build js && wasm

// Ink engine for Vihko (clean-room reimplementation) — js/wasm bindings.
// The engine logic itself lives in ink.go (build-tag-free, covered by go test).
// Rendering (canvas paint) is done on the JS side.

package main

import "syscall/js"

// begin(tool, size?, stab?) -> stroke id
// size = brush-size multiplier (default 1); stab >= 0 overrides the tool's
// streamline (brush stabilizer, 0..1).
func jsBegin(this js.Value, args []js.Value) any {
	tool := args[0].String()
	size, stab := 1.0, -1.0
	if len(args) > 1 {
		size = args[1].Float()
	}
	if len(args) > 2 {
		stab = args[2].Float()
	}
	id := nextID
	nextID++
	strokes[id] = newStroke(tool, size, stab)
	dlog("begin id=%v tool=%q size=%v stab=%v", id, tool, size, stab)
	return js.ValueOf(id)
}

// addPoint(id, x, y, t, pressure) -> [{x,y,w,a}, ...]
func jsAddPoint(this js.Value, args []js.Value) any {
	id := args[0].Float()
	s := strokes[id]
	if s == nil {
		return js.ValueOf([]any{})
	}
	p := Point{
		X: args[1].Float(), Y: args[2].Float(),
		T: args[3].Float(), P: args[4].Float(),
	}
	s.pts = append(s.pts, p)
	out := []Sample{}
	s.feed(p, false, &out)
	return samplesToJS(out)
}

// predict(id, x, y, t, pressure) -> samples the point would produce, without
// committing to them (pointer-prediction preview).
func jsPredict(this js.Value, args []js.Value) any {
	id := args[0].Float()
	s := strokes[id]
	if s == nil {
		return js.ValueOf([]any{})
	}
	return samplesToJS(s.predict(Point{
		X: args[1].Float(), Y: args[2].Float(),
		T: args[3].Float(), P: args[4].Float(),
	}))
}

// end(id) -> tail samples
func jsEnd(this js.Value, args []js.Value) any {
	id := args[0].Float()
	s := strokes[id]
	if s == nil {
		return js.ValueOf([]any{})
	}
	out := s.flush()
	delete(strokes, id)
	dlog("end id=%v samples=%d", id, len(out))
	return samplesToJS(out)
}

// tail(id) -> the samples a flush would emit if the stroke ended now
// (live-repaint preview of the end taper). The stroke stays open.
func jsTail(this js.Value, args []js.Value) any {
	id := args[0].Float()
	s := strokes[id]
	if s == nil {
		return js.ValueOf([]any{})
	}
	return samplesToJS(s.tail())
}

func samplesToJS(samples []Sample) js.Value {
	arr := make([]any, len(samples))
	for i, sm := range samples {
		arr[i] = map[string]any{
			"x": sm.X, "y": sm.Y, "w": sm.W, "a": sm.A,
		}
	}
	return js.ValueOf(arr)
}

// --- pixel kernels (px.go) ------------------------------------------------
// Each binding copies the passed Uint8ClampedArray into Go memory, runs the
// kernel and copies it back — ImageData.data can be passed directly.

// floodFill(data, w, h, x, y, r, g, b, tol, pr, pg, pb, athresh)
//
//	-> painted pixel count
func jsFloodFill(this js.Value, args []js.Value) any {
	buf := copyFromJS(args[0])
	w, h := int(args[1].Float()), int(args[2].Float())
	x, y := int(args[3].Float()), int(args[4].Float())
	n := FloodFill(buf, w, h, x, y,
		uint8(args[5].Float()), uint8(args[6].Float()), uint8(args[7].Float()),
		args[8].Float(),
		uint8(args[9].Float()), uint8(args[10].Float()), uint8(args[11].Float()),
		uint8(args[12].Float()))
	copyToJS(args[0], buf)
	return js.ValueOf(n)
}

// boxBlur(data, w, h, radius)
func jsBoxBlur(this js.Value, args []js.Value) any {
	buf := copyFromJS(args[0])
	BoxBlur(buf, int(args[1].Float()), int(args[2].Float()), int(args[3].Float()))
	copyToJS(args[0], buf)
	return nil
}

// sharpen(data, w, h, amount)
func jsSharpen(this js.Value, args []js.Value) any {
	buf := copyFromJS(args[0])
	Sharpen(buf, int(args[1].Float()), int(args[2].Float()), args[3].Float())
	copyToJS(args[0], buf)
	return nil
}

// adjust(data, w, h, brightness, contrast, saturation)
func jsAdjust(this js.Value, args []js.Value) any {
	buf := copyFromJS(args[0])
	Adjust(buf, args[3].Float(), args[4].Float(), args[5].Float())
	copyToJS(args[0], buf)
	return nil
}

// wetStroke(data, w, h, dabs: Float64Array|number[], r, g, b, pickup)
func jsWetStroke(this js.Value, args []js.Value) any {
	buf := copyFromJS(args[0])
	w, h := int(args[1].Float()), int(args[2].Float())
	dabsJS := args[3]
	n := dabsJS.Length()
	dabs := make([]float64, n)
	for i := 0; i < n; i++ {
		dabs[i] = dabsJS.Index(i).Float()
	}
	WetStroke(buf, w, h, dabs,
		uint8(args[4].Float()), uint8(args[5].Float()), uint8(args[6].Float()),
		args[7].Float())
	copyToJS(args[0], buf)
	return nil
}

// inverseFill(data, w, h, x, y, r, g, b, tol, pr, pg, pb, athresh)
//
//	-> painted pixel count (complement of the seed region)
func jsInverseFill(this js.Value, args []js.Value) any {
	buf := copyFromJS(args[0])
	w, h := int(args[1].Float()), int(args[2].Float())
	x, y := int(args[3].Float()), int(args[4].Float())
	n := InverseFill(buf, w, h, x, y,
		uint8(args[5].Float()), uint8(args[6].Float()), uint8(args[7].Float()),
		args[8].Float(),
		uint8(args[9].Float()), uint8(args[10].Float()), uint8(args[11].Float()),
		uint8(args[12].Float()))
	copyToJS(args[0], buf)
	return js.ValueOf(n)
}

// eraseColor(data, w, h, x, y, tol) -> cleared pixel count
func jsEraseColor(this js.Value, args []js.Value) any {
	buf := copyFromJS(args[0])
	w, h := int(args[1].Float()), int(args[2].Float())
	x, y := int(args[3].Float()), int(args[4].Float())
	n := EraseColor(buf, w, h, x, y, args[5].Float())
	copyToJS(args[0], buf)
	return js.ValueOf(n)
}

// setDebug(bool) — toggles decision-point logging in the engine.
func jsSetDebug(this js.Value, args []js.Value) any {
	Debug = len(args) > 0 && args[0].Bool()
	return nil
}

func copyFromJS(v js.Value) []byte {
	buf := make([]byte, v.Length())
	js.CopyBytesToGo(buf, v)
	return buf
}

func copyToJS(v js.Value, buf []byte) {
	js.CopyBytesToJS(v, buf)
}

func main() {
	ink := js.Global().Get("Object").New()
	ink.Set("begin", js.FuncOf(jsBegin))
	ink.Set("addPoint", js.FuncOf(jsAddPoint))
	ink.Set("predict", js.FuncOf(jsPredict))
	ink.Set("end", js.FuncOf(jsEnd))
	ink.Set("tail", js.FuncOf(jsTail))
	ink.Set("floodFill", js.FuncOf(jsFloodFill))
	ink.Set("boxBlur", js.FuncOf(jsBoxBlur))
	ink.Set("sharpen", js.FuncOf(jsSharpen))
	ink.Set("adjust", js.FuncOf(jsAdjust))
	ink.Set("wetStroke", js.FuncOf(jsWetStroke))
	ink.Set("inverseFill", js.FuncOf(jsInverseFill))
	ink.Set("eraseColor", js.FuncOf(jsEraseColor))
	ink.Set("setDebug", js.FuncOf(jsSetDebug))
	js.Global().Set("Ink", ink)
	js.Global().Get("console").Call("debug", "[ink] wasm engine initialized")
	select {}
}
