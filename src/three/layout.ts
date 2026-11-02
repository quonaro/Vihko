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

// Outer corner radius and the width of each fold half — shared by the
// resting sheets, their left/right half surfaces and the turning leaf so
// all four traces agree at the handoff instants.
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

// Constant z-offset the turning leaf carries so its flat poses win the
// depth test against the resting surface they replace by a hair. Both
// endpoint correspondences below include it — subtract when comparing.
export const TURN_LIFT = 0.005

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
  const pz = rx * Math.sin(theta) + rz * Math.abs(Math.cos(theta)) + TURN_LIFT
  return [px, ry, pz]
}

// === shared resting/turning surfaces ========================================
// Parametric surface samplers so a resting sheet, its left/right halves and
// the turning leaf are all evaluated from the same `sheetPoint` rounding +
// centre-fold math — a moving half therefore lands exactly on the resting
// surface it replaces at progress 0 and 1.
//
// Parameter convention: u ∈ [0,1] sweeps the surface left→right (for a half,
// from its outer edge to the fold is NOT used — see below), v ∈ [0,1] sweeps
// top→bottom of the sheet. `sheetUV` maps (u,v) to texture UV matching the
// existing page texture orientation (uv.y = 1 - v, same as PlaneGeometry).

export type SheetSide = 'left' | 'right' | 'full'

// Texture UV for sheet parameter (u,v): one continuous texture across the
// fold — left half covers u∈[0,0.5], right half u∈[0.5,1].
export function sheetUV(u: number, v: number): [number, number] {
  return [u, 1 - v]
}

// Resting sheet point at (u,v): u spans the whole sheet left→right.
export function sheetPointUV(u: number, v: number): [number, number, number] {
  return sheetPoint(-PAGE_W / 2 + u * PAGE_W, PAGE_H / 2 - v * PAGE_H)
}

// Resting half-sheet point. u ∈ [0,1] sweeps the half in sheet direction:
// 'left': x goes -PAGE_W/2 → 0 (u 0→1, outer edge to fold), 'right': x goes
// 0 → +PAGE_W/2 (fold to outer edge).
export function halfPointUV(
  side: 'left' | 'right',
  u: number,
  v: number,
): [number, number, number] {
  return sheetPointUV(side === 'left' ? u * 0.5 : 0.5 + u * 0.5, v)
}

// Turning leaf point. u ∈ [0,1] runs hinge (fold, local x=0) → free edge
// (local x=HALF_W); v sweeps top→bottom exactly like the resting halves.
// Endpoint correspondence (the pose of the leaf's parent group is
// `turnLeafPose`, i.e. the front slot's pose):
//   dir=+1, t=0 → 'right' half:  leafPointUV(u,v,0,+1) = halfPointUV('right', u, v)   + (0,0,TURN_LIFT)
//   dir=+1, t=1 → 'left'  half:  leafPointUV(u,v,1,+1) = halfPointUV('left', 1-u, v)  + (0,0,TURN_LIFT)
//   dir=-1, t=0 → 'left'  half:  leafPointUV(u,v,0,-1) = halfPointUV('left', 1-u, v)  + (0,0,TURN_LIFT)
//   dir=-1, t=1 → 'right' half:  leafPointUV(u,v,1,-1) = halfPointUV('right', u, v)   + (0,0,TURN_LIFT)
// (The 'left' correspondence mirrors u because the leaf's free edge travels
// to the sheet's outer left edge.) Positions, normals and UVs agree with the
// resting halves because both come from sheetPoint.
export function leafPointUV(
  u: number,
  v: number,
  t: number,
  dir: 1 | -1,
  curl = 0,
): [number, number, number] {
  return curlPoint(u * HALF_W, PAGE_H / 2 - v * PAGE_H, HALF_W, t, dir, curl)
}

// Texture u for a leaf face at leaf param u. Convention (same as the
// previous buildLeaf remap): the front face always shows the texture's
// RIGHT half (u∈[0.5,1]); the back face shows the LEFT half, mirrored —
// when the leaf lies face-down on the left it reads as the destination
// spread's left page. Scene assigns the textures per direction; uv.y
// comes from the leaf grid unchanged.
export function leafTexU(face: 'front' | 'back', u: number): number {
  return face === 'front' ? 0.5 + u * 0.5 : 0.5 - u * 0.5
}

// Pose of the leaf's parent group while the sheet `slot` steps from the
// front turns in direction `dir` (slot 0 for dir=+1, -1 for dir=-1 — i.e.
// the source sheet's stack slot before the turn). The leaf surface is
// generated in this frame, so at t=0/t=1 it coincides with the resting
// halves of the sheet at that pose (see leafPointUV). Both endpoints
// share one pose — the fold never moves; only the surfaces underneath
// recede/advance.
export function turnLeafPose(slot: number, dir: 1 | -1): Pose {
  return stackPose(dir > 0 ? slot : slot + 1)
}

// Which resting half-surface the leaf coincides with at a motion endpoint:
// dir=+1 lifts the 'right' half (t=0) and lands it as the 'left' half (t=1);
// dir=-1 mirrors. Use with halfPointUV (mirroring u for 'left').
export function turnEndpointHalf(t: 0 | 1, dir: 1 | -1): 'left' | 'right' {
  const onLeft = dir > 0 ? t === 1 : t === 0
  return onLeft ? 'left' : 'right'
}

// Pose + texture range of a resting half-sheet at stack slot d — the
// counterpart of turnLeafPose for the stationary surfaces.
export function restingHalf(
  d: number,
  side: 'left' | 'right',
): { pose: Pose; side: 'left' | 'right'; uRange: [number, number] } {
  return {
    pose: stackPose(d),
    side,
    uRange: side === 'left' ? [0, 0.5] : [0.5, 1],
  }
}

// Linear pose interpolation (all five fields) for captured→target handoffs.
export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    rotY: a.rotY + (b.rotY - a.rotY) * t,
    rotZ: a.rotZ + (b.rotZ - a.rotZ) * t,
  }
}

// === triangulated grids =====================================================
// Vertex grids for BufferGeometry construction: positions in the surface's
// local frame, UVs in the continuous-page convention, triangle indices
// wound CCW seen from +z. The scene builds BufferGeometry from these
// (computeVertexNormals afterwards); keeping three.js out of this file
// leaves the math unit-testable under jsdom.

export interface SheetGrid {
  positions: Float32Array // (rows+1)×(cols+1) xyz triples
  uvs: Float32Array // same count, uv pairs
  indices: Uint32Array // rows×cols×2 triangles
  cols: number
  rows: number
}

function buildGrid(
  cols: number,
  rows: number,
  point: (u: number, v: number) => [number, number, number],
  texU: (u: number) => number,
): SheetGrid {
  const positions = new Float32Array((cols + 1) * (rows + 1) * 3)
  const uvs = new Float32Array((cols + 1) * (rows + 1) * 2)
  const indices = new Uint32Array(cols * rows * 6)
  for (let j = 0; j <= rows; j++) {
    const v = j / rows
    for (let i = 0; i <= cols; i++) {
      const u = i / cols
      const k = j * (cols + 1) + i
      const [x, y, z] = point(u, v)
      positions[k * 3] = x
      positions[k * 3 + 1] = y
      positions[k * 3 + 2] = z
      uvs[k * 2] = texU(u)
      uvs[k * 2 + 1] = 1 - v
    }
  }
  let n = 0
  const at = (i: number, j: number) => j * (cols + 1) + i
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = at(i, j)
      const b = at(i + 1, j)
      const c = at(i, j + 1)
      const d = at(i + 1, j + 1)
      indices[n++] = a
      indices[n++] = d
      indices[n++] = b
      indices[n++] = a
      indices[n++] = c
      indices[n++] = d
    }
  }
  return { positions, uvs, indices, cols, rows }
}

// Resting surface grid. side 'left'/'right' give the two explicit
// half-sheets (fold included in both at u/v edge), 'full' the whole sheet.
// UVs always span the shared page texture — never [0,1] per half.
export function sheetGrid(side: SheetSide = 'full', cols = 32, rows = 16): SheetGrid {
  if (side === 'full') return buildGrid(cols, rows, sheetPointUV, (u) => u)
  return buildGrid(
    cols,
    rows,
    (u, v) => halfPointUV(side, u, v),
    (u) => (side === 'left' ? u * 0.5 : 0.5 + u * 0.5),
  )
}

// Turning-leaf rest grid in leaf space: flat, hinge at x=0, free edge at
// x=HALF_W. uv.x holds the raw leaf parameter 0→1 — remap per face with
// leafTexU('front'|'back', u). Deform every frame by rewriting positions
// with leafPointUV, then computeVertexNormals.
export function leafGrid(cols = 32, rows = 16): SheetGrid {
  return buildGrid(
    cols,
    rows,
    (u, v) => [u * HALF_W, PAGE_H / 2 - v * PAGE_H, 0],
    (u) => u,
  )
}

// === perimeter / outline samplers ===========================================
// The sheet outline must come from the same rounded geometry — EdgesGeometry
// would outline the fold, thickness seams and subdivision edges instead.

export interface SheetOutlineSpec {
  // Which surface to trace. Half sheets include their fold edge as the
  // closing segment unless `hinge` is false.
  side?: SheetSide
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

// Number of points sheetOutline returns for a spec — size buffers with
// (sheetOutlineCount(spec) + 1) * 3 floats for a closed packed loop.
export function sheetOutlineCount(spec: SheetOutlineSpec = {}): number {
  const e = spec.edgeSteps ?? 8
  const c = spec.cornerSteps ?? 6
  const side = spec.side ?? 'full'
  // The first corner seeds the path, then each segment appends its count.
  if (side === 'full') return 1 + 4 * e + 4 * c
  return 1 + (spec.hinge === false ? 3 : 4) * e + 2 * c
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
  return pts
}

// Perimeter lifted onto the folded resting surface via sheetPoint — points
// lie exactly on the sheet's boundary (arc samples sit on the same rounding
// circle, edge samples inside it), so the outline rides the sheet.
export function sheetOutline3D(spec: SheetOutlineSpec = {}): [number, number, number][] {
  return sheetOutline(spec).map(([x, y]) => sheetPoint(x, y))
}

// Perimeter of the turning leaf at progress t, evaluated through the same
// curl deformation as leafPointUV — the outline follows the deformed
// vertices every frame. Leaf space: hinge at x=0, free edge at x=HALF_W.
// At the endpoints this equals the corresponding half's sheetOutline3D
// (mirrored for 'left') plus TURN_LIFT — see leafPointUV.
export function leafOutline3D(
  t: number,
  dir: 1 | -1,
  curl = 0,
  spec: SheetOutlineSpec = {},
): [number, number, number][] {
  return sheetOutline({ ...spec, side: 'right', hinge: true }).map(([x, y]) =>
    curlPoint(x, y, HALF_W, t, dir, curl),
  )
}

// Per-frame fast path: rewrite a packed closed outline buffer in place.
// `dst` must hold at least (sheetOutlineCount(spec) + 1) * 3 floats; the
// leaf outline is always closed (the moving half's fold edge is a real
// silhouette). Returns the float count written — feed dst.subarray(0, n)
// to LineGeometry.setPositions or copy into the instanced segment buffer.
export function writeLeafOutline(
  t: number,
  dir: 1 | -1,
  curl: number,
  dst: Float32Array,
  spec: SheetOutlineSpec = {},
): number {
  const ring = leafOutline3D(t, dir, curl, spec)
  for (let i = 0; i <= ring.length; i++) {
    const p = ring[i % ring.length]
    dst[i * 3] = p[0]
    dst[i * 3 + 1] = p[1]
    dst[i * 3 + 2] = p[2]
  }
  return (ring.length + 1) * 3
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

// Resolution hook for fat-line materials (three/addons LineMaterial, used
// by Line2/LineSegments2 — already vendored in this codebase). Call once
// after creation and on every canvas resize with the CSS pixel size; the
// linewidth uniform is in CSS px and goes stale without this. Duck-typed
// so layout.ts stays free of three.js imports.
export function setOutlineResolution(
  material: { resolution: { set(x: number, y: number): void } },
  cssWidth: number,
  cssHeight: number,
): void {
  material.resolution.set(cssWidth, cssHeight)
}

// === journal sheet outline material contract ================================
// Recommended parameters for the scene's dedicated journal outline
// LineMaterial (journal only — shelf keeps its own outlineMaterial):
//   new LineMaterial({
//     color: SHEET_OUTLINE_COLOR, linewidth: SHEET_OUTLINE_PX,
//     transparent: true, opacity: SHEET_OUTLINE_OPACITY,
//     depthTest: true, depthWrite: false, toneMapped: false,
//     polygonOffset: true, polygonOffsetFactor: OUTLINE_POLYGON_OFFSET.factor,
//     polygonOffsetUnits: OUTLINE_POLYGON_OFFSET.units,
//   })
// and line.renderOrder = OUTLINE_RENDER_ORDER. Depth testing stays ON so
// rear-sheet borders never draw through the front sheet; the small
// negative bias pulls the ink a hair in front of its own paper, avoiding
// the white dashed z-fight ladder at grazing angles while staying behind
// geometry genuinely in front.
export const SHEET_OUTLINE_PX = 1.3 // ~1–1.5 CSS px
export const SHEET_OUTLINE_COLOR = 0x453c31 // dark warm grey
export const SHEET_OUTLINE_OPACITY = 0.55
export const OUTLINE_POLYGON_OFFSET = { factor: -1, units: -1 } as const
export const OUTLINE_RENDER_ORDER = 2
