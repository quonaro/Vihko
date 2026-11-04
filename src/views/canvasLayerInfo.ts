import { layerContentBounds, layerRasterCanvas } from '../ink/layers'
import { imageDataURL } from '../ink/ops'
import type { InkEngine, Page } from '../types'
import type { LayerBounds } from './canvasMath'

const THUMB_W = 56
const THUMB_H = 36

export function getLayerBounds(
  page: Page,
  ink: InkEngine | null,
  layerId: string,
  boundsScale: number,
  pageW: number,
  pageH: number,
): LayerBounds | null {
  if (ink) {
    // Exact bounds of the rendered layer; the point-padding heuristic below
    // is only a fallback for environments without a canvas backend (jsdom).
    const bounds = layerContentBounds(page, ink, layerId, boundsScale)
    if (bounds !== undefined) return bounds
  }
  const defaultId = page.layers?.[0]?.id ?? 'legacy'
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity
  const include = (x: number, y: number, pad = 0) => {
    left = Math.min(left, x - pad)
    top = Math.min(top, y - pad)
    right = Math.max(right, x + pad)
    bottom = Math.max(bottom, y + pad)
  }
  for (const stroke of page.strokes) {
    if ((stroke.layerId ?? defaultId) !== layerId) continue
    const pad =
      (stroke.tool === 'color' ? 50 : stroke.tool === 'eraser' ? 30 : 15) * (stroke.size ?? 1)
    for (const point of stroke.pts) include(point.x, point.y, pad)
  }
  for (const op of page.ops ?? []) {
    if (op.layerId !== '*' && (op.layerId ?? defaultId) !== layerId) continue
    if (op.kind === 'fill') {
      include(0, 0)
      include(pageW, pageH)
    } else if (op.kind === 'photo') {
      include(op.photo.x, op.photo.y)
      include(op.photo.x + op.photo.w, op.photo.y + op.photo.h)
    } else if (op.kind === 'cut') {
      for (const point of op.path) {
        include(point.x, point.y)
        include(point.x + op.dx, point.y + op.dy)
      }
    }
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : null
}

export function buildLayerThumb(
  page: Page | null,
  ink: InkEngine | null,
  layerId: string,
  boundsScale: number,
  pageW: number,
): string | null {
  if (!page || !ink) return null
  const bounds = layerContentBounds(page, ink, layerId, boundsScale)
  if (!bounds) return null
  const raster = layerRasterCanvas(page, ink, layerId)
  if (!raster) return null
  const c = document.createElement('canvas')
  c.width = THUMB_W
  c.height = THUMB_H
  const tc = c.getContext('2d')
  if (!tc || typeof c.toDataURL !== 'function') return null
  const rs = raster.width / pageW
  const pad = 4 / boundsScale
  const sw = Math.max(1, bounds.right - bounds.left + pad * 2)
  const sh = Math.max(1, bounds.bottom - bounds.top + pad * 2)
  const sx = (bounds.left - pad) * rs
  const sy = (bounds.top - pad) * rs
  const k = Math.min(THUMB_W / (sw * rs), THUMB_H / (sh * rs))
  const dw = sw * rs * k
  const dh = sh * rs * k
  tc.drawImage(raster, sx, sy, sw * rs, sh * rs, (THUMB_W - dw) / 2, (THUMB_H - dh) / 2, dw, dh)
  return imageDataURL(c, true)
}
