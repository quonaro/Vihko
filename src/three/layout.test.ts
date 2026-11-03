import { describe, it, expect } from 'vitest'
import {
  rowPoseFocus, PAGE_STEP, canTurnStack, PAGE_W, PAGE_H,
  pileLean, leafDepth, leafRestAngle, leafRestZ, leafRestFan, leafRestSink,
  leafPointTheta, leafOutlineTheta, leafTexU,
  LEAF_LEAN, LEAF_ZSTEP, LEAF_FAN_STEP, LEAF_SINK_STEP, LEAF_FAN_CAP,
  sheetCameraDistance, GROUND_Y, STACK_LEAN, ROW_LEAN, rowRestY, stackRestY,
  sheetPoint, HALF_W, SHEET_CORNER_R,
  sheetOutline, sheetOutline3D, packOutline,
} from './layout'

type V = [number, number, number]

describe('tabletop rest heights', () => {
  it('puts the overview bottom edge on the table', () => {
    expect(rowRestY() - PAGE_H / 2 * Math.cos(ROW_LEAN)).toBeCloseTo(GROUND_Y)
  })

  it('rests the fanned block on the shadow catcher, spread just above it', () => {
    // Deepest leaf's lowest corner lands ≈ on the ground plane.
    const c = Math.cos(STACK_LEAN)
    const s = Math.sin(STACK_LEAN)
    let low = 0
    for (let j = 0; j <= LEAF_FAN_CAP + 2; j++) {
      const fan = Math.min(j, LEAF_FAN_CAP) * LEAF_FAN_STEP
      const sink = Math.min(j, LEAF_FAN_CAP) * LEAF_SINK_STEP
      for (const x of [0, HALF_W]) {
        for (const y of [-PAGE_H / 2, PAGE_H / 2]) {
          const [, py, pz] = leafPointTheta(x, y, HALF_W, pileLean(j), 0, fan, sink)
          low = Math.min(low, py * c - (pz - j * LEAF_ZSTEP) * s)
        }
      }
    }
    expect(stackRestY() + low).toBeCloseTo(GROUND_Y + 0.02, 4)
    // The open spread's spine bottom stays above the table.
    expect(stackRestY() - (PAGE_H / 2) * Math.cos(STACK_LEAN)).toBeGreaterThan(GROUND_Y)
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

describe('leaf piles', () => {
  it('lifts the pile-top leaf most and settles deeper leaves flatter', () => {
    expect(pileLean(0)).toBeCloseTo(LEAF_LEAN)
    expect(pileLean(1)).toBeLessThan(pileLean(0))
    expect(pileLean(3)).toBeLessThan(pileLean(1))
    expect(pileLean(3)).toBeGreaterThan(0)
    expect(pileLean(-2)).toBe(LEAF_LEAN)
    // Deeper leaves descend: they can never poke above the leaf on top.
    for (let j = 0; j < 8; j++) expect(pileLean(j + 1)).toBeLessThan(pileLean(j))
  })

  it('rests leaves left of the boundary on the left pile, others right', () => {
    // cur = 2: leaves 0..2 on the left pile (θ≈π), 3.. on the right (θ≈0).
    for (const k of [0, 1, 2]) {
      expect(leafRestAngle(k, 2)).toBeGreaterThan(Math.PI / 2)
      expect(leafRestAngle(k, 2)).toBeLessThanOrEqual(Math.PI)
    }
    for (const k of [3, 4, 8]) {
      expect(leafRestAngle(k, 2)).toBeGreaterThanOrEqual(0)
      expect(leafRestAngle(k, 2)).toBeLessThan(Math.PI / 2)
    }
    // The boundary pair is the most tilted of its pile.
    expect(leafRestAngle(2, 2)).toBeLessThan(leafRestAngle(1, 2))
    expect(leafRestAngle(3, 2)).toBeGreaterThan(leafRestAngle(4, 2))
  })

  it('counts pile depth symmetrically from the open spread', () => {
    expect(leafDepth(2, 2)).toBe(0)
    expect(leafDepth(3, 2)).toBe(0)
    expect(leafDepth(1, 2)).toBe(1)
    expect(leafDepth(4, 2)).toBe(1)
    expect(leafDepth(0, 2)).toBe(2)
    expect(leafDepth(6, 2)).toBe(3)
    // Fractional focus interpolates depths — the piles ease, never snap.
    expect(leafDepth(2, 2.5)).toBeCloseTo(0.5)
    expect(leafDepth(4, 2.5)).toBeCloseTo(0.5)
  })

  it('stacks deeper leaves below the pile top', () => {
    expect(leafRestZ(2, 2)).toBeCloseTo(0)
    expect(leafRestZ(3, 2)).toBeCloseTo(0)
    expect(leafRestZ(1, 2)).toBeCloseTo(-LEAF_ZSTEP)
    expect(leafRestZ(4, 2)).toBeCloseTo(-LEAF_ZSTEP)
    expect(leafRestZ(0, 2)).toBeLessThan(leafRestZ(1, 2))
  })

  it('fans free edges outward and sinks them in capped steps', () => {
    // Boundary leaves are the open spread — no fan, no sink.
    expect(leafRestFan(2, 2)).toBe(0)
    expect(leafRestFan(3, 2)).toBe(0)
    expect(leafRestSink(2, 2)).toBe(0)
    expect(leafRestSink(3, 2)).toBe(0)
    // Both piles fan the same way — the block stays symmetric.
    expect(leafRestFan(1, 2)).toBeCloseTo(LEAF_FAN_STEP)
    expect(leafRestFan(4, 2)).toBeCloseTo(LEAF_FAN_STEP)
    expect(leafRestFan(0, 2)).toBeCloseTo(2 * LEAF_FAN_STEP)
    expect(leafRestSink(0, 2)).toBeCloseTo(2 * LEAF_SINK_STEP)
    for (let j = 1; j < LEAF_FAN_CAP; j++) {
      expect(leafRestFan(3 + j + 1, 2)).toBeGreaterThan(leafRestFan(3 + j, 2))
      expect(leafRestSink(3 + j + 1, 2)).toBeGreaterThan(leafRestSink(3 + j, 2))
    }
    // Flat past the cap — the skirt can't grow forever.
    expect(leafRestFan(3 + LEAF_FAN_CAP + 5, 2)).toBeCloseTo(LEAF_FAN_CAP * LEAF_FAN_STEP)
    expect(leafRestSink(3 + LEAF_FAN_CAP + 5, 2)).toBeCloseTo(LEAF_FAN_CAP * LEAF_SINK_STEP)
  })

  it('keeps the hinge glued to the spine under fan and sink', () => {
    // The tear bug: a whole-leaf offset would drag the hinge edge off the
    // fold. Fan/sink taper to zero at x = 0, so the seam never opens.
    for (const theta of [0, 0.14, Math.PI - 0.14, Math.PI]) {
      const [px, py, pz] = leafPointTheta(0, PAGE_H / 2, HALF_W, theta, 0.4, 0.4, 0.2)
      expect(px).toBeCloseTo(0, 9)
      expect(py).toBeCloseTo(PAGE_H / 2, 9)
      expect(pz).toBeCloseTo(0, 9)
    }
  })

  it('extends only the free edge: midpoint moves half the fan', () => {
    const fan = 0.3
    const [edge] = leafPointTheta(HALF_W, 0, HALF_W, 0, 0, fan)
    const [mid] = leafPointTheta(HALF_W / 2, 0, HALF_W, 0, 0, fan)
    expect(edge).toBeCloseTo(HALF_W + fan, 6)
    expect(mid).toBeCloseTo(HALF_W / 2 + fan / 2, 6)
  })

  it('drops the free edge by sink, mirrored on both piles', () => {
    const sink = 0.2
    const [, ry] = leafPointTheta(HALF_W, 0, HALF_W, 0, 0, 0, sink)
    expect(ry).toBeCloseTo(-sink, 6)
    const [, ly] = leafPointTheta(HALF_W, 0, HALF_W, Math.PI, 0, 0, sink)
    expect(ly).toBeCloseTo(-sink, 6)
  })

  it('leafPointTheta: flat right at θ=0, flat left at θ=π, spine pinned', () => {
    const w = HALF_W
    const [r0, , z0] = leafPointTheta(w, 0, w, 0)
    expect(r0).toBeCloseTo(w)
    expect(z0).toBeCloseTo(sheetPoint(w, 0)[2])
    const [r1] = leafPointTheta(w, 0, w, Math.PI)
    expect(r1).toBeCloseTo(-w)
  })

  it('bends the leaf mid-turn and restores its folded endpoints', () => {
    const t0 = leafPointTheta(HALF_W, 0, HALF_W, Math.PI * 0.35, 0.4)
    const f0 = leafPointTheta(HALF_W, 0, HALF_W, Math.PI * 0.35, 0)
    expect(t0[0]).not.toBeCloseTo(f0[0])
    expect(leafPointTheta(HALF_W, 0, HALF_W, Math.PI, 0.4)).toEqual(
      leafPointTheta(HALF_W, 0, HALF_W, Math.PI, 0),
    )
  })

  it('leafTexU maps faces to opposite texture halves', () => {
    expect(leafTexU('front', 0)).toBe(0.5)
    expect(leafTexU('front', 1)).toBe(1)
    expect(leafTexU('back', 0)).toBe(0.5)
    expect(leafTexU('back', 1)).toBe(0)
  })
})

describe('sheet outline', () => {
  const signedArea = (pts: [number, number][]) =>
    pts.reduce((s, [x, y], i) => {
      const [nx, ny] = pts[(i + 1) % pts.length]
      return s + x * ny - nx * y
    }, 0) / 2

  const onBoundary = (x: number, y: number) => {
    const w = PAGE_W / 2
    const h = PAGE_H / 2
    const r = SHEET_CORNER_R
    const cx = w - r
    const cy = h - r
    // Inside the corner square: must sit on the rounding circle.
    if (Math.abs(x) > cx && Math.abs(y) > cy) {
      const d = Math.hypot(Math.abs(x) - cx, Math.abs(y) - cy)
      return Math.abs(d - r) < 1e-6
    }
    return Math.abs(x) <= w + 1e-6 && Math.abs(y) <= h + 1e-6
  }

  it('traces a closed clockwise loop exactly on the rounded boundary', () => {
    const pts = sheetOutline()
    expect(signedArea(pts)).toBeLessThan(0)
    expect(Math.abs(signedArea(pts))).toBeGreaterThan(PAGE_W * PAGE_H * 0.9)
    for (const [x, y] of pts) {
      expect(onBoundary(x, y)).toBe(true)
      // Every point lies on the folded surface — sheetPoint doesn't move it.
      const [sx, sy] = sheetPoint(x, y)
      expect(Math.abs(sx - x)).toBeLessThan(1e-9)
      expect(Math.abs(sy - y)).toBeLessThan(1e-9)
    }
  })

  it('half outlines stay clockwise and open at the hinge when requested', () => {
    for (const side of ['left', 'right'] as const) {
      const closed = sheetOutline({ side })
      const open = sheetOutline({ side, hinge: false })
      expect(signedArea(closed)).toBeLessThan(0)
      // Open path endpoints are the two fold corners.
      const h = PAGE_H / 2
      expect(open[0]).toEqual([0, side === 'left' ? -h : h])
      expect(open[open.length - 1]).toEqual([0, side === 'left' ? h : -h])
      for (const [x, y] of closed) {
        if (side === 'left') expect(x).toBeLessThanOrEqual(1e-9)
        else expect(x).toBeGreaterThanOrEqual(-1e-9)
      }
    }
  })

  it('leaf outline rides the same deformation as the mesh', () => {
    const pts = leafOutlineTheta(0.4, 0.4, 0.3, 0.1)
    expect(pts.length).toBeGreaterThan(10)
    // Outline points stay glued to the spine at the hinge corners.
    const hingePts = pts.filter(([x, y]) => Math.abs(y) > PAGE_H * 0.49 && Math.abs(x) < 0.05)
    expect(hingePts.length).toBeGreaterThan(0)
  })

  it('packs a closed strip and can leave an open path', () => {
    const pts = sheetOutline3D({ edgeSteps: 4, cornerSteps: 3 })
    const packed = packOutline(pts)
    expect(packed.length).toBe((pts.length + 1) * 3)
    expect(packed[0]).toBe(packed[packed.length - 3])
    const open = packOutline(pts, false)
    expect(open.length).toBe(pts.length * 3)
  })
})
