import { describe, it, expect } from 'vitest'
import {
  BOOK_W,
  BOOK_H,
  BOOK_D,
  SHELF_STEP,
  TILT_LIFT,
  HIT_MARGIN,
  LIE_PITCH,
  BOARD_T,
  PAGES_D,
  SPINE_H,
  SPINE_D,
  SPINE_PROUD,
  shelfPose,
  inHitBox,
  viewHalfWidth,
  scrollLimit,
} from './shelfLayout'

describe('shelfPose', () => {
  it('centers the row and spaces books evenly', () => {
    const n = 3
    expect(shelfPose(1, n).x).toBe(0)
    expect(shelfPose(2, n).x - shelfPose(1, n).x).toBeCloseTo(SHELF_STEP)
    expect(shelfPose(0, n).x).toBeCloseTo(-shelfPose(2, n).x)
  })

  it('keeps a small gap between neighboring books', () => {
    expect(SHELF_STEP).toBeGreaterThan(BOOK_W)
    expect(SHELF_STEP - BOOK_W).toBeCloseTo(0.2)
  })

  it('lies every book flat on the table, cover up', () => {
    const n = 5
    for (let i = 0; i < n; i++) {
      const p = shelfPose(i, n)
      expect(p.rotX).toBeCloseTo(LIE_PITCH)
      expect(p.y).toBeCloseTo(BOOK_D / 2)
      expect(p.z).toBe(0)
      expect(p.rotY).toBe(0)
      expect(p.rotZ).toBe(0)
      expect(p.scale).toBe(1)
    }
  })

  it('pitches -90° so the cover normal points straight up', () => {
    expect(LIE_PITCH).toBeCloseTo(-Math.PI / 2)
  })
})

describe('hover lift', () => {
  it('is a small positive offset — flat books never tilt', () => {
    expect(TILT_LIFT).toBeGreaterThan(0)
    expect(TILT_LIFT).toBeLessThan(0.15)
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
    expect(limit).toBeCloseTo(Math.max(0, ((n - 1) * SHELF_STEP) / 2 + BOOK_W / 2 + 0.3 - halfW))
  })

  it('grows as pinch zoom shrinks the visible half width', () => {
    // ShelfScene passes halfW/zoom: zooming in must widen the scroll
    // range so end books can still be centered on screen.
    const halfW = 2
    const n = 12
    const fit = scrollLimit(halfW, n)
    const zoomed = scrollLimit(halfW / 3, n)
    expect(fit).toBeGreaterThan(0)
    expect(zoomed).toBeGreaterThan(fit)
    // At zoom 3 the last book's center can reach the screen center.
    const last = shelfPose(n - 1, n).x
    expect(zoomed).toBeGreaterThanOrEqual(last)
  })

  it('book height keeps the DOM cover aspect', () => {
    expect(BOOK_H / BOOK_W).toBeCloseTo(1 / 0.735)
  })
})

describe('cover sandwich', () => {
  // Every face must sit clear of its neighbours' planes — coincident
  // surfaces z-fight on mediump mobile depth buffers, which is what made
  // the spine strip flicker over the cover face on phones.
  it('floats the paper block inside the boards, touching neither', () => {
    const boardInner = BOOK_D / 2 - BOARD_T
    expect(PAGES_D / 2).toBeLessThan(boardInner)
  })

  it('recesses the spine inside the boards but over the paper block', () => {
    const boardInner = BOOK_D / 2 - BOARD_T
    expect(SPINE_D / 2).toBeLessThan(BOOK_D / 2)
    expect(SPINE_D / 2).toBeGreaterThan(boardInner)
    expect(SPINE_H).toBeLessThan(BOOK_H)
  })

  it('leaves only the bound edge slightly proud of the boards', () => {
    expect(SPINE_PROUD).toBeGreaterThan(0)
    expect(SPINE_PROUD).toBeLessThan(0.01)
  })
})
