// Pure 3D layout math for the journal scenes (fan + book spread). No three.js
// imports here so the geometry is unit-testable under jsdom.

// Page size in world units. Aspect matches the DOM previews' 300x380 viewBox.
export const PAGE_W = 1.4
export const PAGE_H = PAGE_W * (380 / 300)
export const PAGE_ASPECT = PAGE_W / PAGE_H // ~0.789, matches pageTexture
export const PAGE_STEP = PAGE_W + 0.22
export const COVER_W = PAGE_W
export const COVER_H = PAGE_H

export function spreadCameraDistance(aspect: number, minDistance = 4.4) {
  const safeAspect = Math.max(aspect, 0.1)
  const halfFov = Math.PI / 10 // 36-degree vertical field of view
  return Math.max(minDistance, PAGE_W / (Math.tan(halfFov) * safeAspect) / 0.86)
}

export interface Pose {
  x: number
  y: number
  z: number
  rotY: number
  rotZ: number
}

// --- fan ------------------------------------------------------------------
// Mirrors the DOM fan: translateX + rotate(Z), but adds real depth — pages
// nearer the middle lie on top of the stack. Depth keys off the UNCLAMPED
// offset so wings keep receding once the spread saturates, plus a step across
// the spine: on each side the outer sheet tucks under its inner neighbour, so
// an i-proportional term cannot order the centre pair — the two sheets facing
// the viewer need a discrete lift or their yawed inner edges clip through.
export function fanPose(i: number, total: number): Pose {
  return fanPoseAt(i - (total - 1) / 2)
}

// Focused fan: `focus` is the (fractional) page index the fan is scrolled
// to, so dragging re-fans the stack around the finger instead of staying
// pinned to the row centre.
export function fanPoseFocus(i: number, focus: number): Pose {
  return fanPoseAt(i - focus)
}

function fanPoseAt(raw: number): Pose {
  const off = Math.max(-4, Math.min(4, raw))
  return {
    x: off * PAGE_W * 0.52,
    y: -Math.abs(off) * 0.03,
    z: -Math.abs(raw) * 0.05 + (raw >= 0 ? 0.06 : 0),
    rotY: -off * 0.14,
    rotZ: off * 0.075,
  }
}

// Journal overview row: every page stays upright and evenly spaced while
// `focus` shifts horizontally through the bounded list.
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

// Horizontal half-extent of a posed sheet (rotZ widens the footprint).
function span(rotZ: number) {
  return (PAGE_W / 2) * Math.cos(rotZ) + (PAGE_H / 2) * Math.abs(Math.sin(rotZ))
}

// Hovered page lifts toward the camera and straightens out. The lift must
// clear the forward-swinging edge of every sheet it still overlaps — the
// neighbour's near corner sits up to ~span·sin(rotY) above its own centre —
// or the sheet visibly slices through the fan while rising.
export function fanHoverPose(i: number, total: number): Pose {
  return fanHoverFocus(i, (total - 1) / 2, total)
}

export function fanHoverFocus(i: number, focus: number, total: number): Pose {
  const p = fanPoseFocus(i, focus)
  const rotZ = p.rotZ * 0.25
  const hSpan = span(rotZ)
  let lift = 0.3
  for (let j = 0; j < total; j++) {
    if (j === i) continue
    const q = fanPoseFocus(j, focus)
    if (Math.abs(q.x - p.x) >= span(q.rotZ) + hSpan) continue
    lift = Math.max(lift, q.z + span(q.rotZ) * Math.abs(Math.sin(q.rotY)) - p.z + 0.05)
  }
  return { ...p, y: p.y + 0.07, z: p.z + lift, rotY: 0, rotZ }
}

// --- spread ---------------------------------------------------------------
// The open book leans back; each half yaws a touch so outer edges come
// toward the viewer — the spine reads as a shallow V.
export const SPREAD_LEAN = -0.3 // book group rotation.x, rad
export const SPREAD_TILT = 0.05 // per-half rotation.y, rad

export interface BookFoldPose {
  coverY: number
  centerX: number
  coverZ: number
}

export function bookFoldPose(progress: number): BookFoldPose {
  const t = Math.max(0, Math.min(1, progress))
  return {
    coverY: Math.PI * t,
    centerX: t ? -(PAGE_W / 2) * t : 0,
    // Lift the closed board above the page block so its face fully covers it.
    coverZ: 0.05 * t,
  }
}

// `spread` is the page on the right. At the beginning the front cover is
// on the left; after turning a leaf, its reverse (spread - 1) is on the left.
// The terminal cover view retains the final page on the left.
export function spreadPageIndices(spread: number, total: number) {
  if (spread >= total) {
    return { left: total > 0 ? total - 1 : null, right: null }
  }
  return {
    left: spread > 0 && spread - 1 < total ? spread - 1 : null,
    right: spread < total ? spread : null,
  }
}

export function lastSpreadIndex(total: number) {
  return Math.ceil(Math.max(0, total) / 2) * 2
}

export function spreadCount(total: number) {
  return Math.floor(lastSpreadIndex(total) / 2) + 1
}

// Surface height of a stack half at |x| from the spine (matches the ±SPREAD_TILT
// yaw of the static halves, plus a hair of leaf thickness).
export function stackHeight(x: number) {
  return Math.abs(x) * Math.sin(SPREAD_TILT) + 0.006
}

// The last step turns the final page over to reveal the back cover, even when
// that page has no stored reverse side.
export function canTurn(dir: 1 | -1, spread: number, total: number): boolean {
  return dir > 0 ? spread < lastSpreadIndex(total) : spread > 0
}

// --- page turn ------------------------------------------------------------
// Position of a point on the turning sheet, spine at x = 0.
// x: distance along the sheet from the spine [0, w]; y: across the page.
// dir=+1 turns right→left (t: 0 flat right → 1 flat left);
// dir=-1 turns left→right. The sheet rotates as a single flat plane around
// the spine, without curling or shearing its free edge.
export function curlPoint(
  x: number,
  y: number,
  _w: number,
  t: number,
  dir: 1 | -1,
): [number, number, number] {
  const phi = Math.PI * (dir > 0 ? t : 1 - t)
  const px = x * Math.cos(phi)
  // Keep the leaf above the stack so it cannot clip through the opposite page.
  const pz = Math.max(x * Math.sin(phi), stackHeight(px))
  return [px, y, pz]
}
