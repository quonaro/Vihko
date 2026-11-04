import type { InkEngine, Layer, Page, PageOp, Stroke } from '../types'
import { PAGE_H, PAGE_W, pageSize } from '../pageSpace'
import { applyOp, applyPhoto, hexToRgb } from './ops'
import { newRenderCont, renderSamples } from './renderer'

interface RasterEntry {
  canvas: HTMLCanvasElement
  signature: unknown[]
}
const rasterCache = new Map<string, RasterEntry>()
const CACHE_LIMIT = 6

// Layer contents are rasterized once at a fixed resolution, independent of
// the view zoom: a key including the display scale used to re-replay every
// stroke on each zoom step (~29 MB per layer at high zoom, stuttering
// pinch). Zooming is then a scaled drawImage of the cached raster.
const LAYER_RASTER_W = 3072 // px, ≈ the page snapshot cap (3200)
const rasterH = (page: Page) => Math.round((LAYER_RASTER_W * pageSize(page).h) / pageSize(page).w)
const rasterScale = (page: Page) => LAYER_RASTER_W / pageSize(page).w

// Scratch canvases for clipping-mask compositing, sized per call.
let clipScratch: { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null
let clipBase: { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null
let alphaScratch: HTMLCanvasElement | null = null
let maskScratch: { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null

// Layer alpha masks live in a separate raster cache keyed like the content
// rasters: mask strokes (stroke.mask) replay into a raster that starts fully
// opaque; erasing in the mask hides content, painting reveals it.
const maskCache = new Map<string, RasterEntry>()

export function cutOpForLayer(
  op: Extract<PageOp, { kind: 'cut' }>,
  layer: Layer,
  size = { w: PAGE_W, h: PAGE_H },
): Extract<PageOp, { kind: 'cut' }> {
  const angle = (layer.rotation * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const scale = layer.scale || 1
  const toLocal = (point: { x: number; y: number }) => {
    const x = point.x - size.w / 2 - layer.x
    const y = point.y - size.h / 2 - layer.y
    return {
      x: size.w / 2 + (x * cos + y * sin) / scale,
      y: size.h / 2 + (-x * sin + y * cos) / scale,
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
  for (const key of maskCache.keys()) {
    if (!pageId || key.startsWith(`${pageId}|`)) maskCache.delete(key)
  }
}

// Ops that paint into a layer's local raster, in replay order. `ops` keeps
// the original op objects (cache-signature stable); `local` has cut paths
// remapped from page coordinates into the layer's current local space.
function layerLocalOps(page: Page, layer: Layer) {
  const ops = (page.ops ?? []).filter(
    (op) => op.layerId === '*' || (op.layerId ?? page.layers?.[0]?.id ?? 'legacy') === layer.id,
  )
  return {
    ops,
    local: ops.map((op) => (op.kind === 'cut' ? cutOpForLayer(op, layer, pageSize(page)) : op)),
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
  const layer = (
    page.layers?.length
      ? page.layers
      : [
          {
            id: 'legacy',
            name: 'Layer 1',
            visible: true,
            opacity: 1,
            x: 0,
            y: 0,
            scale: 1,
            rotation: 0,
          },
        ]
  ).find((item) => item.id === layerId)
  if (!layer) return null
  const raster = document.createElement('canvas')
  const sz = pageSize(page)
  raster.width = Math.max(1, Math.round(sz.w * scale))
  raster.height = Math.max(1, Math.round(sz.h * scale))
  const rc = raster.getContext('2d', { willReadFrequently: true })
  if (!rc) return undefined
  replayLayer(raster, rc, page, ink, layer, scale, layerLocalOps(page, layer).local)
  const { data, width, height } = rc.getImageData(0, 0, raster.width, raster.height)
  let left = width,
    top = height,
    right = -1,
    bottom = -1
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

// Optional rotation applied around (cx, cy) on top of the display transform —
// used when compositing layer rasters straight to a rotated view.
export interface DisplayRot {
  angle: number
  cx: number
  cy: number
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
  displayRot?: DisplayRot | null,
) {
  const layers = page.layers?.length
    ? page.layers
    : [
        {
          id: 'legacy',
          name: 'Layer 1',
          visible: true,
          opacity: 1,
          x: 0,
          y: 0,
          scale: 1,
          rotation: 0,
        },
      ]
  // The clip base: the nearest non-clipped visible layer below. Its alpha
  // mask (in target device px) is built lazily when a clipped layer needs it.
  let base: { raster: HTMLCanvasElement; state: Layer } | null = null
  let maskFor: HTMLCanvasElement | null = null
  let maskCanvas: HTMLCanvasElement | null = null
  for (const layer of layers) {
    const paintLayerState = overrides?.has(layer.id)
      ? { ...layer, ...overrides.get(layer.id) }
      : layer
    if (!paintLayerState.visible) {
      if (!paintLayerState.clip) base = null
      continue
    }
    let mask: HTMLCanvasElement | null = null
    if (paintLayerState.clip && base) {
      if (maskFor !== base.raster) {
        maskFor = base.raster
        maskCanvas = layerAlphaMask(
          target,
          base.raster,
          base.state,
          pageSize(page),
          displayScale,
          displayOx,
          displayOy,
          displayRot,
        )
      }
      mask = maskCanvas
    }
    const raster = paintLayer(
      target,
      ctx,
      page,
      ink,
      layer,
      paintLayerState,
      force,
      displayScale,
      displayOx,
      displayOy,
      mask,
      displayRot,
    )
    if (!paintLayerState.clip && raster) base = { raster, state: paintLayerState }
  }
}

// The clip base's alpha in target device px: the layer raster drawn with its
// transform and opacity into a scratch canvas.
function layerAlphaMask(
  target: HTMLCanvasElement,
  raster: HTMLCanvasElement,
  layer: Layer,
  size: { w: number; h: number },
  displayScale: number,
  displayOx: number,
  displayOy: number,
  displayRot?: DisplayRot | null,
): HTMLCanvasElement | null {
  if (!clipBase) {
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    clipBase = { c, ctx }
  }
  const { c, ctx } = clipBase
  if (c.width !== target.width || c.height !== target.height) {
    c.width = target.width
    c.height = target.height
  }
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.restore()
  drawLayerTransformed(ctx, raster, layer, size, displayScale, displayOx, displayOy, displayRot)
  return c
}

// Draw the layer raster (layer-local page units) with the layer transform.
function drawLayerTransformed(
  ctx: CanvasRenderingContext2D,
  raster: HTMLCanvasElement,
  layer: Layer,
  size: { w: number; h: number },
  displayScale: number,
  displayOx: number,
  displayOy: number,
  displayRot?: DisplayRot | null,
) {
  ctx.save()
  ctx.globalAlpha *= layer.opacity
  if (displayRot) {
    const { angle, cx, cy } = displayRot
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    // display = R(cx, cy, angle) ∘ (scale + offset)
    ctx.setTransform(
      displayScale * cos,
      displayScale * sin,
      -displayScale * sin,
      displayScale * cos,
      cos * (displayOx - cx) - sin * (displayOy - cy) + cx,
      sin * (displayOx - cx) + cos * (displayOy - cy) + cy,
    )
  } else {
    ctx.setTransform(displayScale, 0, 0, displayScale, displayOx, displayOy)
  }
  ctx.translate(size.w / 2 + layer.x, size.h / 2 + layer.y)
  ctx.rotate((layer.rotation * Math.PI) / 180)
  ctx.scale(layer.scale, layer.scale)
  ctx.translate(-size.w / 2, -size.h / 2)
  ctx.drawImage(raster, 0, 0, size.w, size.h)
  ctx.restore()
}

// Paint one layer; returns its cached raster (null where 2D is unavailable)
// so the caller can build the clip mask for layers above. `mask` is the clip
// base's alpha in target device px — required when the layer is clipped; a
// clipped layer with no base below renders nothing.
function paintLayer(
  target: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  page: Page,
  ink: InkEngine,
  layer: Layer,
  paintLayerState: Layer,
  force: boolean,
  displayScale: number,
  displayOx: number,
  displayOy: number,
  mask: HTMLCanvasElement | null,
  displayRot?: DisplayRot | null,
): HTMLCanvasElement | null {
  const { local: layerOps } = layerLocalOps(page, layer)

  // Canvas mocks in jsdom cannot composite cached layer rasters.
  if (
    typeof ctx.translate !== 'function' ||
    typeof ctx.rotate !== 'function' ||
    typeof ctx.scale !== 'function'
  ) {
    let opIdx = 0
    const drainOps = (after: number) => {
      while (opIdx < layerOps.length && layerOps[opIdx].after <= after) {
        applyOp(target, ctx, layerOps[opIdx], displayScale, displayOx, displayOy, ink)
        opIdx++
      }
    }
    page.strokes.forEach((stroke, index) => {
      drainOps(index)
      if (stroke.mask) return
      if ((stroke.layerId ?? page.layers?.[0]?.id ?? 'legacy') !== layer.id) return
      const id = ink.begin(stroke.tool, stroke.size ?? 1, stroke.stab ?? -1)
      ctx.save()
      ctx.setTransform(displayScale, 0, 0, displayScale, displayOx, displayOy)
      const cont = newRenderCont()
      for (const pt of stroke.pts)
        renderSamples(
          ctx,
          stroke.tool,
          stroke.color,
          ink.addPoint(id, pt.x, pt.y, pt.t, pt.p),
          index + 1,
          stroke.size ?? 1,
          stroke,
          cont,
        )
      renderSamples(
        ctx,
        stroke.tool,
        stroke.color,
        ink.end(id),
        index + 1,
        stroke.size ?? 1,
        stroke,
        cont,
      )
      ctx.restore()
    })
    drainOps(page.strokes.length)
    return null
  }

  const entry = ensureLayerRaster(page, ink, layer, force)
  if (!entry) return null

  // Alpha mask (destination-in with the mask raster) applies in raster space
  // before any layer transform or clipping.
  const content = paintLayerState.mask ? maskedRaster(page, ink, layer, entry.canvas) : entry.canvas

  // A clipped layer paints into a scratch, gets masked by the clip base's
  // alpha via destination-in, and is then composited with its blend mode.
  // With no visible non-clipped layer below it composites normally.
  if (paintLayerState.clip && mask) {
    const scratch = clipCtx(target)
    if (!scratch) {
      compositeLayer(
        ctx,
        content,
        paintLayerState,
        pageSize(page),
        displayScale,
        displayOx,
        displayOy,
        displayRot,
      )
      return entry.canvas
    }
    scratch.save()
    scratch.setTransform(1, 0, 0, 1, 0, 0)
    scratch.clearRect(0, 0, target.width, target.height)
    scratch.restore()
    drawLayerTransformed(
      scratch,
      content,
      paintLayerState,
      pageSize(page),
      displayScale,
      displayOx,
      displayOy,
      displayRot,
    )
    scratch.save()
    scratch.setTransform(1, 0, 0, 1, 0, 0)
    scratch.globalCompositeOperation = 'destination-in'
    scratch.drawImage(mask, 0, 0)
    scratch.restore()
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (paintLayerState.blend) ctx.globalCompositeOperation = paintLayerState.blend
    ctx.drawImage(clipScratch!.c, 0, 0)
    ctx.restore()
    return entry.canvas
  }

  compositeLayer(
    ctx,
    content,
    paintLayerState,
    pageSize(page),
    displayScale,
    displayOx,
    displayOy,
    displayRot,
  )
  return entry.canvas
}

// Straightforward layer composite: transform + opacity + blend mode.
function compositeLayer(
  ctx: CanvasRenderingContext2D,
  raster: HTMLCanvasElement,
  layer: Layer,
  size: { w: number; h: number },
  displayScale: number,
  displayOx: number,
  displayOy: number,
  displayRot?: DisplayRot | null,
) {
  ctx.save()
  if (layer.blend) ctx.globalCompositeOperation = layer.blend
  drawLayerTransformed(ctx, raster, layer, size, displayScale, displayOx, displayOy, displayRot)
  ctx.restore()
}

// 2d scratch for clipped-layer compositing, sized to the target.
function clipCtx(target: HTMLCanvasElement): CanvasRenderingContext2D | null {
  if (!clipScratch) {
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    clipScratch = { c, ctx }
  }
  const { c, ctx } = clipScratch
  if (c.width !== target.width || c.height !== target.height) {
    c.width = target.width
    c.height = target.height
  }
  return ctx
}

// Cached fixed-resolution raster of a layer's contents (strokes + ops in
// layer-local space). Keyed by page+layer only — zoom never re-rasterizes.
function ensureLayerRaster(
  page: Page,
  ink: InkEngine,
  layer: Layer,
  force: boolean,
): RasterEntry | null {
  const { ops, local: layerOps } = layerLocalOps(page, layer)
  const strokes = page.strokes.filter(
    (stroke) => !stroke.mask && (stroke.layerId ?? page.layers?.[0]?.id ?? 'legacy') === layer.id,
  )
  const key = `${page.id}|${layer.id}`
  // Layer transforms are applied while compositing the raster, not while
  // painting its contents. Cut selections are stored in page coordinates,
  // however, so their layer-local raster changes with the layer transform.
  const hasCutOps = layerOps.some((op) => op.kind === 'cut')
  const signature = hasCutOps
    ? [...strokes, ...ops, layer.x, layer.y, layer.scale, layer.rotation]
    : [...strokes, ...ops]
  let entry = rasterCache.get(key)
  const oldSignature = entry?.signature
  const cacheHit =
    !force &&
    !!entry &&
    !!oldSignature &&
    oldSignature.length === signature.length &&
    signature.every((item, i) => item === oldSignature[i])
  if (cacheHit) {
    rasterCache.delete(key)
    rasterCache.set(key, entry!)
    return entry!
  }
  // Fast path for appended content: when the cached signature is a strict
  // prefix of the new one, only the new tail entries need painting — a full
  // replay re-renders every stroke of the layer on each commit.
  const extending =
    !force &&
    !!entry &&
    !!oldSignature &&
    !hasCutOps &&
    signature.length > oldSignature.length &&
    oldSignature.every((item, i) => signature[i] === item)
  if (extending && entry) {
    const rc = entry.canvas.getContext('2d', { willReadFrequently: true })
    if (rc) {
      const scale = rasterScale(page)
      for (const item of signature.slice(oldSignature!.length)) {
        if (typeof (item as PageOp).kind === 'string') {
          const op = item as PageOp
          if (op.alphaLock && (op.kind === 'fill' || op.kind === 'photo'))
            applyAlphaLockedOp(entry.canvas, rc, op, scale, ink)
          else applyOp(entry.canvas, rc, op, scale, 0, 0, ink)
        } else {
          replayStroke(entry.canvas, rc, page, ink, item as Stroke, scale)
        }
      }
      entry = { canvas: entry.canvas, signature }
      rasterCache.delete(key)
      rasterCache.set(key, entry)
      return entry
    }
  }
  const raster = entry?.canvas ?? document.createElement('canvas')
  raster.width = LAYER_RASTER_W
  raster.height = rasterH(page)
  const rc = raster.getContext('2d', { willReadFrequently: true })
  if (!rc) return null
  rc.setTransform(1, 0, 0, 1, 0, 0)
  rc.clearRect(0, 0, raster.width, raster.height)
  replayLayer(raster, rc, page, ink, layer, rasterScale(page), layerOps)
  entry = { canvas: raster, signature }
  rasterCache.delete(key)
  rasterCache.set(key, entry)
  while (rasterCache.size > CACHE_LIMIT) {
    const oldest = rasterCache.keys().next().value
    if (oldest === undefined) break
    rasterCache.delete(oldest)
  }
  return entry
}

// Mask strokes of a layer (stroke.mask painted while maskEdit was on).
function layerMaskStrokes(page: Page, layer: Layer) {
  return page.strokes.filter(
    (stroke) => stroke.mask && (stroke.layerId ?? page.layers?.[0]?.id ?? 'legacy') === layer.id,
  )
}

// Fixed-resolution alpha mask raster of a layer: starts fully opaque (reveal
// all); non-eraser mask strokes keep alpha, the eraser removes it (hide).
// Only strokes are editable — raster ops don't apply to masks.
function ensureLayerMask(page: Page, ink: InkEngine, layer: Layer): RasterEntry | null {
  const strokes = layerMaskStrokes(page, layer)
  const key = `${page.id}|${layer.id}`
  const signature = [...strokes]
  let entry = maskCache.get(key)
  const oldSignature = entry?.signature
  const cacheHit =
    !!entry &&
    !!oldSignature &&
    oldSignature.length === signature.length &&
    signature.every((item, i) => item === oldSignature[i])
  if (cacheHit) return entry!
  const raster = entry?.canvas ?? document.createElement('canvas')
  raster.width = LAYER_RASTER_W
  raster.height = rasterH(page)
  const rc = raster.getContext('2d', { willReadFrequently: true })
  if (!rc) return null
  rc.setTransform(1, 0, 0, 1, 0, 0)
  rc.clearRect(0, 0, raster.width, raster.height)
  rc.fillStyle = '#fff'
  rc.fillRect(0, 0, raster.width, raster.height)
  const scale = rasterScale(page)
  for (const stroke of strokes) {
    const id = ink.begin(stroke.tool, stroke.size ?? 1, stroke.stab ?? -1)
    rc.save()
    rc.setTransform(scale, 0, 0, scale, 0, 0)
    const cont = newRenderCont()
    for (const pt of stroke.pts)
      renderSamples(
        rc,
        stroke.tool,
        '#fff',
        ink.addPoint(id, pt.x, pt.y, pt.t, pt.p),
        1,
        stroke.size ?? 1,
        stroke,
        cont,
      )
    renderSamples(rc, stroke.tool, '#fff', ink.end(id), 1, stroke.size ?? 1, stroke, cont)
    rc.restore()
  }
  entry = { canvas: raster, signature }
  maskCache.set(key, entry)
  return entry
}

// The layer raster masked by its alpha mask (raster space). Returns the
// unmasked raster when the layer has no mask.
function maskedRaster(page: Page, ink: InkEngine, layer: Layer, raster: HTMLCanvasElement) {
  const maskEntry = ensureLayerMask(page, ink, layer)
  if (!maskEntry) return raster
  if (!maskScratch) {
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return raster
    maskScratch = { c, ctx }
  }
  const { c, ctx } = maskScratch
  if (c.width !== raster.width || c.height !== raster.height) {
    c.width = raster.width
    c.height = raster.height
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.drawImage(raster, 0, 0)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(maskEntry.canvas, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  return c
}

// The cached content raster of a layer (fixed resolution, layer-local space)
// — used for layer thumbnails and the live alpha-lock mask.
export function layerRasterCanvas(
  page: Page,
  ink: InkEngine,
  layerId: string,
): HTMLCanvasElement | null {
  const layer = (
    page.layers?.length
      ? page.layers
      : [
          {
            id: 'legacy',
            name: 'Layer 1',
            visible: true,
            opacity: 1,
            x: 0,
            y: 0,
            scale: 1,
            rotation: 0,
          },
        ]
  ).find((item) => item.id === layerId)
  if (!layer) return null
  return ensureLayerRaster(page, ink, layer, false)?.canvas ?? null
}

// The cached alpha-mask raster of a layer — the live eraser preview in
// mask-edit mode erases into it like the content raster.
export function layerMaskRasterCanvas(
  page: Page,
  ink: InkEngine,
  layerId: string,
): HTMLCanvasElement | null {
  const layer = page.layers?.find((item) => item.id === layerId)
  if (!layer) return null
  return ensureLayerMask(page, ink, layer)?.canvas ?? null
}

// An op committed under alpha lock can't grow the layer's alpha: photos
// composite source-atop; fills (which write pixels directly) are masked back
// to the pre-fill alpha afterwards.
function applyAlphaLockedOp(
  raster: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  op: Extract<PageOp, { kind: 'fill' | 'photo' }>,
  scale: number,
  ink: InkEngine,
) {
  if (op.kind === 'photo') {
    ctx.save()
    ctx.globalCompositeOperation = 'source-atop'
    applyPhoto(ctx, op.photo, scale, 0, 0)
    ctx.restore()
    return
  }
  if (!alphaScratch) alphaScratch = document.createElement('canvas')
  const alpha = alphaScratch
  alpha.width = raster.width
  alpha.height = raster.height
  const ac = alpha.getContext('2d', { willReadFrequently: true })
  if (!ac) {
    applyOp(raster, ctx, op, scale, 0, 0, ink)
    return
  }
  ac.drawImage(raster, 0, 0)
  applyOp(raster, ctx, op, scale, 0, 0, ink)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(alpha, 0, 0)
  ctx.restore()
}

// Replay one stroke into a layer raster (layer-local page units at `scale`).
// Used by both the full layer replay and the appended-tail fast path.
function replayStroke(
  raster: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  page: Page,
  ink: InkEngine,
  stroke: Stroke,
  scale: number,
) {
  const index = page.strokes.indexOf(stroke)
  const id = ink.begin(stroke.tool, stroke.size ?? 1, stroke.stab ?? -1)
  // Watercolor strokes with a wet pickup replay as pixel smudging over the
  // raster (the WASM wetStroke kernel); alpha-locked or wet=0 strokes keep
  // the gradient painter so alpha stays confined.
  if (
    stroke.tool === 'color' &&
    !stroke.alphaLock &&
    ink.wetStroke &&
    (stroke.wet ?? 0) > 0 &&
    typeof ctx.getImageData === 'function'
  ) {
    const dabs: number[] = []
    for (const pt of stroke.pts)
      for (const s of ink.addPoint(id, pt.x, pt.y, pt.t, pt.p)) dabs.push(s.x, s.y, s.w, s.a)
    for (const s of ink.end(id)) dabs.push(s.x, s.y, s.w, s.a)
    wetStrokeDabs(raster, ctx, dabs, stroke.color, scale, ink, stroke.wet ?? 0.6)
    return
  }
  ctx.save()
  // source-atop confines locked strokes to the layer's existing alpha. The
  // eraser is never locked (destination-out already can't add alpha).
  if (stroke.alphaLock && stroke.tool !== 'eraser') ctx.globalCompositeOperation = 'source-atop'
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  const cont = newRenderCont()
  for (const pt of stroke.pts)
    renderSamples(
      ctx,
      stroke.tool,
      stroke.color,
      ink.addPoint(id, pt.x, pt.y, pt.t, pt.p),
      index + 1,
      stroke.size ?? 1,
      stroke,
      cont,
    )
  renderSamples(
    ctx,
    stroke.tool,
    stroke.color,
    ink.end(id),
    index + 1,
    stroke.size ?? 1,
    stroke,
    cont,
  )
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
      const op = ops[opIdx]
      if (op.alphaLock && (op.kind === 'fill' || op.kind === 'photo'))
        applyAlphaLockedOp(raster, ctx, op, scale, ink)
      else applyOp(raster, ctx, op, scale, 0, 0, ink)
      opIdx++
    }
  }
  page.strokes.forEach((stroke, index) => {
    drainOps(index)
    if (stroke.mask) return // mask strokes paint into ensureLayerMask, not content
    if ((stroke.layerId ?? page.layers?.[0]?.id ?? 'legacy') !== layer.id) return
    replayStroke(raster, ctx, page, ink, stroke, scale)
  })
  drainOps(page.strokes.length)
}

// Wet-mixing replay: crop the raster to the stroke bbox, convert dabs into
// crop pixels, run the engine kernel, and put the pixels back.
function wetStrokeDabs(
  raster: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  dabs: number[],
  color: string,
  scale: number,
  ink: InkEngine,
  pickup: number,
) {
  const n = (dabs.length / 4) | 0
  if (!n || !ink.wetStroke) return
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < n; i++) {
    const x = dabs[i * 4] * scale
    const y = dabs[i * 4 + 1] * scale
    const r = dabs[i * 4 + 2] * scale * 2 + 4
    x0 = Math.min(x0, x - r)
    y0 = Math.min(y0, y - r)
    x1 = Math.max(x1, x + r)
    y1 = Math.max(y1, y + r)
  }
  const bx = Math.max(0, Math.floor(x0))
  const by = Math.max(0, Math.floor(y0))
  const bw = Math.min(raster.width, Math.ceil(x1)) - bx
  const bh = Math.min(raster.height, Math.ceil(y1)) - by
  if (bw <= 0 || bh <= 0) return
  const img = ctx.getImageData(bx, by, bw, bh)
  const sub: number[] = new Array(dabs.length)
  for (let i = 0; i < n; i++) {
    sub[i * 4] = dabs[i * 4] * scale - bx
    sub[i * 4 + 1] = dabs[i * 4 + 1] * scale - by
    sub[i * 4 + 2] = dabs[i * 4 + 2] * scale
    sub[i * 4 + 3] = dabs[i * 4 + 3]
  }
  const [r, g, b] = hexToRgb(color)
  ink.wetStroke(img.data, bw, bh, sub, r, g, b, pickup)
  ctx.putImageData(img, bx, by)
}
