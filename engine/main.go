//go:build js && wasm

// Ink engine for Vihko (clean-room reimplementation) — js/wasm bindings.
// The engine logic itself lives in ink.go (build-tag-free, covered by go test).
// Rendering (canvas paint) is done on the JS side.

package main

import "syscall/js"

// begin stroke
func jsBegin(this js.Value, args []js.Value) any {
	tool := args[0].String()
	id := nextID
	nextID++
	strokes[id] = &stroke{tool: tool, seg: -1}
	return js.ValueOf(id)
}

// addPoint(id, x, y, t, pressure) -> [{x,y,w,a}, ...]
func jsAddPoint(this js.Value, args []js.Value) any {
	id := args[0].Float()
	s := strokes[id]
	if s == nil {
		return js.ValueOf([]any{})
	}
	s.pts = append(s.pts, Point{
		X: args[1].Float(), Y: args[2].Float(),
		T: args[3].Float(), P: args[4].Float(),
	})
	return samplesToJS(s.samplesFor(false))
}

// end(id) -> tail samples
func jsEnd(this js.Value, args []js.Value) any {
	id := args[0].Float()
	s := strokes[id]
	if s == nil {
		return js.ValueOf([]any{})
	}
	out := s.samplesFor(true)
	delete(strokes, id)
	return samplesToJS(out)
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

func main() {
	ink := js.Global().Get("Object").New()
	ink.Set("begin", js.FuncOf(jsBegin))
	ink.Set("addPoint", js.FuncOf(jsAddPoint))
	ink.Set("end", js.FuncOf(jsEnd))
	js.Global().Set("Ink", ink)
	select {}
}
