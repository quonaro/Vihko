// Pure 3D layout math for the journal scenes (sheet stack + overview row).
// No three.js imports here so the geometry is unit-testable under jsdom.

// Page size in world units. A page is a landscape two-page spread — the same
// sheet the editor draws on, rendered with a centre fold in the stack view.
export const PAGE_W = 2.8
export const PAGE_H = PAGE_W * (380 / 600)
export const PAGE_ASPECT = PAGE_W / PAGE_H // ~1.27, matches pageTexture
export const PAGE_STEP = PAGE_W + 0.22

// Camera distance that keeps the full landscape sheet inside the viewport.
export function sheetCameraDistance(aspect: number, minDistance = 4.4) {
  const safeAspect = Math.max(aspect, 0.1)
  const halfFov = Math.PI / 10 // 36-degree vertical field of view
  return Math.max(minDistance, PAGE_W * 0.72 / (Math.tan(halfFov) * safeAspect))
}

export interface Pose {
  x: number
  y: number
  z: number
  rotY: number
  rotZ: number
}

// --- sheet stack ------------------------------------------------------------
// Each stored page is an entire folded spread. Neighbours remain face-up
// behind it, not a separate pile of blank backs a sheet-width to the left.
export const STACK_LEAN = -0.12

// How far the right fan spreads before new sheets only nudge deeper.
const STACK_FAN_CAP = 7

export function stackPose(d: number): Pose {
  const depth = Math.abs(d)
  const f = Math.min(depth, STACK_FAN_CAP)
  const side = Math.sign(d)
  return {
    x: side * f * PAGE_W * 0.075,
    y: -f * 0.018,
    z: -depth * 0.16,
    rotY: side * f * 0.012,
    rotZ: -side * f * 0.012,
  }
}

// Hovered sheet lifts toward the camera — only meaningful on the front and
// right-fan sheets (the left pile is face-down and barely interactive).
export function stackHoverPose(d: number): Pose {
  const p = stackPose(d)
  return { ...p, y: p.y + 0.015, z: p.z + 0.025 }
}

// Lowest corner of any posed sheet once the group leans — used to rest the
// stack on the table like the overview row.
export function stackDrop(): number {
  let drop = 0
  for (let d = -8; d <= STACK_FAN_CAP; d++) {
    const p = stackPose(d)
    const y = p.y - (PAGE_H / 2) * Math.cos(p.rotZ) - (PAGE_W / 2) * Math.abs(Math.sin(p.rotZ))
    drop = Math.min(drop, y * Math.cos(STACK_LEAN) - p.z * Math.sin(STACK_LEAN))
  }
  return drop
}

export function stackRestY(): number {
  return GROUND_Y + PAGE_H / 2 + 0.16
}

// A turn moves the front sheet onto the left pile (+1) or brings the pile's
// top sheet back (-1).
export function canTurnStack(dir: 1 | -1, cur: number, total: number): boolean {
  return total > 0 && cur >= 0 && cur < total && (dir > 0 ? cur < total - 1 : cur > 0)
}

// Rounded outer corners and a real centre valley. UVs remain continuous
// across the two halves, so drawings are never split into separate pages.
export function sheetPoint(x: number, y: number): [number, number, number] {
  const r = PAGE_H * 0.045
  const cx = PAGE_W / 2 - r
  const cy = PAGE_H / 2 - r
  const dx = Math.max(0, Math.abs(x) - cx)
  const dy = Math.max(0, Math.abs(y) - cy)
  const length = Math.hypot(dx, dy)
  if (length > r) {
    x = Math.sign(x) * (cx + dx * r / length)
    y = Math.sign(y) * (cy + dy * r / length)
  }
  const u = Math.abs(x) / (PAGE_W / 2)
  const z = 0.32 * u + 0.045 * Math.sin(Math.PI * u)
  return [x, y, z]
}

// --- overview row -----------------------------------------------------------
// Every sheet stays upright and evenly spaced while `focus` shifts
// horizontally through the bounded list.
export function rowPoseFocus(i: number, focus: number): Pose {
  return {
    x: (i - focus) * PAGE_STEP,
    y: 0,
    z: 0,
    rotY: 0,
    rotZ: 0,
  }
}

export function rowHoverFocus(i: number, focus: number): Pose {
  return { ...rowPoseFocus(i, focus), y: 0.06, z: 0.16 }
}

// --- table ------------------------------------------------------------------
// Both journal modes rest on the same tabletop instead of floating:
// GROUND_Y is the shadow-catcher plane, and each group's y is derived so
// its lowest point touches it.
export const GROUND_Y = -PAGE_H / 2 - 0.3
export const ROW_LEAN = -0.5 // overview group rotation.x — row leans back, rad

// Group y that puts the row's bottom edge on the table.
export function rowRestY(): number {
  return GROUND_Y + (PAGE_H / 2) * Math.cos(ROW_LEAN)
}

// --- page turn --------------------------------------------------------------
// Position of a point on the turning sheet, spine (the sheet's left edge) at
// x = 0. x: distance along the sheet from the spine [0, w]; y: across the page.
// dir=+1 turns the front sheet onto the left pile (t: 0 flat → 1 flipped);
// dir=-1 brings a sheet back from the pile. With curl = 0 the sheet rotates
// as a flat plane; a positive curl lets the free edge trail the spine and
// peaks mid-turn, giving the leaf a paper bend instead of a plank.
export function stackHeight(x: number) {
  return Math.abs(x) * 0.05 + 0.006
}

export function curlPoint(
  x: number,
  y: number,
  w: number,
  t: number,
  dir: 1 | -1,
  curl = 0,
): [number, number, number] {
  const phi = Math.PI * (dir > 0 ? t : 1 - t)
  const theta = phi - curl * Math.sin(phi) * (x / w) ** 1.5
  const [rx, ry, rz] = sheetPoint(x, y)
  const px = rx * Math.cos(theta)
  const pz = rx * Math.sin(theta) + rz * Math.abs(Math.cos(theta)) + 0.005
  return [px, ry, pz]
}
