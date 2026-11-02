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

// Cover sandwich: two boards wrap the paper block, a spine strip closes the
// bound edge. No two faces may share a plane — coincident surfaces z-fight
// on mediump mobile depth buffers (the spine visibly flickered over the
// cover face while the entrance fade kept the materials transparent).
export const BOARD_T = BOOK_D * 0.19 // one cover board's thickness
export const PAGES_D = BOOK_D * 0.6 // paper block, clear of the board inners
export const SPINE_W = 0.08
export const SPINE_H = BOOK_H - 0.006 // recessed behind the board top/bottom
export const SPINE_D = BOOK_D - 0.006 // recessed behind the board outer faces
// A real spine stands a hair proud of its boards on the bound edge — the
// only spine face allowed outside the sandwich.
export const SPINE_PROUD = 0.003

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

// Hover lift: the flat look keeps books untilted — a hovered book just
// rises a touch off the table.
export const TILT_LIFT = 0.07

// Hover hitbox: the pick region is a bit larger than the cover itself so
// the tilt starts before the pointer actually reaches the book's edge.
export const HIT_MARGIN = 1.14
export function inHitBox(px: number, py: number): boolean {
  return (
    Math.abs(px) <= (BOOK_W / 2) * HIT_MARGIN &&
    Math.abs(py) <= (BOOK_H / 2) * HIT_MARGIN
  )
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
