import { describe, it, expect, vi } from 'vitest'
import { jsEngine, initInk } from './engine'
import type { Sample } from '../types'

// The JS fallback mirrors engine/ink.go (perfect-freehand port); the Go tests
// assert the same invariants and the same magic values (e.g. x≈19.25 below).

const line = (dx: number, dt: number, n: number, p = 0.5) =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: dx * i, t: dt * i, p }))

const feedAll = (
  ink: ReturnType<typeof jsEngine>,
  id: number,
  pts: { x: number; t: number; p: number }[],
) => pts.map((pt) => ink.addPoint(id, pt.x, 0, pt.t, pt.p))

const count = (batches: Sample[][]) => batches.reduce((n, b) => n + b.length, 0)

describe('jsEngine stroke lifecycle', () => {
  it('returns increasing stroke ids', () => {
    const ink = jsEngine()
    const a = ink.begin('draw')
    const b = ink.begin('draw')
    expect(b).toBeGreaterThan(a)
  })

  it('ignores unknown stroke ids', () => {
    const ink = jsEngine()
    expect(ink.addPoint(999, 0, 0, 0, 0.5)).toEqual([])
    expect(ink.predict(999, 0, 0, 0, 0.5)).toEqual([])
    expect(ink.end(999)).toEqual([])
  })

  it('drops the stroke after end()', () => {
    const ink = jsEngine()
    const id = ink.begin('write')
    ink.addPoint(id, 0, 0, 0, 0.5)
    ink.end(id)
    expect(ink.addPoint(id, 1, 1, 8, 0.5)).toEqual([])
    expect(ink.end(id)).toEqual([])
  })
})

describe('jsEngine sampling', () => {
  it('emits samples shaped {x,y,w,a}', () => {
    const ink = jsEngine()
    const id = ink.begin('write')
    ink.addPoint(id, 0, 0, 0, 0.5)
    const out = ink.addPoint(id, 10, 0, 16, 0.5)
    for (const s of out) {
      expect(Object.keys(s).sort()).toEqual(['a', 'w', 'x', 'y'])
      expect(s.w).toBeGreaterThan(0)
      expect(s.a).toBeGreaterThan(0)
    }
  })

  it('gates leading points behind the minimum length', () => {
    // write dia=4.4 -> minLen 2.2; the first point seeds a dot, then
    // ~0.5px steps stay gated until the running length passes 2.2.
    const ink = jsEngine()
    const id = ink.begin('write')
    const b = feedAll(ink, id, line(0.5, 16, 12))
    expect(b[0]).toHaveLength(1)
    for (const batch of b.slice(1, 4)) expect(batch).toEqual([])
    expect(count(b)).toBeGreaterThan(0)
  })

  it('eraser has a constant width of 13 and alpha 1', () => {
    const ink = jsEngine()
    const id = ink.begin('eraser')
    for (const batch of feedAll(ink, id, line(10, 16, 10))) {
      for (const s of batch) {
        expect(s.w).toBe(13)
        expect(s.a).toBe(1)
      }
    }
    expect(ink.end(id).length).toBeGreaterThan(0)
  })

  it('simulated pressure: slow strokes are wider than fast ones', () => {
    // constant input pressure -> simulated from speed (slow pools wide).
    const lastW = (dx: number) => {
      const ink = jsEngine()
      const id = ink.begin('draw')
      let w = 0
      for (const batch of feedAll(ink, id, line(dx, 16, 20))) {
        for (const s of batch) w = s.w
      }
      expect(w).toBeGreaterThan(0)
      return w
    }
    expect(lastW(4)).toBeGreaterThan(lastW(60))
  })

  it('varying input pressure switches to real pressure and widens the line', () => {
    const ink = jsEngine()
    const id = ink.begin('write')
    let first = 0
    let last = 0
    for (const batch of feedAll(ink, id, [
      { x: 0, t: 0, p: 0.1 },
      { x: 5, t: 16, p: 0.1 },
      { x: 10, t: 32, p: 0.9 },
      { x: 15, t: 48, p: 0.9 },
    ])) {
      for (const s of batch) {
        if (!first) first = s.w
        last = s.w
      }
    }
    expect(last).toBeGreaterThan(first)
  })

  it('tapers the stroke start', () => {
    const ink = jsEngine()
    const id = ink.begin('draw')
    let first = 0
    let mid = 0
    let n = 0
    for (const batch of feedAll(ink, id, line(2, 16, 30))) {
      for (const s of batch) {
        if (!first) first = s.w
        mid = s.w
        n++
      }
    }
    expect(n).toBeGreaterThan(2)
    expect(first).toBeLessThan(mid)
  })

  it('holds the end-taper tail back until end(), then tapers it', () => {
    const ink = jsEngine()
    const id = ink.begin('draw')
    const b = feedAll(ink, id, line(2, 16, 30))
    expect(count(b)).toBeGreaterThan(0)
    const tail = ink.end(id)
    expect(tail.length).toBeGreaterThan(0)
    expect(tail.at(-1)!.w).toBeLessThan(tail[0].w)
  })

  it('a tap leaves a full-size dot', () => {
    const ink = jsEngine()
    const id = ink.begin('draw')
    expect(ink.addPoint(id, 50, 50, 0, 0.5)).toEqual([])
    const tail = ink.end(id)
    expect(tail).toHaveLength(1)
    expect(tail[0]).toMatchObject({ x: 50, y: 50 })
    expect(tail[0].w).toBeGreaterThanOrEqual(0.5)
  })

  it('stabilizer makes the stroke lag the raw input', () => {
    // stab=1 -> tInterp 0.1925: adjusted point lands at 19.25 of 100.
    const ink = jsEngine()
    const id = ink.begin('shapes', 1, 1)
    ink.addPoint(id, 0, 0, 0, 0.5)
    const b = ink.addPoint(id, 100, 0, 16, 0.5)
    expect(b.at(-1)!.x).toBeCloseTo(19.25, 3)
    // shapes default streamline 0 -> tracks the raw point exactly.
    const ink2 = jsEngine()
    const id2 = ink2.begin('shapes')
    ink2.addPoint(id2, 0, 0, 0, 0.5)
    expect(ink2.addPoint(id2, 100, 0, 16, 0.5).at(-1)!.x).toBe(100)
  })

  it('predict() previews samples without mutating the stroke', () => {
    const ink = jsEngine()
    const id = ink.begin('draw')
    ink.addPoint(id, 0, 0, 0, 0.5)
    ink.addPoint(id, 10, 0, 16, 0.5)
    const prev = ink.predict(id, 20, 0, 32, 0.5)
    const real = ink.addPoint(id, 20, 0, 32, 0.5)
    expect(real).toEqual(prev)
  })

  it('tail() previews the flush without ending the stroke', () => {
    const ink = jsEngine()
    const id = ink.begin('draw')
    for (let i = 0; i <= 30; i++) ink.addPoint(id, 2 * i, 0, 16 * i, 0.5)
    const preview = ink.tail(id)
    expect(preview.length).toBeGreaterThan(0)
    expect(ink.tail(id)).toEqual(preview) // repeatable — the stroke stays open
    expect(ink.end(id)).toEqual(preview)
  })

  it('keeps parallel strokes isolated', () => {
    const ink = jsEngine()
    const a = ink.begin('draw')
    const b = ink.begin('write')
    ink.addPoint(a, 0, 0, 0, 0.5)
    ink.addPoint(b, 100, 100, 0, 0.5)
    const sa = ink.addPoint(a, 10, 0, 16, 0.5)
    const sb = ink.addPoint(b, 110, 100, 16, 0.5)
    expect(sa[0].a).toBe(0.92)
    expect(sb[0].a).toBe(1)
  })
})

describe('initInk', () => {
  it('falls back to the JS engine when wasm is unavailable', async () => {
    vi.resetModules()
    delete (window as { Go?: unknown }).Go
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { initInk: freshInit } = await import('./engine')
    const ink = await freshInit()
    expect(warn).toHaveBeenCalledOnce()
    const id = ink.begin('write')
    ink.addPoint(id, 0, 0, 0, 0.5)
    expect(ink.addPoint(id, 10, 0, 16, 0.5).length).toBeGreaterThan(0)
    ink.end(id)
    warn.mockRestore()
  })

  it('caches the engine promise', async () => {
    const a = await initInk()
    const b = await initInk()
    expect(a).toBe(b)
  })
})

describe('pixel kernels (jsEngine mirror of engine/px.go)', () => {
  const mkBuf = (w: number, h: number) => new Uint8ClampedArray(w * h * 4)

  it('floodFill respects the color boundary and paper-erased alpha', () => {
    const eng = jsEngine()
    const w = 4,
      h = 4
    const d = mkBuf(w, h)
    for (let y = 0; y < h; y++) for (let x = 2; x < w; x++) d[(y * w + x) * 4 + 3] = 255
    const n = eng.floodFill!(d, w, h, 0, 0, 10, 20, 30, 0, 246, 241, 230, 128)
    expect(n).toBe(8)
    expect([d[0], d[1], d[2], d[3]]).toEqual([10, 20, 30, 255])
    expect(d[2 * 4 + 3]).toBe(255) // untouched right half
  })

  it('floodFill with the seed color is a no-op', () => {
    const eng = jsEngine()
    const d = mkBuf(2, 2)
    expect(eng.floodFill!(d, 2, 2, 0, 0, 246, 241, 230, 42, 246, 241, 230, 128)).toBe(0)
  })

  it('boxBlur smears a dot and keeps alpha', () => {
    const eng = jsEngine()
    const d = mkBuf(5, 1)
    d[2 * 4] = 255
    eng.boxBlur!(d, 5, 1, 1)
    expect(d[2 * 4]).toBeLessThan(255)
    expect(d[1 * 4]).toBeGreaterThan(0)
  })

  it('sharpen darkens the halo around a bright dot', () => {
    const eng = jsEngine()
    const w = 5,
      h = 5
    const d = mkBuf(w, h)
    for (let i = 0; i < w * h; i++) {
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 128
      d[i * 4 + 3] = 255
    }
    d[(2 * w + 2) * 4] = 255
    eng.sharpen!(d, w, h, 1)
    expect(d[(1 * w + 2) * 4]).toBeLessThan(128)
  })

  it('adjust desaturates and lifts brightness without touching alpha', () => {
    const eng = jsEngine()
    const d = Uint8ClampedArray.from([100, 50, 25, 255])
    eng.adjust!(d, 0, 0, -1)
    expect(Math.abs(d[0] - d[1])).toBeLessThanOrEqual(2)
    expect(d[3]).toBe(255)
  })

  it('wetStroke drags canvas color along the stroke', () => {
    const eng = jsEngine()
    const w = 20,
      h = 20
    const d = mkBuf(w, h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < 10; x++) {
        const i = (y * w + x) * 4
        d[i + 2] = 200
        d[i + 3] = 255
      }
    eng.wetStroke!(d, w, h, [5, 10, 3, 0.8, 8, 10, 3, 0.8, 11, 10, 3, 0.8], 255, 0, 0, 1)
    expect(d[(10 * w + 11) * 4 + 2]).toBeGreaterThanOrEqual(50)
  })
})

describe('inverseFill and eraseColor kernels', () => {
  it('inverseFill paints the complement of the region', () => {
    const w = 4,
      h = 4
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 2; x < w; x++) d[(y * w + x) * 4 + 3] = 255
    const n = jsEngine().inverseFill!(d, w, h, 0, 0, 10, 20, 30, 0, 246, 241, 230, 128)
    expect(n).toBe(8)
    expect([d[0], d[3]]).toEqual([0, 0]) // region untouched
    expect([d[8], d[8 + 3]]).toEqual([10, 255]) // background filled
  })

  it('eraseColor clears the contiguous matching region', () => {
    const w = 4,
      h = 4
    const d = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) d[i * 4 + 3] = 255
    const n = jsEngine().eraseColor!(d, w, h, 0, 0, 0)
    expect(n).toBe(16)
    expect(d[3]).toBe(0)
  })
})
