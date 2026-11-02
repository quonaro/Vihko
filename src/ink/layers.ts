import type { InkEngine, Layer, Page, PageOp } from '../types'
import { PAGE_H, PAGE_W } from '../pageSpace'
import { applyOp } from './ops'
import { renderSamples } from './renderer'

interface RasterEntry {
  canvas: HTMLCanvasElement
  signature: unknown[]
}
const rasterCache = new Map<string, RasterEntry>()
const CACHE_LIMIT = 8

export function cutOpForLayer(
  op: Extract<PageOp, { kind: 'cut' }>,
  layer: Layer,
): Extract<PageOp, { kind: 'cut' }> {
  const angle = (layer.rotation * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const scale = layer.scale || 1
  const toLocal = (point: { x: number; y: number }) => {
    const x = point.x - PAGE_W / 2 - layer.x
    const y = point.y - PAGE_H / 2 - layer.y
    return {
      x: PAGE_W / 2 + (x * cos + y * sin) / scale,
      y: PAGE_H / 2 + (-x * sin + y * cos) / scale,
    }
  }
  return {
    ...op,
    path: op.path.map(toLocal),
    dx: (op.dx * cos + op.dy * sin) / scale,
    dy: (-op.dx * sin + op.dy * cos) / scale,
  }
}

export function clearLayerRasterCache(pageId?: string) {
  for (const key of rasterCache.keys()) {
    if (!pageId || key.startsWith(`${pageId}|`)) rasterCache.delete(key)
  }
}

// Ops that paint into a layer's local raster, in replay order. `ops` keeps
// the original op objects (cache-signature stable); `local` has cut paths
// remapped from page coordinates into the layer's current local space.
function layerLocalOps(page: Page, layer: Layer) {
  const ops = (page.ops ?? []).filter((op) =>
    op.layerId === '*' || (op.layerId ?? page.layers?.[0]?.id ?? 'legacy') === layer.id,
  )
  return {
    ops,
    local: ops.map((op) => (op.kind === 'cut' ? cutOpForLayer(op, layer) : op)),
  }
}

export interface LayerContentBounds {
  left: number
  top: number
  right: number
  bottom: number
}

// Tight alpha bounds of a layer's rendered content in layer-local page
// units — what the transform frame should wrap. Returns undefined when no
// canvas backend exists (jsdom) and null when the layer renders nothing.
export function layerContentBounds(
  page: Page,
  ink: InkEngine,
  layerId: string,
  scale: number,
): LayerContentBounds | null | undefined {
  const layer = (page.layers?.length
    ? page.layers
    : [{ id: 'legacy', name: 'Layer 1', visible: true, opacity: 1, x: 0, y: 0, scale: 1, rotation: 0 }]
  ).find((item) => item.id === layerId)
  if (!layer) return null
  const raster = document.createElement('canvas')
  raster.width = Math.max(1, Math.round(PAGE_W * scale))
  raster.height = Math.max(1, Math.round(PAGE_H * scale))
  const rc = raster.getContext('2d', { willReadFrequently: true })
  if (!rc) return undefined
  replayLayer(raster, rc, page, ink, layer, scale, layerLocalOps(page, layer).local)
  const { data, width, height } = rc.getImageData(0, 0, raster.width, raster.height)
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (data[(row + x) * 4 + 3] <= 8) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      bottom = y
    }
  }
  if (right < 0) return null
  return {
    left: left / scale,
    top: top / scale,
    right: (right + 1) / scale,
    bottom: (bottom + 1) / scale,
  }
}

export function paintLayers(
  target: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  page: Page,
  ink: InkEngine,
  scale: number,
  ox = 0,
  oy = 0,
  force = false,
  displayScale = scale,
  displayOx = ox,
  displayOy = oy,
  overrides?: Map<string, Partial<Layer>>,
) {
  const layers = page.layers?.length
    ? page.layers
    : [{ id: 'legacy', name: 'Layer 1', visible: true, opacity: 1, x: 0, y: 0, scale: 1, rotation: 0 }]
  for (const layer of layers) {
    if (!layer.visible) continue
    const paintLayerState = overrides?.has(layer.id)
      ? { ...layer, ...overrides.get(layer.id) }
      : layer
    paintLayer(target, ctx, page, ink, layer, paintLayerState, scale, ox, oy, force, displayScale, displayOx, displayOy)
  }
}

function paintLayer(
  target: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  page: Page,
  ink: InkEngine,
  layer: Layer,
  paintLayerState: Layer,
  scale: number,
  ox: number,
  oy: number,
  force: boolean,
  displayScale: number,
  displayOx: number,
  displayOy: number,
) {
  const { ops, local: layerOps } = layerLocalOps(page, layer)
  const strokes = page.strokes.filter((stroke) =>
    (stroke.layerId ?? page.layers?.[0]?.id ?? 'legacy') === layer.id,
  )

  // Canvas mocks in jsdom cannot composite cached layer rasters.
  if (typeof ctx.translate !== 'function' || typeof ctx.rotate !== 'function' || typeof ctx.scale !== 'function') {
    let opIdx = 0
    const drainOps = (after: number) => {
      while (opIdx < layerOps.length && layerOps[opIdx].after <= after) {
        applyOp(target, ctx, layerOps[opIdx], displayScale, displayOx, displayOy)
        opIdx++
      }
    }
    page.strokes.forEach((stroke, index) => {
      drainOps(index)
      if ((stroke.layerId ?? page.layers?.[0]?.id ?? 'legacy') !== layer.id) return
      const id = ink.begin(stroke.tool)
      ctx.save()
      ctx.setTransform(displayScale, 0, 0, displayScale, displayOx, displayOy)
      for (const pt of stroke.pts)
        renderSamples(ctx, stroke.tool, stroke.color, ink.addPoint(id, pt.x, pt.y, pt.t, pt.p), index + 1, stroke.size ?? 1)
      renderSamples(ctx, stroke.tool, stroke.color, ink.end(id), index + 1, stroke.size ?? 1)
      ctx.restore()
    })
    drainOps(page.strokes.length)
    return
  }

  const key = `${page.id}|${layer.id}|${scale}`
  // Layer transforms are applied while compositing the raster, not while
  // painting its contents. Cut selections are stored in page coordinates,
  // however, so their layer-local raster changes with the layer transform.
  const hasCutOps = layerOps.some((op) => op.kind === 'cut')
  const signature = hasCutOps
    ? [...strokes, ...ops, layer.x, layer.y, layer.scale, layer.rotation]
    : [...strokes, ...ops]
  let entry = rasterCache.get(key)
  const oldSignature = entry?.signature
  const cacheHit = !force && !!entry && !!oldSignature &&
    oldSignature.length === signature.length &&
    signature.every((item, i) => item === oldSignature[i])
  if (!cacheHit) {
    const raster = entry?.canvas ?? document.createElement('canvas')
    raster.width = Math.max(1, Math.round(PAGE_W * scale))
    raster.height = Math.max(1, Math.round(PAGE_H * scale))
    const rc = raster.getContext('2d', { willReadFrequently: true })
    if (!rc) return
    rc.setTransform(1, 0, 0, 1, 0, 0)
    rc.clearRect(0, 0, raster.width, raster.height)
    replayLayer(raster, rc, page, ink, layer, scale, layerOps)
    entry = { canvas: raster, signature }
    rasterCache.delete(key)
    rasterCache.set(key, entry)
    while (rasterCache.size > CACHE_LIMIT) {
      const oldest = rasterCache.keys().next().value
      if (oldest === undefined) break
      rasterCache.delete(oldest)
    }
  } else {
    rasterCache.delete(key)
    rasterCache.set(key, entry!)
  }

  ctx.save()
  ctx.globalAlpha *= paintLayerState.opacity
  ctx.setTransform(displayScale, 0, 0, displayScale, displayOx, displayOy)
  ctx.translate(PAGE_W / 2 + paintLayerState.x, PAGE_H / 2 + paintLayerState.y)
  ctx.rotate((paintLayerState.rotation * Math.PI) / 180)
  ctx.scale(paintLayerState.scale, paintLayerState.scale)
  ctx.translate(-PAGE_W / 2, -PAGE_H / 2)
  ctx.drawImage(entry!.canvas, 0, 0, PAGE_W, PAGE_H)
  ctx.restore()
}

function replayLayer(
  raster: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  page: Page,
  ink: InkEngine,
  layer: Layer,
  scale: number,
  ops: NonNullable<Page['ops']>,
) {
  let opIdx = 0
  const drainOps = (after: number) => {
    while (opIdx < ops.length && ops[opIdx].after <= after) {
      applyOp(raster, ctx, ops[opIdx], scale)
      opIdx++
    }
  }
  page.strokes.forEach((stroke, index) => {
    drainOps(index)
    if ((stroke.layerId ?? page.layers?.[0]?.id ?? 'legacy') !== layer.id) return
    const id = ink.begin(stroke.tool)
    ctx.save()
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    for (const pt of stroke.pts)
      renderSamples(ctx, stroke.tool, stroke.color, ink.addPoint(id, pt.x, pt.y, pt.t, pt.p), index + 1, stroke.size ?? 1)
    renderSamples(ctx, stroke.tool, stroke.color, ink.end(id), index + 1, stroke.size ?? 1)
    ctx.restore()
  })
  drainOps(page.strokes.length)
}
