import { describe, it, expect, vi } from 'vitest'
import { jsEngine, initInk } from './engine'

// The JS fallback mirrors engine/main.go; the Go tests assert the same
// invariants and the same magic values (e.g. w≈7.0314 below).

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

  it('keeps a 2-point lookahead and flushes the tail on end', () => {
    const ink = jsEngine()
    const id = ink.begin('write')
    expect(ink.addPoint(id, 0, 0, 0, 0.5)).toEqual([])
    for (const n of [[10, 0, 16], [20, 0, 32], [30, 0, 48]]) {
      expect(ink.addPoint(id, n[0], n[1], n[2], 0.5)).toHaveLength(6)
    }
    const tail = ink.end(id)
    expect(tail).toHaveLength(6)
    expect(ink.end(id)).toEqual([])
  })

  it('emits 10 samples for segments longer than 40px', () => {
    const ink = jsEngine()
    const id = ink.begin('write')
    ink.addPoint(id, 0, 0, 0, 0.5)
    expect(ink.addPoint(id, 100, 0, 16, 0.5)).toHaveLength(10)
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

  it('spline passes through the raw points', () => {
    const ink = jsEngine()
    const id = ink.begin('write')
    ink.addPoint(id, 0, 0, 0, 0.5)
    const b1 = ink.addPoint(id, 10, 0, 16, 0.5)
    const b2 = ink.addPoint(id, 20, 5, 32, 0.5)
    expect(b1.at(-1)).toMatchObject({ x: 10, y: 0 })
    expect(b2.at(-1)).toMatchObject({ x: 20, y: 5 })
  })

  it('write tool has constant width 2.2 and alpha 1', () => {
    const ink = jsEngine()
    const id = ink.begin('write')
    ink.addPoint(id, 0, 0, 0, 0.5)
    const out = ink.addPoint(id, 10, 0, 16, 0.5)
    for (const s of out) {
      expect(s.w).toBe(2.2)
      expect(s.a).toBe(1)
    }
  })

  it('shapes tool uses a constant-width outline', () => {
    const ink = jsEngine()
    const id = ink.begin('shapes')
    ink.addPoint(id, 0, 0, 0, 0.5)
    const out = ink.addPoint(id, 10, 0, 16, 0.5)
    expect(out[0]).toMatchObject({ w: 2.2, a: 1 })
  })

  it('draw tool: first width equals the velocity target (~7.0321)', () => {
    // v = 10px / 16ms = 0.625 px/ms -> 1.6 + 8*(1-e^(-0.625/0.55))
    const ink = jsEngine()
    const id = ink.begin('draw')
    ink.addPoint(id, 0, 0, 0, 0.5)
    const out = ink.addPoint(id, 10, 0, 16, 0.5)
    expect(out[0].w).toBeCloseTo(7.0321, 3)
    expect(out[0].a).toBe(0.92)
  })

  it('draw tool thickens with speed; color does the opposite', () => {
    const firstW = (tool: string, dt: number) => {
      const ink = jsEngine()
      const id = ink.begin(tool)
      ink.addPoint(id, 0, 0, 0, 0.5)
      return ink.addPoint(id, 10, 0, dt, 0.5)[0].w
    }
    expect(firstW('draw', 4)).toBeGreaterThan(firstW('draw', 100))
    expect(firstW('color', 100)).toBeGreaterThan(firstW('color', 4))
  })

  it('clamps width into the tool profile range', () => {
    const ink = jsEngine()
    const id = ink.begin('outline')
    ink.addPoint(id, 0, 0, 0, 0.5)
    const out = ink.addPoint(id, 10, 0, 1, 0.5) // v=10 px/ms, very fast
    for (const s of out) {
      expect(s.w).toBeGreaterThanOrEqual(5.0)
      expect(s.w).toBeLessThanOrEqual(10.5)
    }
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
    expect(sa.at(-1)).toMatchObject({ x: 10, y: 0 })
    expect(sb.at(-1)).toMatchObject({ x: 110, y: 100 })
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
