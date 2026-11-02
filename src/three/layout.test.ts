import { describe, it, expect } from 'vitest'
import {
  fanPose, fanPoseFocus, fanHoverPose, fanHoverFocus, rowPoseFocus, rowHoverFocus,
  PAGE_STEP, canTurn, curlPoint, stackHeight, PAGE_W, PAGE_H, SPREAD_TILT, bookFoldPose,
  COVER_W, COVER_H, spreadPageIndices, lastSpreadIndex, spreadCount,
  spreadCameraDistance, GROUND_Y, FAN_LEAN, SPREAD_LEAN, fanDrop, fanRestY, spreadRestY,
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

describe('fanPose', () => {
  it('centers the middle page at x = 0 and fans symmetrically', () => {
    const n = 5
    expect(fanPose(2, n).x).toBe(0)
    expect(fanPose(0, n).x).toBeLessThan(0)
    expect(fanPose(4, n).x).toBeGreaterThan(0)
    expect(Math.abs(fanPose(0, n).x)).toBeCloseTo(Math.abs(fanPose(4, n).x))
  })

  it('clamps the fan spread like the DOM version (|off| <= 4)', () => {
    const wide = fanPose(0, 30)
    expect(wide.x).toBeCloseTo(-4 * PAGE_W * 0.52)
  })

  it('later pages stack closer to the camera', () => {
    const n = 5
    // mirrored pair: the later index of the two sits in front
    expect(fanPose(3, n).z).toBeGreaterThan(fanPose(1, n).z)
  })

  it('never interpenetrates any pair of sheets at any journal size', () => {
    // Regression: the centre pair of an even-count fan used to clip — the
    // per-index z step was smaller than the inner edges' yaw dip.
    for (let n = 2; n <= 30; n++) {
      const boxes = Array.from({ length: n }, (_, i) => pageBox(fanPose(i, n)))
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++)
          expect(boxesIntersect(boxes[i], boxes[j])).toBe(false)
    }
  })
})

describe('tabletop rest heights', () => {
  it('puts the fan wing corners exactly on the table', () => {
    for (const n of [1, 3, 8, 20]) {
      expect(fanRestY(n) + fanDrop(n)).toBeCloseTo(GROUND_Y)
    }
  })

  it('an empty fan rests at table height', () => {
    expect(fanDrop(0)).toBe(0)
    expect(fanRestY(0)).toBe(GROUND_Y)
  })

  it('widens the fan -> deeper drop -> higher group origin', () => {
    expect(fanRestY(10)).toBeGreaterThan(fanRestY(2))
  })

  it('leans the fan back and lays the open book near-flat', () => {
    expect(FAN_LEAN).toBeLessThan(0)
    expect(FAN_LEAN).toBeGreaterThan(-Math.PI / 4)
    expect(SPREAD_LEAN).toBeLessThan(-Math.PI / 4)
    expect(SPREAD_LEAN).toBeGreaterThan(-Math.PI / 2)
  })

  it('rests the open book on the table, below the fan origin', () => {
    expect(spreadRestY()).toBeLessThan(0)
    expect(spreadRestY()).toBeGreaterThan(GROUND_Y)
    // the lowest leaned corner must end up at table height
    const low = -PAGE_H / 2 * Math.cos(SPREAD_LEAN) + 0.0625 * Math.sin(SPREAD_LEAN)
    expect(spreadRestY() + low).toBeCloseTo(GROUND_Y)
  })
})

describe('bookFoldPose', () => {
  it('keeps both cover boards within the page block dimensions', () => {
    expect(COVER_W).toBe(PAGE_W)
    expect(COVER_H).toBe(PAGE_H)
  })

  it('keeps the cover behind the spread when open and folds it over the pages when closed', () => {
    expect(bookFoldPose(0)).toEqual({
      coverY: 0,
      centerX: 0,
      coverZ: 0,
    })
    const closed = bookFoldPose(1)
    expect(closed.coverY).toBeCloseTo(Math.PI)
    expect(closed.centerX).toBeCloseTo(-PAGE_W / 2)
    expect(closed.coverZ).toBeCloseTo(0.05)
  })

  it('clamps animation progress to the open and closed endpoints', () => {
    expect(bookFoldPose(-1)).toEqual(bookFoldPose(0))
    expect(bookFoldPose(2)).toEqual(bookFoldPose(1))
  })
})

describe('spreadCameraDistance', () => {
  it('zooms out on portrait viewports enough to keep the whole spread in frame', () => {
    const aspect = 0.5
    const distance = spreadCameraDistance(aspect)
    const visibleHalfWidth = distance * Math.tan(Math.PI / 10) * aspect
    expect(distance).toBeGreaterThan(4.4)
    expect(visibleHalfWidth).toBeCloseTo(PAGE_W / 0.86, 10)
  })

  it('keeps the normal camera distance on wide viewports', () => {
    expect(spreadCameraDistance(1.5)).toBe(4.4)
  })
})

describe('fanPoseFocus', () => {
  it('matches fanPose when focused on the row centre', () => {
    const n = 7
    const focus = (n - 1) / 2
    for (let i = 0; i < n; i++) {
      expect(fanPoseFocus(i, focus)).toEqual(fanPose(i, n))
    }
  })

  it('slides the whole fan so the focused page sits at x = 0', () => {
    for (const focus of [0, 2, 9]) {
      expect(fanPoseFocus(focus, focus).x).toBeCloseTo(0)
    }
    // off-centre focus shifts every sheet the same way
    expect(fanPoseFocus(3, 5).x).toBeLessThan(fanPoseFocus(3, 1).x)
  })

  it('moves all sheets by the focus delta (fractional scroll)', () => {
    const step = PAGE_W * 0.52
    // indices where neither focus hits the ±4 fan clamp
    for (let i = 2; i <= 5; i++) {
      expect(fanPoseFocus(i, 1.5).x - fanPoseFocus(i, 1).x).toBeCloseTo(-0.5 * step)
    }
  })
})

describe('fanHoverFocus', () => {
  it('matches fanHoverPose at the row centre', () => {
    const n = 6
    for (let i = 0; i < n; i++) {
      expect(fanHoverFocus(i, (n - 1) / 2, n)).toEqual(fanHoverPose(i, n))
    }
  })

  it('still lifts the hovered sheet clear at a scrolled focus', () => {
    const n = 8
    for (const focus of [0, 3, 7]) {
      for (let h = Math.max(0, Math.floor(focus) - 1); h <= Math.min(n - 1, Math.ceil(focus) + 1); h++) {
        const boxes = Array.from({ length: n }, (_, i) =>
          pageBox(i === h ? fanHoverFocus(i, focus, n) : fanPoseFocus(i, focus)),
        )
        for (let j = 0; j < n; j++)
          if (j !== h) expect(boxesIntersect(boxes[h], boxes[j])).toBe(false)
      }
    }
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

describe('canTurn', () => {
  it('allows the terminal turn that reveals the back cover', () => {
    expect(canTurn(1, 0, 5)).toBe(true)
    expect(canTurn(1, 2, 5)).toBe(true)
    expect(canTurn(1, 2, 4)).toBe(true)
    expect(canTurn(1, 4, 4)).toBe(false)
    expect(canTurn(1, 0, 1)).toBe(true)
    expect(canTurn(1, 2, 1)).toBe(false)
  })

  it('allows a backward turn only past the first spread', () => {
    expect(canTurn(-1, 0, 5)).toBe(false)
    expect(canTurn(-1, 2, 5)).toBe(true)
    expect(canTurn(-1, 4, 5)).toBe(true)
  })
})

describe('spreadPageIndices', () => {
  it('starts with the first page on the right and the front cover on the left', () => {
    expect(spreadPageIndices(0, 3)).toEqual({ left: null, right: 0 })
  })

  it('places the reverse of the turned leaf on the left', () => {
    expect(spreadPageIndices(2, 3)).toEqual({ left: 1, right: 2 })
    expect(spreadPageIndices(4, 4)).toEqual({ left: 3, right: null })
    expect(spreadPageIndices(4, 3)).toEqual({ left: 2, right: null })
  })

  it('counts the final cover reveal for both odd and even page totals', () => {
    expect(lastSpreadIndex(3)).toBe(4)
    expect(lastSpreadIndex(4)).toBe(4)
    expect(spreadCount(3)).toBe(3)
    expect(spreadCount(4)).toBe(3)
    expect(canTurn(1, 2, 3)).toBe(true)
    expect(canTurn(1, 4, 3)).toBe(false)
    expect(canTurn(-1, 4, 3)).toBe(true)
  })
})

describe('fanHoverPose', () => {
  it('lifts the hovered page toward the camera and straightens yaw', () => {
    const rest = fanPose(1, 5)
    const hov = fanHoverPose(1, 5)
    expect(hov.z).toBeGreaterThan(rest.z)
    expect(hov.y).toBeGreaterThan(rest.y)
    expect(Math.abs(hov.rotY)).toBeLessThan(Math.abs(rest.rotY))
  })

  it('lifts clear of every sheet it still overlaps', () => {
    for (let n = 2; n <= 12; n++) {
      for (let h = 0; h < n; h++) {
        const boxes = Array.from({ length: n }, (_, i) =>
          pageBox(i === h ? fanHoverPose(i, n) : fanPose(i, n)),
        )
        for (let j = 0; j < n; j++)
          if (j !== h) expect(boxesIntersect(boxes[h], boxes[j])).toBe(false)
      }
    }
  })
})

describe('curlPoint', () => {
  it('lies flat on the right at t=0 and flat on the left at t=1', () => {
    expect(curlPoint(PAGE_W, 0, PAGE_W, 0, 1)).toEqual([PAGE_W, 0, stackHeight(PAGE_W)])
    const [px, , pz] = curlPoint(PAGE_W, 0, PAGE_W, 1, 1)
    expect(px).toBeCloseTo(-PAGE_W)
    expect(pz).toBeCloseTo(stackHeight(PAGE_W))
  })

  it('mirrors for dir=-1: flat left at t=0, flat right at t=1', () => {
    const [px0] = curlPoint(PAGE_W, 0, PAGE_W, 0, -1)
    expect(px0).toBeCloseTo(-PAGE_W)
    const [px1, , pz1] = curlPoint(PAGE_W, 0, PAGE_W, 1, -1)
    expect(px1).toBeCloseTo(PAGE_W)
    expect(pz1).toBeCloseTo(stackHeight(PAGE_W))
  })

  it('lifts the sheet off the book mid-flip', () => {
    const [, , pz] = curlPoint(PAGE_W * 0.6, 0, PAGE_W, 0.5, 1)
    expect(pz).toBeGreaterThan(PAGE_W * 0.5)
  })

  it('keeps the spine pinned at the origin', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const [px, , pz] = curlPoint(0, 3, PAGE_W, t, 1)
      expect(px).toBeCloseTo(0)
      expect(pz).toBeCloseTo(0.006)
    }
  })

  it('never dips the tip through the opposite stack late in the turn', () => {
    for (const t of [0.8, 0.85, 0.9, 0.95]) {
      const [px, , pz] = curlPoint(PAGE_W, 0, PAGE_W, t, 1)
      expect(pz).toBeGreaterThanOrEqual(stackHeight(px) - 1e-9)
    }
    // mirrored direction, same guarantee
    for (const t of [0.8, 0.9]) {
      const [px, , pz] = curlPoint(PAGE_W, 0, PAGE_W, t, -1)
      expect(pz).toBeGreaterThanOrEqual(stackHeight(px) - 1e-9)
    }
  })

  it('keeps the sheet flat and rotates every point through the same angle', () => {
    const t = 0.35
    const a = curlPoint(PAGE_W * 0.3, 0, PAGE_W, t, 1)
    const b = curlPoint(PAGE_W, 0, PAGE_W, t, 1)
    expect(a[0] / (PAGE_W * 0.3)).toBeCloseTo(b[0] / PAGE_W)
    expect(a[2] / (PAGE_W * 0.3)).toBeCloseTo(b[2] / PAGE_W)
  })

  it('does not twist the sheet across its width', () => {
    const front = curlPoint(PAGE_W * 0.7, -PAGE_H / 2, PAGE_W, 0.4, 1)
    const back = curlPoint(PAGE_W * 0.7, PAGE_H / 2, PAGE_W, 0.4, 1)
    expect(front[0]).toBeCloseTo(back[0])
    expect(front[2]).toBeCloseTo(back[2])
  })
})
