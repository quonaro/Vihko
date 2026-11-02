import { describe, it, expect } from 'vitest'
import {
  BOOK_W, BOOK_H, SHELF_STEP, TILT_YAW, TILT_PITCH, HIT_MARGIN,
  shelfPose, hoverTilt, inHitBox, viewHalfWidth, scrollLimit,
} from './shelfLayout'

describe('shelfPose', () => {
  it('centers the row and spaces books evenly', () => {
    const n = 3
    expect(shelfPose(1, n).x).toBe(0)
    expect(shelfPose(2, n).x - shelfPose(1, n).x).toBeCloseTo(SHELF_STEP)
    expect(shelfPose(0, n).x).toBeCloseTo(-shelfPose(2, n).x)
  })

  it('keeps a small gap between neighboring books', () => {
    expect(SHELF_STEP - BOOK_W).toBeCloseTo(0.24)
  })

  it('keeps every book at the same height and size', () => {
    const n = 5
    const mid = shelfPose(2, n)
    const outer = shelfPose(0, n)
    expect(outer.y).toBe(mid.y)
    expect(outer.scale).toBe(mid.scale)
    expect(outer.z).toBe(mid.z)
    expect(mid.y).toBe(0)
    expect(mid.scale).toBe(1)
  })

  it('yaws the outer books inward symmetrically', () => {
    const n = 3
    expect(shelfPose(0, n).rotY).toBeCloseTo(-shelfPose(2, n).rotY)
    expect(shelfPose(1, n).rotY).toBe(0)
  })
})

describe('hoverTilt', () => {
  it('is flat at the cover center', () => {
    expect(hoverTilt(0, 0)).toEqual({ rotY: 0, rotX: 0 })
  })

  it('presses the cover edge under the pointer away from the viewer', () => {
    // Right edge under the pointer -> positive yaw pushes +x away (-z);
    // top edge -> negative pitch pushes +y away.
    expect(hoverTilt(1, 0).rotY).toBeCloseTo(TILT_YAW)
    expect(hoverTilt(-1, 0).rotY).toBeCloseTo(-TILT_YAW)
    expect(hoverTilt(0, 1).rotX).toBeCloseTo(-TILT_PITCH)
    expect(hoverTilt(0, -1).rotX).toBeCloseTo(TILT_PITCH)
  })

  it('clamps input outside the cover', () => {
    expect(hoverTilt(4, -4).rotY).toBeCloseTo(TILT_YAW)
    expect(hoverTilt(4, -4).rotX).toBeCloseTo(TILT_PITCH)
  })
})

describe('inHitBox', () => {
  it('contains the whole cover', () => {
    expect(inHitBox(BOOK_W / 2, BOOK_H / 2)).toBe(true)
    expect(inHitBox(-BOOK_W / 2, -BOOK_H / 2)).toBe(true)
  })

  it('extends past the cover edge by HIT_MARGIN', () => {
    expect(inHitBox((BOOK_W / 2) * (HIT_MARGIN + 0.01), 0)).toBe(false)
    expect(inHitBox((BOOK_W / 2) * (HIT_MARGIN - 0.01), 0)).toBe(true)
    expect(inHitBox(0, (BOOK_H / 2) * (HIT_MARGIN - 0.01))).toBe(true)
    expect(inHitBox(0, (BOOK_H / 2) * (HIT_MARGIN + 0.01))).toBe(false)
  })
})

describe('viewHalfWidth', () => {
  it('grows with distance and aspect', () => {
    const near = viewHalfWidth(36, 4, 1)
    const far = viewHalfWidth(36, 8, 1)
    const wide = viewHalfWidth(36, 4, 2)
    expect(far).toBeGreaterThan(near)
    expect(wide).toBeCloseTo(near * 2)
  })
})

describe('scrollLimit', () => {
  it('is 0 while every book fits the viewport', () => {
    expect(scrollLimit(10, 3)).toBe(0)
    expect(scrollLimit(2, 0)).toBe(0)
  })

  it('becomes positive once the row overflows', () => {
    const halfW = viewHalfWidth(36, 4.9, 1.6)
    expect(scrollLimit(halfW, 8)).toBeGreaterThan(0)
  })

  it('lets each end book reach the padded screen edge', () => {
    const halfW = 2
    const n = 6
    const limit = scrollLimit(halfW, n)
    // Panning fully left should put the first book's left edge at
    // -halfW + EDGE_PAD; fully right mirrors it for the last book.
    const first = shelfPose(0, n).x - BOOK_W / 2
    expect(first + limit).toBeGreaterThan(-halfW)
    expect(limit).toBeCloseTo(
      Math.max(0, ((n - 1) * SHELF_STEP) / 2 + BOOK_W / 2 + 0.3 - halfW),
    )
  })

  it('book height keeps the DOM cover aspect', () => {
    expect(BOOK_H / BOOK_W).toBeCloseTo(1 / 0.735)
  })
})
