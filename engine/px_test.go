package main

import "testing"

func TestFloodFillRect(t *testing.T) {
	w, h := 4, 4
	buf := make([]byte, w*h*4)
	// right half is black
	for y := 0; y < h; y++ {
		for x := 2; x < w; x++ {
			buf[(y*w+x)*4+3] = 255
		}
	}
	n := FloodFill(buf, w, h, 0, 0, 10, 20, 30, 0, 246, 241, 230, 128)
	if n != 8 {
		t.Fatalf("painted %d, want 8", n)
	}
	if buf[0] != 10 || buf[1] != 20 || buf[2] != 30 || buf[3] != 255 {
		t.Fatalf("seed pixel not repainted: %v", buf[:4])
	}
	if buf[(2)*4+3] != 255 {
		t.Fatal("fill leaked past the color boundary")
	}
}

func TestFloodFillSeedEqualsTarget(t *testing.T) {
	w, h := 2, 2
	buf := make([]byte, w*h*4)
	if n := FloodFill(buf, w, h, 0, 0, 246, 241, 230, 42, 246, 241, 230, 128); n != 0 {
		t.Fatalf("filling with the seed color should be a no-op, got %d", n)
	}
}

func TestBoxBlurAverages(t *testing.T) {
	w, h := 5, 1
	buf := make([]byte, w*h*4)
	buf[2*4] = 255 // single red pixel in the middle
	BoxBlur(buf, w, h, 1)
	// alpha untouched, red smeared: center keeps ~85
	if buf[2*4] == 255 || buf[0] != 0 {
		t.Fatalf("blur wrong: %v", buf[:w*4])
	}
	if buf[1*4] == 0 || buf[3*4] == 0 {
		t.Fatal("neighbours untouched")
	}
}

func TestSharpenBoostsEdges(t *testing.T) {
	// a bright dot on a mid-gray field: unsharp mask must darken the halo
	w, h := 5, 5
	buf := make([]byte, w*h*4)
	for i := 0; i < w*h; i++ {
		buf[i*4], buf[i*4+1], buf[i*4+2], buf[i*4+3] = 128, 128, 128, 255
	}
	buf[(2*w+2)*4] = 255
	Sharpen(buf, w, h, 1)
	if buf[(1*w+2)*4] >= 128 {
		t.Fatalf("sharpen did not darken the halo: %d", buf[(1*w+2)*4])
	}
}

func TestAdjustBrightnessSaturation(t *testing.T) {
	buf := []byte{100, 50, 25, 255}
	Adjust(buf, 0, 0, -1) // full desaturate
	r, g, b := buf[0], buf[1], buf[2]
	if abs(int(r)-int(g)) > 2 || abs(int(g)-int(b)) > 2 {
		t.Fatalf("not desaturated: %v", buf[:3])
	}
	if buf[3] != 255 {
		t.Fatal("alpha changed")
	}
	buf2 := []byte{100, 50, 25, 255}
	Adjust(buf2, 0.2, 0, 0)
	if buf2[0] <= 100 {
		t.Fatal("brightness did not lift")
	}
}

func TestWetStrokePicksUpColor(t *testing.T) {
	w, h := 20, 20
	buf := make([]byte, w*h*4)
	// paint left half blue
	for y := 0; y < h; y++ {
		for x := 0; x < 10; x++ {
			i := (y*w + x) * 4
			buf[i+2], buf[i+3] = 200, 255
		}
	}
	// stroke crossing the blue region with full pickup
	dabs := []float64{5, 10, 3, 0.8, 8, 10, 3, 0.8, 11, 10, 3, 0.8}
	WetStroke(buf, w, h, dabs, 255, 0, 0, 1.0)
	// the last dab should have dragged blue into the empty region
	i := (10*w + 11) * 4
	if buf[i+2] < 50 {
		t.Fatalf("no wet pickup happened: %v", buf[i:i+4])
	}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func TestInverseFill(t *testing.T) {
	w, h := 4, 4
	buf := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		for x := 2; x < w; x++ {
			buf[(y*w+x)*4+3] = 255 // opaque black wall on the right
		}
	}
	n := InverseFill(buf, w, h, 0, 0, 10, 20, 30, 0, 246, 241, 230, 128)
	// region = left half (8 px, alpha<128→paper match); complement = right half
	if n != 8 {
		t.Fatalf("painted %d, want 8", n)
	}
	if buf[0] != 0 || buf[3] != 0 {
		t.Fatalf("region pixel was repainted: %v", buf[:4])
	}
	if buf[2*4] != 10 || buf[2*4+3] != 255 {
		t.Fatalf("background pixel not filled: %v", buf[2*4:2*4+4])
	}
}

func TestEraseColor(t *testing.T) {
	w, h := 4, 4
	buf := make([]byte, w*h*4)
	for i := 0; i < w*h; i++ {
		buf[i*4+3] = 255 // uniform opaque field
	}
	n := EraseColor(buf, w, h, 0, 0, 0)
	if n != 16 {
		t.Fatalf("cleared %d, want 16", n)
	}
	if buf[3] != 0 {
		t.Fatal("alpha not cleared")
	}
}
