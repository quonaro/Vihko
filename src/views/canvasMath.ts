import type { Layer, Sample, SymmetryMode } from '../types'

export type LayerBounds = { left: number; top: number; right: number; bottom: number }
export type LayerPoint = { x: number; y: number }
export type TransformHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate' | 'move'
export type ResizeHandle = Exclude<TransformHandle, 'rotate' | 'move'>
export type TransformFrame = {
  bounds: LayerBounds
  local: Record<ResizeHandle, LayerPoint>
  screen: Record<ResizeHandle, LayerPoint>
  center: LayerPoint
  centerWorld: LayerPoint
  centerScreen: LayerPoint
  rotate: LayerPoint
}

const OPPOSITE_HANDLE: Record<ResizeHandle, ResizeHandle> = {
  nw: 'se',
  n: 's',
  ne: 'sw',
  e: 'w',
  se: 'nw',
  s: 'n',
  sw: 'ne',
  w: 'e',
}

export function layerPoint(
  layer: Pick<Layer, 'x' | 'y' | 'scale' | 'rotation'>,
  point: LayerPoint,
  pageW: number,
  pageH: number,
): LayerPoint {
  const angle = (layer.rotation * Math.PI) / 180
  const dx = (point.x - pageW / 2) * layer.scale
  const dy = (point.y - pageH / 2) * layer.scale
  return {
    x: pageW / 2 + layer.x + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: pageH / 2 + layer.y + dx * Math.sin(angle) + dy * Math.cos(angle),
  }
}

export function frameLocalPoints(bounds: LayerBounds): Record<ResizeHandle, LayerPoint> {
  const cx = (bounds.left + bounds.right) / 2
  const cy = (bounds.top + bounds.bottom) / 2
  return {
    nw: { x: bounds.left, y: bounds.top },
    n: { x: cx, y: bounds.top },
    ne: { x: bounds.right, y: bounds.top },
    e: { x: bounds.right, y: cy },
    se: { x: bounds.right, y: bounds.bottom },
    s: { x: cx, y: bounds.bottom },
    sw: { x: bounds.left, y: bounds.bottom },
    w: { x: bounds.left, y: cy },
  }
}

export function buildTransformFrame(
  layer: Pick<Layer, 'x' | 'y' | 'scale' | 'rotation'>,
  bounds: LayerBounds,
  toScreen: (point: LayerPoint) => LayerPoint,
  pageW: number,
  pageH: number,
): TransformFrame {
  const local = frameLocalPoints(bounds)
  const screen = {} as Record<ResizeHandle, LayerPoint>
  for (const key of Object.keys(local) as ResizeHandle[]) {
    screen[key] = toScreen(layerPoint(layer, local[key], pageW, pageH))
  }
  const center = {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
  }
  const centerWorld = layerPoint(layer, center, pageW, pageH)
  const centerScreen = toScreen(centerWorld)
  const top = screen.n
  const len = Math.hypot(top.x - centerScreen.x, top.y - centerScreen.y) || 1
  return {
    bounds,
    local,
    screen,
    center,
    centerWorld,
    centerScreen,
    rotate: {
      x: top.x + ((top.x - centerScreen.x) / len) * 24,
      y: top.y + ((top.y - centerScreen.y) / len) * 24,
    },
  }
}

export function hitTransformControl(
  frame: TransformFrame,
  x: number,
  y: number,
): TransformHandle | null {
  if (Math.hypot(x - frame.rotate.x, y - frame.rotate.y) <= 18) return 'rotate'
  const handles = Object.keys(frameLocalPoints(frame.bounds)) as ResizeHandle[]
  const handle = handles.find(
    (key) => Math.hypot(x - frame.screen[key].x, y - frame.screen[key].y) <= 18,
  )
  if (handle) return handle

  const corners = [frame.screen.nw, frame.screen.ne, frame.screen.se, frame.screen.sw]
  let inside = false
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const a = corners[i],
      b = corners[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside ? 'move' : null
}

export function cursorForHandle(frame: TransformFrame, handle: TransformHandle | null) {
  if (!handle) return 'default'
  if (handle === 'rotate') return 'crosshair'
  if (handle === 'move') return 'move'
  const opposite = OPPOSITE_HANDLE[handle]
  const a = frame.screen[opposite],
    b = frame.screen[handle]
  const angle = ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 180
  if (angle < 22.5 || angle >= 157.5) return 'ew-resize'
  if (angle < 67.5) return 'nwse-resize'
  if (angle < 112.5) return 'ns-resize'
  return 'nesw-resize'
}

export function oppositeHandle(handle: ResizeHandle): ResizeHandle {
  return OPPOSITE_HANDLE[handle]
}

export function sampleBounds(samples: Sample[]) {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity
  for (const s of samples) {
    const r = s.w + 1.5
    if (s.x - r < left) left = s.x - r
    if (s.x + r > right) right = s.x + r
    if (s.y - r < top) top = s.y - r
    if (s.y + r > bottom) bottom = s.y + r
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
}

// Layer-local rect -> page-space rect (bbox of the transformed corners).
export function layerRectToPage(
  layer: Pick<Layer, 'x' | 'y' | 'scale' | 'rotation'> | undefined,
  r: { x: number; y: number; w: number; h: number },
  pageW: number,
  pageH: number,
) {
  if (!layer) return r
  const angle = (layer.rotation * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity
  for (const [px, py] of [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ]) {
    const dx = px - pageW / 2
    const dy = py - pageH / 2
    const x = pageW / 2 + layer.x + (dx * cos - dy * sin) * layer.scale
    const y = pageH / 2 + layer.y + (dx * sin + dy * cos) * layer.scale
    if (x < left) left = x
    if (x > right) right = x
    if (y < top) top = y
    if (y > bottom) bottom = y
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
}

// Mirrored variants of live samples under the current symmetry mode.
export function mirroredSamples(
  samples: Sample[],
  symmetry: SymmetryMode,
  pageW: number,
  pageH: number,
): Sample[] {
  const sets: Sample[][] = []
  const mv = (s: Sample) => ({ ...s, x: pageW - s.x })
  const mh = (s: Sample) => ({ ...s, y: pageH - s.y })
  if (symmetry === 'v' || symmetry === 'xy') sets.push(samples.map(mv))
  if (symmetry === 'h' || symmetry === 'xy') sets.push(samples.map(mh))
  if (symmetry === 'xy') sets.push(samples.map((s) => mh(mv(s))))
  return sets.flat()
}
