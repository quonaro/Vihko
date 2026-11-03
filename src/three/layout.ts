// Pure 3D layout math for the journal scenes (leaf piles + overview row).
// No three.js imports here so the geometry is unit-testable under jsdom.

// Page size in world units. A page is a landscape two-page spread — the same
// sheet the editor draws on, rendered with a centre fold in the stack view.
export const PAGE_W = 2.8
export const PAGE_H = PAGE_W * (380 / 600)
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

// --- table ------------------------------------------------------------------
// The journal rests on a tabletop instead of floating: GROUND_Y is the
// shadow-catcher plane, and each group's y is derived so its lowest point
// touches it.
export const GROUND_Y = -PAGE_H / 2 - 0.3

// --- sheet stack -------------------------------------------------------------
export const STACK_LEAN = -0.12

// A turn moves the front sheet onto the left pile (+1) or brings the pile's
// top sheet back (-1).
export function canTurnStack(dir: 1 | -1, cur: number, total: number): boolean {
  return total > 0 && cur >= 0 && cur < total && (dir > 0 ? cur < total - 1 : cur > 0)
}

// --- folded sheet ------------------------------------------------------------
// Outer corner radius and the width of each fold half — shared by the
// resting leaves and their outlines so every trace agrees.
export const SHEET_CORNER_R = PAGE_H * 0.045
export const HALF_W = PAGE_W / 2

// Rounded outer corners and a real centre valley. UVs remain continuous
// across the two halves, so drawings are never split into separate pages.
export function sheetPoint(x: number, y: number): [number, number, number] {
  const r = SHEET_CORNER_R
  const cx = PAGE_W / 2 - r
  const cy = PAGE_H / 2 - r
  const dx = Math.max(0, Math.abs(x) - cx)
  const dy = Math.max(0, Math.abs(y) - cy)
  const length = Math.hypot(dx, dy)
  // Clamp to the rounded rect: arc-rescale only inside the corner square —
  // past a straight edge (dy = 0) just clamp that axis, otherwise the
  // sheet's side-edge vertices would collapse onto the corner tangent.
  if (dx > 0 && dy > 0 && length > r) {
    x = Math.sign(x) * (cx + dx * r / length)
    y = Math.sign(y) * (cy + dy * r / length)
  } else if (dx > r) {
    x = Math.sign(x) * (cx + r)
  } else if (dy > r) {
    y = Math.sign(y) * (cy + r)
  }
  const u = Math.abs(x) / (PAGE_W / 2)
  const z = 0.32 * u + 0.045 * Math.sin(Math.PI * u)
  return [x, y, z]
}

// --- overview row ------------------------------------------------------------
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

// Group y that puts the row's bottom edge on the table.
export const ROW_LEAN = -0.5 // overview group rotation.x — row leans back, rad
export function rowRestY(): number {
  return GROUND_Y + (PAGE_H / 2) * Math.cos(ROW_LEAN)
}

// === leaf piles (fanned half-sheets hinged at the centre spine) =============
// The journal is a row of half-sheet leaves sharing the spine line x = 0,
// like a real book block. Leaf k carries spread k-1's right half on its
// front face and spread k's left half on its back face, so the open spread
// is always just the two boundary leaves — and a page turn is a single
// leaf rotating, never surfaces being hidden or swapped.
//
// Angle convention: theta is the leaf's rotation about the spine (+y).
// theta = 0 lies flat to the right face-up (front visible), theta = PI lies
// flat to the left face-down (back visible), theta = PI/2 stands upright.

// Tilt of a leaf off flat by its depth inside a pile. The pile-top leaf
// (depth 0) leans the most — like the open page lifted off a real book
// block — and deeper leaves settle flatter under it. Fanning the other way
// would poke deeper pages up through the open one.
export const LEAF_LEAN = 0.14
export const LEAF_FAN_DECAY = 0.3
// Hinge offset along -z per pile depth so leaves stack without coplanar
// z-fighting.
export const LEAF_ZSTEP = 0.014

// The page block fans like a real open book: each deeper leaf's FREE EDGE
// peeks a step further out and settles a bit lower, so the pile sides form
// a stair-step skirt past the open spread. Both taper to zero at the hinge —
// the spine never detaches, which a whole-leaf offset would do. Capped so
// a thick journal's block spreads only so wide.
export const LEAF_FAN_STEP = 0.055 // free-edge extension per depth
export const LEAF_SINK_STEP = 0.022 // free-edge drop per depth
export const LEAF_FAN_CAP = 8

export function pileLean(depth: number): number {
  return LEAF_LEAN / (1 + Math.max(0, depth) * LEAF_FAN_DECAY)
}

// Pile depth of leaf k for focus `cur`: 0 for the two boundary leaves of
// the open spread, growing into the block on either side. Both piles share
// the same magnitudes — the fan stays symmetric.
export function leafDepth(k: number, cur: number): number {
  return Math.max(0, k <= cur ? cur - k : k - cur - 1)
}

// Rest angle of leaf k while spread `cur` is open: k <= cur lies on the
// left pile, k > cur on the right. Fractional `cur` interpolates depths.
export function leafRestAngle(k: number, cur: number): number {
  return k <= cur ? Math.PI - pileLean(cur - k) : pileLean(k - cur - 1)
}

// Hinge z of leaf k for focus `cur` — the pile top sits at 0.
export function leafRestZ(k: number, cur: number): number {
  const j = leafDepth(k, cur)
  return j <= 0 ? 0 : -j * LEAF_ZSTEP
}

// How far leaf k's free edge extends past its hinge, world units.
export function leafRestFan(k: number, cur: number): number {
  return Math.min(leafDepth(k, cur), LEAF_FAN_CAP) * LEAF_FAN_STEP
}

// How far leaf k's free edge drops below the hinge line, world units.
export function leafRestSink(k: number, cur: number): number {
  return Math.min(leafDepth(k, cur), LEAF_FAN_CAP) * LEAF_SINK_STEP
}

// Group y that puts the fanned block's lowest corner on the table. Sampler
// (not closed form) so it stays right for any lean, fan depth or curl.
export function stackRestY(): number {
  const c = Math.cos(STACK_LEAN)
  const s = Math.sin(STACK_LEAN)
  let drop = 0
  for (let j = 0; j <= LEAF_FAN_CAP + 2; j++) {
    const theta = pileLean(j)
    const hingeZ = -j * LEAF_ZSTEP
    const fan = Math.min(j, LEAF_FAN_CAP) * LEAF_FAN_STEP
    const sink = Math.min(j, LEAF_FAN_CAP) * LEAF_SINK_STEP
    for (const x of [0, HALF_W]) {
      for (const y of [-PAGE_H / 2, PAGE_H / 2]) {
        const [, py, pz] = leafPointTheta(x, y, HALF_W, theta, 0, fan, sink)
        drop = Math.min(drop, py * c - (pz + hingeZ) * s)
      }
    }
  }
  return GROUND_Y - drop + 0.02
}

// Half-leaf point hinged at local x = 0, free edge at x = w (HALF_W),
// rotated `theta` about the spine. The sheet edge-lift bump folds under
// |cos θ| so the free edge always curls toward the face-up side; `curl`
// trails the free edge behind the spine mid-turn (a paper bend). `fan`
// extends the free edge radially and `sink` tilts it down — both scale with
// the distance from the hinge (x/w), so x = 0 stays glued to the spine and
// the leaf can never tear away from the fold.
export function leafPointTheta(
  x: number,
  y: number,
  w: number,
  theta: number,
  curl = 0,
  fan = 0,
  sink = 0,
): [number, number, number] {
  const ext = x / w
  const th = theta - curl * Math.sin(theta) * ext ** 1.5
  const [rx, ry, rz] = sheetPoint(x, y)
  const px = (rx + fan * ext) * Math.cos(th)
  const pz = (rx + fan * ext) * Math.sin(th) + rz * Math.abs(Math.cos(th))
  return [px, ry - sink * ext, pz]
}

// Perimeter of a leaf at absolute theta — outline points ride the same
// deformation as the mesh and nudge a hair along the face-up normal so the
// ink never sinks into its own paper at grazing angles.
export function leafOutlineTheta(
  theta: number,
  curl = 0,
  fan = 0,
  sink = 0,
): [number, number, number][] {
  const s = Math.cos(theta) >= 0 ? 1 : -1
  const e = 0.004
  return sheetOutline({ side: 'right', hinge: true }).map(([x, y]) => {
    const [px, py, pz] = leafPointTheta(x, y, HALF_W, theta, curl, fan, sink)
    return [px + Math.sin(theta) * s * e, py, pz + Math.cos(theta) * s * e]
  })
}

// Texture u for a leaf face at leaf param u. Convention: the front face
// always shows the texture's RIGHT half (u∈[0.5,1]); the back face shows
// the LEFT half, mirrored — when the leaf lies face-down on the left it
// reads as the destination spread's left page. Scene assigns the textures
// per direction; uv.y comes from the leaf grid unchanged.
export function leafTexU(face: 'front' | 'back', u: number): number {
  return face === 'front' ? 0.5 + u * 0.5 : 0.5 - u * 0.5
}

// === perimeter / outline samplers ===========================================
// The sheet outline must come from the same rounded geometry — EdgesGeometry
// would outline the fold, thickness seams and subdivision edges instead.

export interface SheetOutlineSpec {
  // Which surface to trace. Half sheets include their fold edge as the
  // closing segment unless `hinge` is false.
  side?: 'left' | 'right' | 'full'
  // Sample count per straight edge segment (default 8).
  edgeSteps?: number
  // Sample count per rounded corner arc (default 6).
  cornerSteps?: number
  // Half sheets only: include the fold-edge segment. Set false on the
  // stationary halves during a turn so the shared inner seam is not drawn
  // twice — the moving leaf already carries its hinge edge.
  hinge?: boolean
}

const edge = (
  pts: [number, number][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  n: number,
) => {
  for (let k = 1; k <= n; k++) pts.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n])
}

const arc = (
  pts: [number, number][],
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  n: number,
) => {
  for (let k = 1; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
}

// Ordered 2D boundary loop in sheet space (x right, y up), clockwise
// (negative signed area), starting just past the top-left/fold-top corner.
// For 'full': top edge → TR arc → right edge → BR arc → bottom → BL arc →
// left edge → TL arc. For halves the fold is the inner straight edge;
// with hinge:false the returned path is open — its endpoints are the two
// hinge corners (0, ±PAGE_H/2), pass closed=false to packOutline.
export function sheetOutline(spec: SheetOutlineSpec = {}): [number, number][] {
  const e = spec.edgeSteps ?? 8
  const c = spec.cornerSteps ?? 6
  const side = spec.side ?? 'full'
  const w = PAGE_W / 2
  const h = PAGE_H / 2
  const r = SHEET_CORNER_R
  const cx = w - r
  const cy = h - r
  const hinge = spec.hinge !== false
  const pts: [number, number][] = []

  if (side === 'right') {
    pts.push([0, h])
    edge(pts, 0, h, cx, h, e)
    arc(pts, cx, cy, r, Math.PI / 2, 0, c)
    edge(pts, w, cy, w, -cy, e)
    arc(pts, cx, -cy, r, 0, -Math.PI / 2, c)
    edge(pts, cx, -h, 0, -h, e)
    if (hinge) edge(pts, 0, -h, 0, h, e)
    return pts
  }
  if (side === 'left') {
    // Clockwise here means starting down the fold first.
    if (hinge) {
      pts.push([0, h])
      edge(pts, 0, h, 0, -h, e)
    } else {
      pts.push([0, -h])
    }
    edge(pts, 0, -h, -cx, -h, e)
    arc(pts, -cx, -cy, r, -Math.PI / 2, -Math.PI, c)
    edge(pts, -w, -cy, -w, cy, e)
    arc(pts, -cx, cy, r, Math.PI, Math.PI / 2, c)
    edge(pts, -cx, h, 0, h, e)
    return pts
  }
  pts.push([-cx, h])
  edge(pts, -cx, h, cx, h, e)
  arc(pts, cx, cy, r, Math.PI / 2, 0, c)
  edge(pts, w, cy, w, -cy, e)
  arc(pts, cx, -cy, r, 0, -Math.PI / 2, c)
  edge(pts, cx, -h, -cx, -h, e)
  arc(pts, -cx, -cy, r, -Math.PI / 2, -Math.PI, c)
  edge(pts, -w, -cy, -w, cy, e)
  arc(pts, -cx, cy, r, Math.PI, Math.PI / 2, c)
  edge(pts, -cx, h, -cx, h, e)
  return pts
}

// Perimeter lifted onto the folded resting surface via sheetPoint — points
// lie exactly on the sheet's boundary (arc samples sit on the same rounding
// circle, edge samples inside it), so the outline rides the sheet.
export function sheetOutline3D(spec: SheetOutlineSpec = {}): [number, number, number][] {
  return sheetOutline(spec).map(([x, y]) => sheetPoint(x, y))
}

// Flat xyz strip for LineGeometry.setPositions / BufferGeometry positions.
// closed (default) repeats the first point so the loop seals; pass
// closed=false for hinge:false half outlines (open path).
export function packOutline(
  pts: [number, number, number][],
  closed = true,
): Float32Array {
  const n = closed ? pts.length + 1 : pts.length
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const p = pts[i % pts.length]
    out[i * 3] = p[0]
    out[i * 3 + 1] = p[1]
    out[i * 3 + 2] = p[2]
  }
  return out
}

// === journal sheet outline material contract ================================
// Parameters for the scene's dedicated journal outline LineMaterial (journal
// only — shelf keeps its own outlineMaterial). Depth testing stays ON so
// rear-sheet borders never draw through the front sheet.
export const SHEET_OUTLINE_PX = 1.3 // ~1–1.5 CSS px
export const SHEET_OUTLINE_COLOR = 0x453c31 // dark warm grey
export const SHEET_OUTLINE_OPACITY = 0.55
