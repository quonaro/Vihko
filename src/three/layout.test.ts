import { describe, it, expect } from 'vitest'
import {
  rowPoseFocus, rowHoverFocus, PAGE_STEP, canTurnStack, curlPoint, PAGE_W, PAGE_H,
  sheetCameraDistance, GROUND_Y, STACK_LEAN, ROW_LEAN, rowRestY, stackRestY,
  stackPose, stackHoverPose, sheetPoint,
} from './layout'
import type { Pose } from './layout'

type V = [number, number, number]
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

// The scene renders each page as a BoxGeometry(PAGE_W, PAGE_H, 0.008) with
// Euler order XYZ and rotX = 0, i.e. R = Ry(rotY)·Rz(rotZ). Rebuild that OBB
// here so "sheets must not interpenetrate" is directly testable.
function pageBox(p: Pose) {
  const cy = Math.cos(p.rotY), sy = Math.sin(p.rotY)
  const cz = Math.cos(p.rotZ), sz = Math.sin(p.rotZ)
  return {
    c: [p.x, p.y, p.z] as V,
    u: [
      [cy * cz, sz, -sy * cz],
      [-cy * sz, cz, sy * sz],
      [sy, 0, cy],
    ] as V[],
    e: [PAGE_W / 2, PAGE_H / 2, 0.004] as V,
  }
}

// Separating Axis Test for two oriented boxes.
function boxesIntersect(
  a: ReturnType<typeof pageBox>,
  b: ReturnType<typeof pageBox>,
) {
  const axes = [...a.u, ...b.u]
  for (const u of a.u) for (const v of b.u) axes.push(cross(u, v))
  const dc = sub(b.c, a.c)
  for (const ax0 of axes) {
    if (dot(ax0, ax0) < 1e-10) continue
    const n = 1 / Math.hypot(ax0[0], ax0[1], ax0[2])
    const ax: V = [ax0[0] * n, ax0[1] * n, ax0[2] * n]
    const proj = (b: ReturnType<typeof pageBox>) =>
      b.e[0] * Math.abs(dot(ax, b.u[0])) +
      b.e[1] * Math.abs(dot(ax, b.u[1])) +
      b.e[2] * Math.abs(dot(ax, b.u[2]))
    if (Math.abs(dot(ax, dc)) > proj(a) + proj(b)) return false
  }
  return true
}

describe('stackPose', () => {
  it('centers the active spread and keeps both neighbours face-up behind it', () => {
    expect(stackPose(0).x).toBe(0)
    expect(stackPose(-1).x).toBeLessThan(0)
    expect(stackPose(1).x).toBeGreaterThan(0)
    expect(stackPose(-1).z).toBeLessThan(stackPose(0).z)
    expect(stackPose(1).z).toBeLessThan(stackPose(0).z)
    expect(Math.abs(stackPose(-1).rotY)).toBeLessThan(0.1)
  })

  it('bounds the fan width even for large journals', () => {
    expect(stackPose(100).x).toBe(stackPose(7).x)
    expect(Math.abs(stackPose(-100).x)).toBeLessThan(PAGE_W)
  })

  it('recedes monotonically so distant sheets cannot cover the front', () => {
    for (let d = 1; d < 30; d++) {
      expect(stackPose(d).z).toBeLessThan(stackPose(d - 1).z)
      expect(stackPose(-d).z).toBeLessThan(stackPose(1 - d).z)
    }
  })

  it('keeps neighbouring sheet envelopes separated', () => {
    for (let d = 0; d < 7; d++) {
      expect(boxesIntersect(pageBox(stackPose(d)), pageBox(stackPose(d + 1)))).toBe(false)
    }
  })
})

describe('tabletop rest heights', () => {
  it('puts the overview bottom edge on the table', () => {
    expect(rowRestY() - PAGE_H / 2 * Math.cos(ROW_LEAN)).toBeCloseTo(GROUND_Y)
  })

  it('keeps the spread bottom above the shadow catcher', () => {
    expect(stackRestY() - PAGE_H / 2).toBeGreaterThan(GROUND_Y)
  })

  it('faces the spread toward the viewer rather than laying a book flat', () => {
    expect(STACK_LEAN).toBeLessThan(0)
    expect(STACK_LEAN).toBeGreaterThan(-Math.PI / 4)
  })
})

describe('sheetCameraDistance', () => {
  it('keeps the full spread and some of its neighbours in portrait viewports', () => {
    const aspect = 0.5
    const distance = sheetCameraDistance(aspect)
    const visibleHalfWidth = distance * Math.tan(Math.PI / 10) * aspect
    expect(distance).toBeGreaterThan(4.4)
    expect(visibleHalfWidth).toBeCloseTo(PAGE_W * 0.72, 10)
  })

  it('keeps the normal camera distance on wide viewports', () => {
    expect(sheetCameraDistance(1.5)).toBe(4.4)
  })
})

describe('horizontal page row', () => {
  it('spaces upright pages evenly and shifts them linearly with focus', () => {
    const focus = 2.5
    const pages = Array.from({ length: 5 }, (_, i) => rowPoseFocus(i, focus))
    expect(pages[1].x - pages[0].x).toBeCloseTo(PAGE_STEP)
    expect(pages[4].x - pages[1].x).toBeCloseTo(3 * PAGE_STEP)
    for (const page of pages) {
      expect(page.y).toBe(0)
      expect(page.z).toBe(0)
      expect(page.rotY).toBe(0)
      expect(page.rotZ).toBe(0)
    }
  })

  it('lifts a hovered page without changing its place in the row', () => {
    const rest = rowPoseFocus(3, 1.5)
    const hovered = rowHoverFocus(3, 1.5)
    expect(hovered.x).toBe(rest.x)
    expect(hovered.y).toBeGreaterThan(rest.y)
    expect(hovered.z).toBeGreaterThan(rest.z)
  })
})

describe('canTurnStack', () => {
  it('turns one stored spread at a time without a terminal cover reveal', () => {
    expect(canTurnStack(1, 0, 5)).toBe(true)
    expect(canTurnStack(1, 3, 5)).toBe(true)
    expect(canTurnStack(1, 4, 5)).toBe(false)
    expect(canTurnStack(1, 0, 1)).toBe(false)
    expect(canTurnStack(-1, 0, 1)).toBe(false)
    expect(canTurnStack(1, 0, 0)).toBe(false)
  })

  it('allows a backward turn only after the first spread', () => {
    expect(canTurnStack(-1, 0, 5)).toBe(false)
    expect(canTurnStack(-1, 1, 5)).toBe(true)
    expect(canTurnStack(-1, 4, 5)).toBe(true)
  })
})

describe('folded sheet geometry', () => {
  it('is two portrait halves in one landscape surface', () => {
    expect(PAGE_W / PAGE_H).toBeCloseTo(600 / 380)
  })

  it('has a genuine central valley, not a painted stripe on a flat card', () => {
    expect(sheetPoint(0, 0)[2]).toBe(0)
    expect(sheetPoint(PAGE_W / 2, 0)[2]).toBeGreaterThan(0.2)
    expect(sheetPoint(-PAGE_W / 2, 0)[2]).toBeCloseTo(sheetPoint(PAGE_W / 2, 0)[2])
  })

  it('rounds the outer corners without moving the fold', () => {
    const [x, y] = sheetPoint(PAGE_W / 2, PAGE_H / 2)
    expect(x).toBeLessThan(PAGE_W / 2)
    expect(y).toBeLessThan(PAGE_H / 2)
    expect(sheetPoint(0, PAGE_H / 2)).toEqual([0, PAGE_H / 2, 0])
  })
})

describe('stackHoverPose', () => {
  it('gently lifts a hovered spread without changing its orientation', () => {
    const rest = stackPose(1)
    const hov = stackHoverPose(1)
    expect(hov.z).toBeGreaterThan(rest.z)
    expect(hov.y).toBeGreaterThan(rest.y)
    expect(hov.rotY).toBe(rest.rotY)
  })
})

describe('curlPoint', () => {
  it('lies flat on the right at t=0 and flat on the left at t=1', () => {
    const w = PAGE_W / 2
    expect(curlPoint(w, 0, w, 0, 1)).toEqual([w, 0, sheetPoint(w, 0)[2] + 0.005])
    const [px, , pz] = curlPoint(w, 0, w, 1, 1)
    expect(px).toBeCloseTo(-w)
    expect(pz).toBeCloseTo(sheetPoint(w, 0)[2] + 0.005)
  })

  it('mirrors for dir=-1: flat left at t=0, flat right at t=1', () => {
    const w = PAGE_W / 2
    const [px0] = curlPoint(w, 0, w, 0, -1)
    expect(px0).toBeCloseTo(-w)
    const [px1] = curlPoint(w, 0, w, 1, -1)
    expect(px1).toBeCloseTo(w)
  })

  it('lifts the sheet off the book mid-flip', () => {
    const [, , pz] = curlPoint(PAGE_W * 0.4, 0, PAGE_W / 2, 0.5, 1)
    expect(pz).toBeGreaterThan(PAGE_W * 0.35)
  })

  it('keeps the spine pinned at the origin', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const [px, , pz] = curlPoint(0, 3, PAGE_W, t, 1)
      expect(px).toBeCloseTo(0)
      expect(pz).toBeCloseTo(0.005)
    }
  })

  it('never dips the tip through the opposite stack late in the turn', () => {
    for (const t of [0.8, 0.85, 0.9, 0.95]) {
      const [px, , pz] = curlPoint(PAGE_W / 2, 0, PAGE_W / 2, t, 1)
      expect(pz).toBeGreaterThanOrEqual(sheetPoint(px, 0)[2])
    }
    // mirrored direction, same guarantee
    for (const t of [0.8, 0.9]) {
      const [px, , pz] = curlPoint(PAGE_W / 2, 0, PAGE_W / 2, t, -1)
      expect(pz).toBeGreaterThanOrEqual(sheetPoint(px, 0)[2])
    }
  })

  it('bends the leaf during a turn and restores its folded endpoint', () => {
    const t = 0.35
    const w = PAGE_W / 2
    const a = curlPoint(w, 0, w, t, 1, 0.4)
    const b = curlPoint(w, 0, w, t, 1, 0)
    expect(a[0]).not.toBeCloseTo(b[0])
    expect(curlPoint(w, 0, w, 1, 1, 0.4)).toEqual(curlPoint(w, 0, w, 1, 1, 0))
  })

  it('does not twist the sheet across its width', () => {
    const front = curlPoint(PAGE_W * 0.7, -PAGE_H / 2, PAGE_W, 0.4, 1)
    const back = curlPoint(PAGE_W * 0.7, PAGE_H / 2, PAGE_W, 0.4, 1)
    expect(front[0]).toBeCloseTo(back[0])
    expect(front[2]).toBeCloseTo(back[2])
  })
})
