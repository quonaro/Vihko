import { describe, it, expect } from 'vitest'
import { PAGE_W, PAGE_H, PAGE_UNIT, PAGE_ASPECT, coverViewport, spreadRect } from './pageSpace'

describe('page dimensions', () => {
  it('match the 600x380 landscape spread at factor 0.28', () => {
    expect(PAGE_W).toBeCloseTo(600 / 0.28)
    expect(PAGE_H).toBeCloseTo(PAGE_UNIT * PAGE_ASPECT)
    expect(PAGE_H / PAGE_W).toBeCloseTo(380 / 600)
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
    const v = coverViewport(600, 380)
    expect(v.ox).toBeCloseTo(0)
    expect(v.oy).toBeCloseTo(0)
  })
})

describe('spreadRect', () => {
  it('returns the whole sheet in full mode', () => {
    expect(spreadRect('full', PAGE_W, PAGE_H)).toEqual({ x: 0, y: 0, w: PAGE_W, h: PAGE_H })
  })

  it('crops a landscape sheet to the left or right half', () => {
    expect(spreadRect('left', PAGE_W, PAGE_H)).toEqual({
      x: 0,
      y: 0,
      w: PAGE_W / 2,
      h: PAGE_H,
    })
    expect(spreadRect('right', PAGE_W, PAGE_H)).toEqual({
      x: PAGE_W / 2,
      y: 0,
      w: PAGE_W / 2,
      h: PAGE_H,
    })
  })

  it('ignores the focus on portrait and square sheets', () => {
    expect(spreadRect('left', PAGE_W / 2, PAGE_H)).toEqual({
      x: 0,
      y: 0,
      w: PAGE_W / 2,
      h: PAGE_H,
    })
    expect(spreadRect('right', PAGE_H, PAGE_H)).toEqual({ x: 0, y: 0, w: PAGE_H, h: PAGE_H })
  })
})
