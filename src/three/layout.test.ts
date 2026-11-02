import { describe, it, expect } from 'vitest'
import {
  rowPoseFocus, rowHoverFocus, PAGE_STEP, canTurnStack, curlPoint, PAGE_W, PAGE_H,
  sheetCameraDistance, GROUND_Y, STACK_LEAN, ROW_LEAN, rowRestY, stackRestY,
  stackPose, stackHoverPose, sheetPoint, HALF_W, TURN_LIFT, SHEET_CORNER_R,
  sheetUV, sheetPointUV, halfPointUV, leafPointUV, leafTexU,
  turnLeafPose, turnEndpointHalf, restingHalf, lerpPose,
  sheetGrid, leafGrid, sheetOutline, sheetOutline3D, sheetOutlineCount,
  leafOutline3D, writeLeafOutline, packOutline, setOutlineResolution,
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

const near = (a: V, b: V, eps = 1e-6) => {
  for (let k = 0; k < 3; k++) expect(Math.abs(a[k] - b[k])).toBeLessThanOrEqual(eps)
}
const lift = (p: V): V => [p[0], p[1], p[2] + TURN_LIFT]

describe('resting↔turn endpoint correspondence', () => {
  // The leaf must coincide with the resting half it replaces at both ends
  // of the motion so the representation swap is invisible.
  const grid = [0, 0.13, 0.31, 0.5, 0.77, 1]

  it('dir=+1 starts on the right half and lands as the mirrored left half', () => {
    for (const curl of [0, 0.4]) {
      for (const u of grid) {
        for (const v of grid) {
          near(leafPointUV(u, v, 0, 1, curl), lift(halfPointUV('right', u, v)))
          near(leafPointUV(u, v, 1, 1, curl), lift(halfPointUV('left', 1 - u, v)))
        }
      }
    }
  })

  it('dir=-1 starts on the mirrored left half and lands on the right half', () => {
    for (const curl of [0, 0.4]) {
      for (const u of grid) {
        for (const v of grid) {
          near(leafPointUV(u, v, 0, -1, curl), lift(halfPointUV('left', 1 - u, v)))
          near(leafPointUV(u, v, 1, -1, curl), lift(halfPointUV('right', u, v)))
        }
      }
    }
  })

  it('pins the fold edge to its hinge for the whole turn', () => {
    for (const dir of [1, -1] as const) {
      for (const curl of [0, 0.4]) {
        for (const t of [0, 0.17, 0.5, 0.83, 1]) {
          for (const v of grid) {
            const [x, y, z] = leafPointUV(0, v, t, dir, curl)
            expect(x).toBeCloseTo(0, 9)
            expect(z).toBeCloseTo(TURN_LIFT, 9)
            expect(y).toBeCloseTo(halfPointUV('right', 0, v)[1], 9)
          }
        }
      }
    }
  })

  it('report the matching half and pose for each endpoint', () => {
    expect(turnEndpointHalf(0, 1)).toBe('right')
    expect(turnEndpointHalf(1, 1)).toBe('left')
    expect(turnEndpointHalf(0, -1)).toBe('left')
    expect(turnEndpointHalf(1, -1)).toBe('right')
    // The fold stays put: both endpoints share the front-slot pose.
    expect(turnLeafPose(0, 1)).toEqual(stackPose(0))
    expect(turnLeafPose(-1, -1)).toEqual(stackPose(0))
    expect(restingHalf(1, 'right').pose).toEqual(stackPose(1))
  })

  it('lerpPose interpolates every pose field', () => {
    const a = stackPose(0)
    const b = stackPose(2)
    const m = lerpPose(a, b, 0.5)
    expect(m.x).toBeCloseTo((a.x + b.x) / 2)
    expect(m.z).toBeCloseTo((a.z + b.z) / 2)
    expect(m.rotY).toBeCloseTo((a.rotY + b.rotY) / 2)
  })
})

describe('shared surface grids', () => {
  it('keeps continuous texture UVs across the fold on both halves', () => {
    const left = sheetGrid('left', 8, 4)
    const right = sheetGrid('right', 8, 4)
    const full = sheetGrid('full', 8, 4)
    const us = (g: typeof left) => Array.from(g.uvs.filter((_, i) => i % 2 === 0))
    expect(Math.min(...us(left))).toBeCloseTo(0)
    expect(Math.max(...us(left))).toBeCloseTo(0.5)
    expect(Math.min(...us(right))).toBeCloseTo(0.5)
    expect(Math.max(...us(right))).toBeCloseTo(1)
    expect(Math.min(...us(full))).toBeCloseTo(0)
    expect(Math.max(...us(full))).toBeCloseTo(1)
    // Same v orientation as the existing textures: v param 0 (top) → uv.y 1.
    const vs = (g: typeof left) => Array.from(g.uvs.filter((_, i) => i % 2 === 1))
    expect(Math.min(...vs(full))).toBeCloseTo(0)
    expect(Math.max(...vs(full))).toBeCloseTo(1)
  })

  it('half grid positions cover exactly their x ranges and lie on sheetPoint', () => {
    for (const side of ['left', 'right'] as const) {
      const g = sheetGrid(side, 8, 4)
      const xs = Array.from(g.positions.filter((_, i) => i % 3 === 0))
      if (side === 'left') {
        expect(Math.min(...xs)).toBeCloseTo(-HALF_W)
        expect(Math.max(...xs)).toBeCloseTo(0)
      } else {
        expect(Math.min(...xs)).toBeCloseTo(0)
        expect(Math.max(...xs)).toBeCloseTo(HALF_W)
      }
      for (let i = 0; i < g.positions.length; i += 3) {
        const [x, y, z] = [g.positions[i], g.positions[i + 1], g.positions[i + 2]]
        near([x, y, z], sheetPoint(x, y))
      }
    }
  })

  it('leaf grid is the flat leaf-space rest plane with raw-u UVs', () => {
    const g = leafGrid(8, 4)
    const xs = Array.from(g.positions.filter((_, i) => i % 3 === 0))
    const zs = Array.from(g.positions.filter((_, i) => i % 3 === 2))
    expect(Math.min(...xs)).toBe(0)
    expect(Math.max(...xs)).toBeCloseTo(HALF_W)
    expect(zs.every((z) => z === 0)).toBe(true)
    const us = Array.from(g.uvs.filter((_, i) => i % 2 === 0))
    expect(Math.min(...us)).toBe(0)
    expect(Math.max(...us)).toBe(1)
    expect(g.indices.length).toBe(8 * 4 * 6)
  })

  it('leafTexU maps faces to opposite texture halves', () => {
    expect(leafTexU('front', 0)).toBe(0.5)
    expect(leafTexU('front', 1)).toBe(1)
    expect(leafTexU('back', 0)).toBe(0.5)
    expect(leafTexU('back', 1)).toBe(0)
  })

  it('restingHalf exposes the continuous texture range', () => {
    expect(restingHalf(0, 'left').uRange).toEqual([0, 0.5])
    expect(restingHalf(0, 'right').uRange).toEqual([0.5, 1])
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
    expect(pts.length).toBe(sheetOutlineCount())
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
      expect(closed.length).toBe(sheetOutlineCount({ side }))
      expect(open.length).toBe(sheetOutlineCount({ side, hinge: false }))
      expect(open.length).toBe(closed.length - 8) // drops the e-step fold edge
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

  it('leaf outline endpoints coincide with the resting half outlines', () => {
    // The moving perimeter (reversed on the left, mirrored) is the same set
    // of boundary points as the resting half outline, lifted by TURN_LIFT.
    const key2 = (pts: [number, number][]) =>
      new Set(pts.map(([x, y]) => `${x.toFixed(5)},${y.toFixed(5)}`))
    // t=0 dir=+1: leaf outline (x∈[0,HALF_W]) = right half outline
    const leafFlat = leafOutline3D(0, 1, 0.4)
    expect(key2(leafFlat.map(([x, y]) => [x, y]))).toEqual(
      key2(sheetOutline({ side: 'right' })),
    )
    // t=1 dir=+1: leaf outline lands on x∈[-HALF_W,0] = left half outline
    const leafLanded = leafOutline3D(1, 1, 0.4)
    expect(key2(leafLanded.map(([x, y]) => [x, y]))).toEqual(
      key2(sheetOutline({ side: 'left' })),
    )
    // 3D z agrees with the resting folded surface modulo TURN_LIFT.
    for (const [x, y, z] of leafFlat) {
      expect(z - TURN_LIFT).toBeCloseTo(sheetPoint(x, y)[2], 4)
    }
  })

  it('packs a closed strip and rewrites the leaf ring in place', () => {
    const spec = { side: 'right' as const, edgeSteps: 4, cornerSteps: 3 }
    const pts = sheetOutline3D(spec)
    const packed = packOutline(pts)
    expect(packed.length).toBe((pts.length + 1) * 3)
    expect(packed[0]).toBe(packed[packed.length - 3])
    const open = packOutline(pts, false)
    expect(open.length).toBe(pts.length * 3)

    const ring = sheetOutlineCount({ side: 'right' })
    const buf = new Float32Array((ring + 1) * 3)
    const n = writeLeafOutline(0.5, 1, 0.4, buf)
    expect(n).toBe((ring + 1) * 3)
    expect(buf[0]).toBe(buf[n - 3]) // closed loop
    // Mid-turn the outline is genuinely 3D (deformed, not the flat rest).
    const zs = Array.from(buf.slice(0, n)).filter((_, i) => i % 3 === 2)
    expect(Math.max(...zs)).toBeGreaterThan(0.5)
  })

  it('updates fat-line material resolution through the duck-typed hook', () => {
    const calls: number[][] = []
    const mat = { resolution: { set: (x: number, y: number) => calls.push([x, y]) } }
    setOutlineResolution(mat, 320, 480)
    expect(calls).toEqual([[320, 480]])
  })
})
