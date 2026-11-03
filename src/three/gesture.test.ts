import { describe, it, expect } from 'vitest'
import {
  RUBBER_BAND, FLICK_WINDOW_MS, MOMENTUM_DECAY,
  ZOOM_MIN, ZOOM_MAX, PAN_LIMIT,
  rubberScroll, flickVelocity, momentumStep, clampZoom, pinchZoom,
  panLimit, clampPan,
} from './gesture'

describe('rubberScroll', () => {
  it('passes values inside the limits through unchanged', () => {
    expect(rubberScroll(0.5, 2)).toBe(0.5)
    expect(rubberScroll(-2, 2)).toBe(-2)
    expect(rubberScroll(2, 2)).toBe(2)
  })

  it('resists overshoot past the limit', () => {
    expect(rubberScroll(3, 2)).toBeCloseTo(2 + RUBBER_BAND)
    expect(rubberScroll(-3, 2)).toBeCloseTo(-2 - RUBBER_BAND)
    expect(rubberScroll(1, 0)).toBeCloseTo(RUBBER_BAND)
  })
})

describe('flickVelocity', () => {
  it('returns px/s from recent trail motion', () => {
    const trail = [
      { x: 300, t: 0 },
      { x: 250, t: 50 },
      { x: 200, t: 100 },
    ]
    expect(flickVelocity(trail, 100)).toBeCloseTo(-1000)
  })

  it('ignores motion older than the flick window', () => {
    const trail = [
      { x: 500, t: 0 },
      { x: 480, t: FLICK_WINDOW_MS + 40 },
      { x: 470, t: FLICK_WINDOW_MS + 80 },
    ]
    // Only the last two samples are inside the window relative to `now`.
    expect(flickVelocity(trail, FLICK_WINDOW_MS + 80)).toBeCloseTo(-250)
  })

  it('is 0 when the finger stopped or barely moved', () => {
    expect(flickVelocity([], 100)).toBe(0)
    expect(flickVelocity([{ x: 10, t: 95 }], 100)).toBe(0)
    // Held still: the only recent samples have no time between them.
    expect(
      flickVelocity([{ x: 10, t: 0 }, { x: 10, t: 100 }], 500),
    ).toBe(0)
  })
})

describe('momentumStep', () => {
  it('integrates position and decays velocity inside the limits', () => {
    const s = momentumStep(0, 4, 10, 0.1)
    expect(s.pos).toBeCloseTo(0.4)
    expect(s.vel).toBeCloseTo(4 * Math.exp(-MOMENTUM_DECAY * 0.1))
    expect(s.vel).toBeLessThan(4)
  })

  it('stops at the scroll limit instead of bouncing', () => {
    const s = momentumStep(1.9, 4, 2, 0.1)
    expect(s.pos).toBe(2)
    expect(s.vel).toBe(0)
    const back = momentumStep(-1.9, -4, 2, 0.1)
    expect(back.pos).toBe(-2)
    expect(back.vel).toBe(0)
  })
})

describe('clampZoom', () => {
  it('keeps values inside the limits', () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(ZOOM_MIN)).toBe(ZOOM_MIN)
    expect(clampZoom(ZOOM_MAX)).toBe(ZOOM_MAX)
    expect(clampZoom(0)).toBe(ZOOM_MIN)
    expect(clampZoom(100)).toBe(ZOOM_MAX)
  })
})

describe('pinchZoom', () => {
  it('scales the start zoom by the span ratio', () => {
    expect(pinchZoom(1, 100, 200)).toBeCloseTo(2)
    expect(pinchZoom(1, 200, 100)).toBeCloseTo(0.55)
    expect(pinchZoom(2, 100, 100)).toBeCloseTo(2)
  })

  it('clamps at the zoom limits', () => {
    expect(pinchZoom(1, 100, 1000)).toBe(ZOOM_MAX)
    expect(pinchZoom(ZOOM_MIN, 200, 10)).toBe(ZOOM_MIN)
  })

  it('treats a degenerate start span as 1px', () => {
    expect(pinchZoom(2, 0, 0)).toBe(ZOOM_MIN)
    expect(pinchZoom(0.8, 0, 5)).toBe(ZOOM_MAX)
  })
})

describe('panLimit', () => {
  it('is zero at fit zoom so the view recenters', () => {
    expect(panLimit(1)).toBe(0)
    expect(panLimit(0.55)).toBe(0)
  })

  it('grows toward PAN_LIMIT as zoom increases', () => {
    expect(panLimit(2)).toBeCloseTo(PAN_LIMIT / 2)
    expect(panLimit(4)).toBeCloseTo(PAN_LIMIT * 0.75)
    expect(panLimit(100)).toBeCloseTo(PAN_LIMIT, 1)
  })
})

describe('clampPan', () => {
  it('keeps offsets inside the zoom-dependent limit', () => {
    expect(clampPan(0.2, 0.1, 2)).toEqual([0.2, 0.1])
    // lim at zoom 2 is PAN_LIMIT/2; a longer vector rescales onto the cap.
    const [x, y] = clampPan(10, 0, 2)
    expect(x).toBeCloseTo(PAN_LIMIT / 2)
    expect(y).toBe(0)
  })

  it('forces zero pan at fit zoom', () => {
    expect(clampPan(5, 5, 1)).toEqual([0, 0])
    expect(clampPan(0, 0, 1)).toEqual([0, 0])
  })
})
