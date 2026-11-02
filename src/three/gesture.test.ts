import { describe, it, expect } from 'vitest'
import {
  RUBBER_BAND, FLICK_WINDOW_MS, MOMENTUM_DECAY,
  rubberScroll, flickVelocity, momentumStep, closesBookOnTurn, commitsBookCloseSwipe,
} from './gesture'

describe('closesBookOnTurn', () => {
  it('closes on a previous-turn drag at the first spread', () => {
    expect(closesBookOnTurn(-1, 0, 6)).toBe(true)
    expect(closesBookOnTurn(-1, 2, 6)).toBe(false)
  })

  it('closes on a next-turn drag at the last spread', () => {
    expect(closesBookOnTurn(1, 4, 6)).toBe(false)
    expect(closesBookOnTurn(1, 6, 6)).toBe(true)
    expect(closesBookOnTurn(1, 2, 4)).toBe(false)
    expect(closesBookOnTurn(1, 4, 4)).toBe(true)
    expect(closesBookOnTurn(1, 0, 6)).toBe(false)
  })
})

describe('commitsBookCloseSwipe', () => {
  it('accepts a deliberate drag or directional flick toward the cover', () => {
    expect(commitsBookCloseSwipe(1, -100, -100, 400)).toBe(true)
    expect(commitsBookCloseSwipe(-1, 20, 500, 400)).toBe(true)
  })

  it('rejects short and opposite-direction movement', () => {
    expect(commitsBookCloseSwipe(1, -40, -200, 400)).toBe(false)
    expect(commitsBookCloseSwipe(1, 100, 600, 400)).toBe(false)
  })
})

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
