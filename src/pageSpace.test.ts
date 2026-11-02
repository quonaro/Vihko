import { describe, it, expect } from 'vitest'
import { PAGE_W, PAGE_H, PAGE_UNIT, PAGE_ASPECT, coverViewport, clampOffset } from './pageSpace'

describe('page dimensions', () => {
  it('match the 300x380 preview viewBox at factor 0.28', () => {
    expect(PAGE_W).toBeCloseTo(300 / 0.28)
    expect(PAGE_H).toBeCloseTo(PAGE_UNIT * PAGE_ASPECT)
    expect(PAGE_H / PAGE_W).toBeCloseTo(380 / 300)
  })
})

describe('coverViewport', () => {
  it('is height-driven on tall portrait screens, overflowing horizontally', () => {
    const v = coverViewport(393, 873)
    expect(v.s).toBeCloseTo(873 / PAGE_H)
    expect(v.oy).toBeCloseTo(0)
    expect(v.ox).toBeCloseTo((393 - PAGE_W * v.s) / 2)
    expect(v.ox).toBeLessThan(0)
    expect(PAGE_W * v.s).toBeGreaterThan(393)
  })

  it('is width-driven on wide screens, overflowing vertically', () => {
    const v = coverViewport(1600, 900)
    expect(v.s).toBeCloseTo(1600 / PAGE_W)
    expect(v.ox).toBeCloseTo(0)
    expect(v.oy).toBeCloseTo((900 - PAGE_H * v.s) / 2)
    expect(v.oy).toBeLessThan(0)
  })

  it('has no overflow when the aspect matches exactly', () => {
    const v = coverViewport(300, 380)
    expect(v.ox).toBeCloseTo(0)
    expect(v.oy).toBeCloseTo(0)
  })
})

describe('clampOffset', () => {
  it('keeps the sheet covering the viewport on the overflow axis', () => {
    const v = coverViewport(393, 873)
    const lo = 393 - PAGE_W * v.s // most-negative allowed offset
    expect(clampOffset(v.ox - 9999, v.oy, v.s, 393, 873).ox).toBeCloseTo(lo)
    expect(clampOffset(v.ox + 9999, v.oy, v.s, 393, 873).ox).toBe(0)
    expect(clampOffset(v.ox - 40, v.oy, v.s, 393, 873).ox).toBeCloseTo(v.ox - 40)
  })

  it('pins the offset on the axis where the sheet fits exactly', () => {
    const v = coverViewport(393, 873)
    expect(clampOffset(v.ox, v.oy - 100, v.s, 393, 873).oy).toBe(0)
    expect(clampOffset(v.ox, v.oy + 100, v.s, 393, 873).oy).toBe(0)
  })

  it('centers the sheet where it fits inside the viewport (zoomed out)', () => {
    // 1000x700 is wider than the page aspect: at s=0.7 the sheet fits in x
    // (750 < 1000) but still overflows in y (950 > 700).
    const s = 0.7
    const centered = (1000 - PAGE_W * s) / 2
    expect(clampOffset(-500, 0, s, 1000, 700).ox).toBeCloseTo(centered)
    expect(clampOffset(500, 0, s, 1000, 700).ox).toBeCloseTo(centered)
    // the overflowing axis still clamps as before
    const lo = 700 - PAGE_H * s
    expect(clampOffset(0, lo - 500, s, 1000, 700).oy).toBeCloseTo(lo)
    expect(clampOffset(0, 500, s, 1000, 700).oy).toBe(0)
  })
})
