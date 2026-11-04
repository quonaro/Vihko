// Pure 3D layout math for the shelf scene (journal row + pointer tilt).
// No three.js imports here so the math stays unit-testable under jsdom —
// same convention as layout.ts.

// Book size in world units. Aspect matches the DOM covers' .book-inner
// (width clamp, aspect-ratio: .735); height lands at ~45% of the visible
// stage at CAM_DIST — same share the DOM covers take.
export const BOOK_W = 1.08
export const BOOK_H = BOOK_W / 0.735
export const BOOK_D = 0.12 // total thickness incl. both boards
export const SHELF_STEP = BOOK_W + 0.2 // center-to-center spacing
export const EDGE_PAD = 0.3 // world-unit margin kept at row ends while panning

// Cover sandwich: two boards wrap the paper block, the bound edge stays
// open like a notepad. No two faces may share a plane — coincident surfaces
// z-fight on mediump mobile depth buffers.
export const BOARD_T = BOOK_D * 0.19 // one cover board's thickness
export const PAGES_D = BOOK_D * 0.6 // paper block, clear of the board inners

// Paper-block footprint. Corners carry the same share of rounding as the
// journal sheets (SHEET_CORNER_R in layout.ts) so the closed book's page
// block reads like the pages inside instead of a die-cut slab. The cover
// boards wrap it with the same share at book size — concentric-looking
// arcs instead of a sharp slab over rounded pages.
export const PAGES_W = BOOK_W * 0.955
export const PAGES_H = BOOK_H * 0.96
export const PAGES_CORNER_R = PAGES_H * 0.045
export const BOARD_CORNER_R = BOOK_H * 0.045

// Ordered 2D boundary loop of a centred rounded rect (x right, y up),
// clockwise like sheetOutline. Only the corner arcs are sampled — the
// connecting edges are single straight segments — so the scene can feed
// the loop straight into a THREE.Shape and extrude it.
function roundedRectLoop(w: number, h: number, r: number, cornerSteps: number): [number, number][] {
  const cx = w / 2 - r
  const cy = h / 2 - r
  const pts: [number, number][] = []
  const corners: [number, number, number, number][] = [
    [cx, cy, Math.PI / 2, 0],
    [cx, -cy, 0, -Math.PI / 2],
    [-cx, -cy, -Math.PI / 2, -Math.PI],
    [-cx, cy, Math.PI, Math.PI / 2],
  ]
  for (const [x, y, a0, a1] of corners) {
    for (let k = 0; k <= cornerSteps; k++) {
      const a = a0 + ((a1 - a0) * k) / cornerSteps
      pts.push([x + r * Math.cos(a), y + r * Math.sin(a)])
    }
  }
  return pts
}

export function pagesOutline(cornerSteps = 6): [number, number][] {
  return roundedRectLoop(PAGES_W, PAGES_H, PAGES_CORNER_R, cornerSteps)
}

export function boardOutline(cornerSteps = 6): [number, number][] {
  return roundedRectLoop(BOOK_W, BOOK_H, BOARD_CORNER_R, cornerSteps)
}

// Books lie flat on the table, cover up: the group pitches -90° about X
// (Euler order ZYX — rotY then spins in the table plane, rotZ dips an edge).
export const LIE_PITCH = -Math.PI / 2

export interface ShelfPose {
  x: number
  y: number
  z: number
  rotX: number
  rotY: number
  rotZ: number
  scale: number
}

// Rest pose on the table — a straight flat row with a gap, all covers up.
export function shelfPose(i: number, total: number): ShelfPose {
  const off = i - (total - 1) / 2
  return {
    x: off * SHELF_STEP,
    y: BOOK_D / 2,
    z: 0,
    rotX: LIE_PITCH,
    rotY: 0,
    rotZ: 0,
    scale: 1,
  }
}

export interface ShelfEntrance {
  lift: number
  scale: number
  opacity: number
}

export function shelfEntrance(t: number): ShelfEntrance {
  const progress = Math.max(0, Math.min(1, t))
  const eased = 1 - (1 - progress) ** 3
  return {
    lift: (1 - eased) * 0.12,
    scale: 0.985 + 0.015 * eased,
    opacity: eased,
  }
}

// Hover lift: the flat look keeps books untilted — a hovered book just
// rises a touch off the table.
export const TILT_LIFT = 0.07

// Hover hitbox: the pick region is a bit larger than the cover itself so
// the tilt starts before the pointer actually reaches the book's edge.
export const HIT_MARGIN = 1.14
export function inHitBox(px: number, py: number): boolean {
  return Math.abs(px) <= (BOOK_W / 2) * HIT_MARGIN && Math.abs(py) <= (BOOK_H / 2) * HIT_MARGIN
}

// Half of the world width visible at z = 0 for a camera `dist` away.
export function viewHalfWidth(fovDeg: number, dist: number, aspect: number): number {
  return Math.tan((fovDeg * Math.PI) / 360) * dist * aspect
}

// Max |pan offset| of the row. 0 means every book fits and the row stays
// centered; when the row is wider than the viewport the offset lets each
// end book reach the padded screen edge.
export function scrollLimit(halfW: number, total: number): number {
  if (total <= 0) return 0
  const center = ((total - 1) * SHELF_STEP) / 2
  return Math.max(0, center + BOOK_W / 2 + EDGE_PAD - halfW)
}
