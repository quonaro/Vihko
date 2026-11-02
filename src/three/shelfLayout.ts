// Pure 3D layout math for the shelf scene (journal row + pointer tilt).
// No three.js imports here so the math stays unit-testable under jsdom —
// same convention as layout.ts.

// Book size in world units. Aspect matches the DOM covers' .book-inner
// (width clamp, aspect-ratio: .735); height lands at ~45% of the visible
// stage at CAM_DIST — same share the DOM covers take.
export const BOOK_W = 1.08
export const BOOK_H = BOOK_W / 0.735
export const BOOK_D = 0.12 // total thickness incl. both boards
export const SHELF_STEP = BOOK_W + 0.24 // center-to-center spacing
export const EDGE_PAD = 0.3 // world-unit margin kept at row ends while panning

export interface ShelfPose {
  x: number
  y: number
  z: number
  rotX: number
  rotY: number
  scale: number
}

// Rest pose in the row — mirrors the DOM bookStyle: a flat row at one
// height; books off centre only yaw inward like volumes on a shelf.
export function shelfPose(i: number, total: number): ShelfPose {
  const off = i - (total - 1) / 2
  return {
    x: off * SHELF_STEP,
    y: 0,
    z: 0,
    rotX: 0,
    rotY: -Math.sign(off) * 0.14 + 0, // +0 normalizes -0 for sign(0)
    scale: 1,
  }
}

// Pointer-driven tilt (vanilla-tilt convention): the cover edge under the
// pointer presses away from the viewer. nx/ny is the pointer position on
// the front face in half-size units (-1..1, +x right, +y up); out-of-range
// input is clamped.
export const TILT_YAW = 0.26
export const TILT_PITCH = 0.15

export function hoverTilt(nx: number, ny: number): { rotX: number; rotY: number } {
  const cx = Math.max(-1, Math.min(1, nx))
  const cy = Math.max(-1, Math.min(1, ny))
  return { rotY: cx * TILT_YAW + 0, rotX: -cy * TILT_PITCH + 0 }
}

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
