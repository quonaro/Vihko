import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  store,
  currentPage,
  currentJournal,
  brushOf,
  brushSnapshot,
  snapToGuide,
  mirroredPtSets,
  pushStroke,
  pushOp,
  undoStroke,
  redoStroke,
  navPage,
  closeToJournal,
  canUndo,
  canRedo,
  pageLayers,
  activeLayer,
  updateLayer,
} from '../store'
import { initInk } from '../ink/engine'
import { renderSamples } from '../ink/renderer'
import { clearLayerRasterCache, layerRasterCanvas, paintLayers } from '../ink/layers'
import { extractRegion, onImageLoaded, imageFileToPhoto } from '../ink/ops'
import { rdp } from '../ink/path'
import { shapePoints } from '../ink/shapes'
import { pageSize, coverViewport, clampOffset } from '../pageSpace'
import { INK_TOOLS } from '../ink/tools'
import {
  buildTransformFrame,
  cursorForHandle,
  hitTransformControl,
  layerPoint,
  layerRectToPage as layerRectToPageMath,
  mirroredSamples,
  oppositeHandle,
  sampleBounds,
} from '../views/canvasMath'
import type { LayerBounds, LayerPoint, TransformHandle } from '../views/canvasMath'
import { buildLayerThumb, getLayerBounds as findLayerBounds } from '../views/canvasLayerInfo'
import type {
  GuideMode,
  InkEngine,
  Layer,
  Page,
  Pt,
  Sample,
  ShapeKind,
  Stroke,
  SymmetryMode,
  ToolId,
} from '../types'

export function useCanvasView() {
  const PAPER = '#f6f1e6'
  const BACKDROP = '#2a2a2c'
  const EDGE = 34 // px edge zone for page-swipe nav
  const TRAY_HEIGHT = 86
  const canvas = ref<HTMLCanvasElement>()
  const navClass = ref<'' | 'from-right' | 'from-left'>('')
  const journal = computed(() => currentJournal())
  const pageIndex = computed(() => {
    const j = journal.value,
      p = currentPage()
    return j && p ? j.pages.findIndex((x) => x.id === p.id) : 0
  })

  let ctx: CanvasRenderingContext2D | null = null
  let ink: InkEngine | null = null
  let dpr = 1

  // --- viewport: the screen is a window onto a fixed page-unit sheet ---
  // Cover fit keeps the sheet filling the canvas at zoom 1; on aspect-mismatched
  // screens it overflows one axis. The move tool pans, the +/- buttons zoom
  // around the viewport center, and each page remembers its own view.
  const ZOOM_STEP = 1.4
  const ZOOM_MAX = 5 // scale relative to cover fit
  const ZOOM_MARGIN = 0.5 // zoom-out stops at half-size contain fit
  const view = { s: 1, ox: 0, oy: 0 }
  const zoom = ref(1)
  const isFit = ref(true)
  const viewSize = ref({ w: 0, h: 0 })
  const views = new Map<string, { zoom: number; fx: number; fy: number }>() // per-page
  let panStart: { x: number; y: number } | null = null
  const layerPanelOpen = ref(false)
  const selectedLayer = computed(() => activeLayer())

  // Layer thumbnails in the panel: dataURLs of each layer's cached raster
  // cropped to its content bounds (full-page thumbs lose thin strokes at
  // this size), rebuilt whenever page content changes (thumbRev bumps in
  // the watchers).
  const thumbRev = ref(0)
  const thumbCache = new Map<string, string>()

  function layerThumb(id: string): string {
    const key = `${thumbRev.value}|${id}`
    const hit = thumbCache.get(key)
    if (hit !== undefined) return hit
    const url = buildThumb(id) ?? ''
    thumbCache.set(key, url)
    if (thumbCache.size > 48) thumbCache.clear()
    return url
  }

  function buildThumb(id: string): string | null {
    return buildLayerThumb(currentPage(), ink, id, BOUNDS_SCALE, pw())
  }

  const layerPreview = ref<{
    id: string
    x: number
    y: number
    scale: number
    rotation: number
  } | null>(null)
  const brushSize = computed(() => brushOf(store.tool).size)
  const brushProgress = computed(() => Math.min(1, Math.max(0, (brushSize.value - 0.25) / 3.75)))
  const brushMarkWidth = computed(() => `${Math.min(20, 7 + brushSize.value * 3)}px`)

  const toPageX = (x: number) => (x - view.ox) / view.s
  const toPageY = (y: number) => (y - view.oy) / view.s
  // Current page's size in page units (custom sizes come from page.w/h).
  const pw = () => pageSize(currentPage()).w
  const ph = () => pageSize(currentPage()).h
  function toLayerPt(pt: Pt, layerId: string): Pt {
    const pagePt = { ...pt, x: toPageX(pt.x), y: toPageY(pt.y) }
    const layer = pageLayers().find((item) => item.id === layerId)
    if (!layer || layer.scale === 0) return pagePt

    // Strokes are stored in layer-local coordinates and transformed when painted.
    const angle = (layer.rotation * Math.PI) / 180
    const dx = pagePt.x - pw() / 2 - layer.x
    const dy = pagePt.y - ph() / 2 - layer.y
    return {
      ...pagePt,
      x: pw() / 2 + (dx * Math.cos(angle) + dy * Math.sin(angle)) / layer.scale,
      y: ph() / 2 + (-dx * Math.sin(angle) + dy * Math.cos(angle)) / layer.scale,
    }
  }

  // Saved offsets are fractions of the pannable range so they survive resizes;
  // 0.5 = centered, which is also what a fitting sheet gets from clampOffset.
  const frac = (o: number, css: number, sheet: number) => (sheet > css ? o / (css - sheet) : 0.5)
  const unfrac = (f: number, css: number, sheet: number) =>
    sheet > css ? f * (css - sheet) : (css - sheet) / 2

  function applyViewport() {
    const { w, h } = canvasSize()
    viewSize.value = { w, h }
    const cover = coverViewport(w, h, pageSize(currentPage()))
    const saved = views.get(store.pageId ?? '')
    view.s = cover.s * (saved?.zoom ?? 1)
    const c = clampOffset(
      saved ? unfrac(saved.fx, w, pw() * view.s) : cover.ox,
      saved ? unfrac(saved.fy, h, ph() * view.s) : cover.oy,
      view.s,
      w,
      h,
      pageSize(currentPage()),
    )
    view.ox = c.ox
    view.oy = c.oy
    syncViewUI()
  }

  function syncViewUI() {
    const { w, h } = canvasSize()
    const cover = coverViewport(w, h, pageSize(currentPage()))
    zoom.value = cover.s ? view.s / cover.s : 1
    isFit.value =
      Math.abs(view.s - cover.s) < 1e-4 &&
      Math.abs(view.ox - cover.ox) < 0.5 &&
      Math.abs(view.oy - cover.oy) < 0.5
  }

  function saveView() {
    const { w, h } = canvasSize()
    views.set(store.pageId ?? '', {
      zoom: zoom.value,
      fx: frac(view.ox, w, pw() * view.s),
      fy: frac(view.oy, h, ph() * view.s),
    })
  }

  function zoomBy(f: number) {
    const { w, h } = canvasSize()
    if (!w || !h) return
    const cover = coverViewport(w, h, pageSize(currentPage()))
    const minS = Math.min(w / pw(), h / ph()) * ZOOM_MARGIN
    const s = Math.min(cover.s * ZOOM_MAX, Math.max(minS, view.s * f))
    if (s === view.s) return
    const k = s / view.s
    // keep the page point under the viewport center fixed
    const c = clampOffset(
      w / 2 - (w / 2 - view.ox) * k,
      h / 2 - (h / 2 - view.oy) * k,
      s,
      w,
      h,
      pageSize(currentPage()),
    )
    view.s = s
    view.ox = c.ox
    view.oy = c.oy
    syncViewUI()
    saveView()
    reRender()
  }

  function resetView() {
    views.delete(store.pageId ?? '')
    applyViewport()
    reRender()
  }

  const minZoom = computed(() => {
    const { w, h } = viewSize.value
    if (!w || !h) return 0
    const cover = coverViewport(w, h, pageSize(currentPage()))
    return (Math.min(w / pw(), h / ph()) * ZOOM_MARGIN) / cover.s
  })
  const canZoomIn = computed(() => zoom.value < ZOOM_MAX - 0.01)
  const canZoomOut = computed(() => zoom.value > minZoom.value + 0.01)

  function setPageTransform(c: CanvasRenderingContext2D) {
    c.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.ox, dpr * view.oy)
  }

  // Raster resolution for the alpha-scan in layerContentBounds (~300px wide).
  const BOUNDS_SCALE = 300 / pw()

  function getLayerBounds(layerId: string): LayerBounds | null {
    const p = currentPage()
    return p ? findLayerBounds(p, ink, layerId, BOUNDS_SCALE, pw(), ph()) : null
  }

  function cachedLayerBounds(layerId: string): LayerBounds | null {
    const pageId = store.pageId
    if (transformBoundsCache?.pageId === pageId && transformBoundsCache.layerId === layerId)
      return transformBoundsCache.bounds
    const bounds = getLayerBounds(layerId)
    transformBoundsCache = { pageId, layerId, bounds }
    return bounds
  }

  function transformFrame(layer = selectedLayer.value) {
    if (!layer?.visible) return null
    if (layerPreview.value?.id === layer.id) layer = { ...layer, ...layerPreview.value }
    const bounds = cachedLayerBounds(layer.id)
    if (!bounds) return null
    return buildTransformFrame(
      layer,
      bounds,
      (point) => ({ x: point.x * view.s + view.ox, y: point.y * view.s + view.oy }),
      pw(),
      ph(),
    )
  }

  function updateCanvasCursor(x: number, y: number) {
    const el = canvas.value
    if (!el) return
    if (store.tool === 'move') {
      el.style.cursor = 'grab'
      return
    }
    if (store.tool !== 'transform') {
      el.style.cursor = 'default'
      return
    }
    const frame = transformFrame()
    el.style.cursor = frame ? cursorForHandle(frame, hitTransformControl(frame, x, y)) : 'default'
  }

  function beginLayerTransform(
    layer: NonNullable<ReturnType<typeof activeLayer>>,
    x: number,
    y: number,
  ) {
    const bounds = cachedLayerBounds(layer.id)
    const frame = transformFrame(layer)
    const hit = frame ? hitTransformControl(frame, x, y) : null
    const handle: TransformHandle = hit ?? 'move'
    let anchorLocal: LayerPoint | null = null
    let startHandleWorld: LayerPoint | null = null
    let pivotLocal: LayerPoint | null = null
    let pivotWorld: LayerPoint | null = null
    if (bounds && frame) {
      if (hit && hit !== 'rotate' && hit !== 'move') {
        anchorLocal = frame.local[oppositeHandle(hit)]
        startHandleWorld = layerPoint(layer, frame.local[hit], pw(), ph())
      }
      pivotLocal = frame.center
      pivotWorld = layerPoint(layer, frame.center, pw(), ph())
    }
    const startPointer = { x: toPageX(x), y: toPageY(y) }
    const startAngle = pivotWorld
      ? Math.atan2(startPointer.y - pivotWorld.y, startPointer.x - pivotWorld.x)
      : 0
    return {
      layerId: layer.id,
      handle,
      startPointer,
      startX: layer.x,
      startY: layer.y,
      startScale: layer.scale,
      startRotation: layer.rotation,
      bounds,
      anchorLocal,
      anchorWorld: anchorLocal ? layerPoint(layer, anchorLocal, pw(), ph()) : null,
      pivotLocal,
      pivotWorld,
      startAngle,
      startHandleWorld,
    }
  }

  function previewLayerTransform(
    id: string,
    changes: Partial<Pick<Layer, 'x' | 'y' | 'scale' | 'rotation'>>,
  ) {
    const layer = pageLayers().find((item) => item.id === id)
    if (!layer) return
    layerPreview.value = {
      id,
      x: changes.x ?? layer.x,
      y: changes.y ?? layer.y,
      scale: changes.scale ?? layer.scale,
      rotation: changes.rotation ?? layer.rotation,
    }
    reRender()
  }

  function applyLayerTransform(x: number, y: number) {
    const drag = layerTransformDrag
    const layer = drag && pageLayers().find((item) => item.id === drag.layerId)
    if (!drag || !layer) return
    const pointer = { x: toPageX(x), y: toPageY(y) }
    if (drag.handle === 'move') {
      previewLayerTransform(drag.layerId, {
        x: drag.startX + pointer.x - drag.startPointer.x,
        y: drag.startY + pointer.y - drag.startPointer.y,
      })
      return
    }
    if (drag.handle === 'rotate' && drag.pivotWorld && drag.pivotLocal) {
      const angle = Math.atan2(pointer.y - drag.pivotWorld.y, pointer.x - drag.pivotWorld.x)
      let delta = angle - drag.startAngle
      if (delta > Math.PI) delta -= 2 * Math.PI
      if (delta < -Math.PI) delta += 2 * Math.PI
      const rotation = drag.startRotation + (delta * 180) / Math.PI
      const zero = layerPoint({ ...layer, x: 0, y: 0, rotation }, drag.pivotLocal, pw(), ph())
      previewLayerTransform(drag.layerId, {
        x: drag.pivotWorld.x - zero.x,
        y: drag.pivotWorld.y - zero.y,
        rotation,
      })
      return
    }
    if (drag.anchorLocal && drag.anchorWorld && drag.startHandleWorld) {
      const initial = Math.hypot(
        drag.startHandleWorld.x - drag.anchorWorld.x,
        drag.startHandleWorld.y - drag.anchorWorld.y,
      )
      const current = Math.hypot(pointer.x - drag.anchorWorld.x, pointer.y - drag.anchorWorld.y)
      const scale = Math.max(0.05, Math.min(20, (drag.startScale * current) / Math.max(initial, 1)))
      const zero = layerPoint({ ...layer, x: 0, y: 0, scale }, drag.anchorLocal, pw(), ph())
      previewLayerTransform(drag.layerId, {
        x: drag.anchorWorld.x - zero.x,
        y: drag.anchorWorld.y - zero.y,
        scale,
      })
    }
  }

  function drawTransformControls() {
    if (!ctx || store.tool !== 'transform') return
    const frame = transformFrame()
    if (!frame) return
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.strokeStyle = '#2a8097'
    ctx.fillStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(frame.screen.nw.x, frame.screen.nw.y)
    ctx.lineTo(frame.screen.ne.x, frame.screen.ne.y)
    ctx.lineTo(frame.screen.se.x, frame.screen.se.y)
    ctx.lineTo(frame.screen.sw.x, frame.screen.sw.y)
    ctx.closePath()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(frame.screen.n.x, frame.screen.n.y)
    ctx.lineTo(frame.rotate.x, frame.rotate.y)
    ctx.stroke()
    for (const point of Object.values(frame.screen)) {
      ctx.fillRect(point.x - 4, point.y - 4, 8, 8)
      ctx.strokeRect(point.x - 4, point.y - 4, 8, 8)
    }
    ctx.beginPath()
    ctx.arc(frame.rotate.x, frame.rotate.y, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  // --- stroke state ---
  const pointers = new Map<number, { x: number; y: number; t: number; type: string }>()
  let drawing = false
  let strokeId = -1
  let curPts: Pt[] = []
  let curSamples: Sample[] = [] // emitted so far, for repaints
  let predRect: { x: number; y: number; w: number; h: number } | null = null // page units
  let liveStroke: { tool: ToolId; color: string } | null = null
  let seed = 1
  let penActive = false
  let curStrokeSize = 1
  let curStab = -1
  let curLayerId = ''
  let shapeDrag: {
    start: { x: number; y: number }
    shape: ShapeKind
    layerId: string
    color: string
    size: number
  } | null = null
  let transformBoundsCache: {
    pageId: string | null
    layerId: string
    bounds: LayerBounds | null
  } | null = null
  let layerTransformDrag: {
    layerId: string
    handle: TransformHandle
    startPointer: LayerPoint
    startX: number
    startY: number
    startScale: number
    startRotation: number
    bounds: LayerBounds | null
    anchorLocal: LayerPoint | null
    anchorWorld: LayerPoint | null
    pivotLocal: LayerPoint | null
    pivotWorld: LayerPoint | null
    startAngle: number
    startHandleWorld: LayerPoint | null
  } | null = null
  let transformFrameRequest: number | null = null
  let pendingTransformPoint: LayerPoint | null = null

  function flushLayerTransform(point?: LayerPoint) {
    if (point) pendingTransformPoint = point
    if (transformFrameRequest !== null) cancelAnimationFrame(transformFrameRequest)
    transformFrameRequest = null
    const next = pendingTransformPoint
    pendingTransformPoint = null
    if (next && layerTransformDrag) applyLayerTransform(next.x, next.y)
  }

  function scheduleLayerTransform(x: number, y: number) {
    pendingTransformPoint = { x, y }
    if (transformFrameRequest !== null) return
    transformFrameRequest = requestAnimationFrame(() => {
      transformFrameRequest = null
      const next = pendingTransformPoint
      pendingTransformPoint = null
      if (next && layerTransformDrag) applyLayerTransform(next.x, next.y)
    })
  }

  function cancelLayerTransformFrame() {
    if (transformFrameRequest !== null) cancelAnimationFrame(transformFrameRequest)
    transformFrameRequest = null
    pendingTransformPoint = null
  }

  // --- edge-nav candidate (stroke starts inside edge zone) ---
  let edgeCandidate = false
  let edgeBuf: Pt[] = []
  let edgeX0 = 0
  let edgeY0 = 0
  let edgeDir = 0 // -1 left edge, +1 right edge

  // --- two-finger gesture state ---
  let gestureActive = false
  let gDist0 = 0
  let gCenter0 = { x: 0, y: 0 }

  // --- fill / cut tool state ---
  let fillStart: { x: number; y: number } | null = null
  let cutting = false
  let cutPath: { x: number; y: number }[] = []
  let cutLayerId: string | null = null
  let cutPending: {
    piece: HTMLCanvasElement
    base: HTMLCanvasElement
    path: { x: number; y: number }[]
    layerId: string
    dx: number
    dy: number
  } | null = null
  let moveStart: { x: number; y: number } | null = null

  function canvasSize() {
    const el = canvas.value!
    return { w: el.clientWidth, h: el.clientHeight }
  }

  function resize() {
    const el = canvas.value
    if (!el) return
    dpr = window.devicePixelRatio || 1
    const { w, h } = { w: el.clientWidth, h: el.clientHeight }
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
    // floodFill reads pixels back on every replay — opt into the CPU path.
    ctx = el.getContext('2d', { willReadFrequently: true })
    applyViewport()
    reRender()
  }

  function paintPaper(c: CanvasRenderingContext2D) {
    const { w, h } = canvasSize()
    c.save()
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.fillStyle = BACKDROP
    c.fillRect(0, 0, w, h)
    c.fillStyle = PAPER
    c.fillRect(view.ox, view.oy, pw() * view.s, ph() * view.s)
    c.restore()
  }

  // Scratch canvases for live alpha-lock clipping, sized to the view canvas.
  let lockMask: { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null
  let lockPaint: { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null

  function lockCanvas(kind: 'mask' | 'paint') {
    let slot = kind === 'mask' ? lockMask : lockPaint
    if (!slot) {
      const c = document.createElement('canvas')
      const c2 = c.getContext('2d', { willReadFrequently: true })
      if (!c2) return null
      slot = { c, ctx: c2 }
      if (kind === 'mask') lockMask = slot
      else lockPaint = slot
    }
    const el = canvas.value!
    if (slot.c.width !== el.width || slot.c.height !== el.height) {
      slot.c.width = el.width
      slot.c.height = el.height
    }
    return slot
  }

  // The layer's existing alpha in device px — the destination-in mask that
  // confines a live locked stroke to already-painted pixels.
  function alphaLockMask(layer: Layer): HTMLCanvasElement | null {
    const p = currentPage()
    if (!p || !ink) return null
    const raster = layerRasterCanvas(p, ink, layer.id)
    const slot = lockCanvas('mask')
    if (!raster || !slot) return null
    const { c, ctx: mc } = slot
    mc.save()
    mc.setTransform(1, 0, 0, 1, 0, 0)
    mc.clearRect(0, 0, c.width, c.height)
    setPageTransform(mc)
    mc.translate(pw() / 2 + layer.x, ph() / 2 + layer.y)
    mc.rotate((layer.rotation * Math.PI) / 180)
    mc.scale(layer.scale, layer.scale)
    mc.translate(-pw() / 2, -ph() / 2)
    mc.drawImage(raster, 0, 0, pw(), ph())
    mc.restore()
    return c
  }

  function drawSamples(
    stroke: Stroke,
    samples: ReturnType<InkEngine['end']>,
    s: number,
    layerId = curLayerId,
    size = curStrokeSize,
  ) {
    if (!ctx || !ink) return
    const layer = pageLayers().find((item) => item.id === layerId)
    const paintInto = (c: CanvasRenderingContext2D) => {
      c.save()
      setPageTransform(c)
      if (layer) {
        c.globalAlpha *= layer.opacity
        c.translate(pw() / 2 + layer.x, ph() / 2 + layer.y)
        c.rotate((layer.rotation * Math.PI) / 180)
        c.scale(layer.scale, layer.scale)
        c.translate(-pw() / 2, -ph() / 2)
      }
      renderSamples(c, stroke.tool, stroke.color, samples, s, size, stroke)
      const mirrored = mirroredSampleSets(samples)
      if (mirrored.length) renderSamples(c, stroke.tool, stroke.color, mirrored, s, size, stroke)
      c.restore()
    }
    const locked = !!layer?.alphaLock && stroke.tool !== 'eraser'
    const mask = locked ? alphaLockMask(layer) : null
    const scratch = mask ? lockCanvas('paint') : null
    if (!scratch) {
      paintInto(ctx)
      return
    }
    scratch.ctx.save()
    scratch.ctx.setTransform(1, 0, 0, 1, 0, 0)
    scratch.ctx.clearRect(0, 0, scratch.c.width, scratch.c.height)
    scratch.ctx.restore()
    paintInto(scratch.ctx)
    scratch.ctx.save()
    scratch.ctx.setTransform(1, 0, 0, 1, 0, 0)
    scratch.ctx.globalCompositeOperation = 'destination-in'
    scratch.ctx.drawImage(mask!, 0, 0)
    scratch.ctx.restore()
    ctx.drawImage(scratch.c, 0, 0)
  }

  function paintShapeDrag(
    drag: NonNullable<typeof shapeDrag>,
    end: { x: number; y: number },
    commit: boolean,
  ) {
    if (!ink) return
    const startPoint = toLayerPt({ ...drag.start, t: 0, p: 0.5 }, drag.layerId)
    const endPoint = toLayerPt({ ...end, t: 16, p: 0.5 }, drag.layerId)
    if (Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y) < 3) {
      reRender()
      return
    }

    const pts = shapePoints(drag.shape, startPoint, endPoint)
    const id = ink.begin('shapes', drag.size, -1)
    const samples = pts.flatMap((point) => ink!.addPoint(id, point.x, point.y, point.t, point.p))
    samples.push(...ink.end(id))
    const stroke: Stroke = {
      tool: 'shapes',
      color: drag.color,
      pts,
      size: drag.size,
      layerId: drag.layerId,
      alphaLock: pageLayers().find((item) => item.id === drag.layerId)?.alphaLock || undefined,
    }
    reRender()
    drawSamples(stroke, samples, seed, drag.layerId, drag.size)
    if (commit) {
      pushStroke(stroke)
      seed++
    }
  }

  // Replay committed content into any 2d target; scale/ox/oy map page units to
  // device px. Used for the snapshot and the no-snapshot (jsdom) fallback.
  function replayPageInto(
    el: HTMLCanvasElement,
    c: CanvasRenderingContext2D,
    scale: number,
    ox: number,
    oy: number,
  ) {
    const p = currentPage()
    if (!p || !ink) return
    paintLayers(el, c, p, ink, scale, ox, oy)
  }

  // --- page snapshot ---------------------------------------------------------
  // Committed strokes+ops are cached in an offscreen canvas so pans and zooms
  // blit it in one drawImage instead of replaying the whole page per frame
  // (flood fills read every pixel back — far too heavy per pointermove). It is
  // rebuilt only when content changes (snapDirty) or when zooming in past its
  // resolution.
  const SNAP_HEADROOM = 2 // build at 2x the needed device scale so zoom stays crisp
  const SNAP_MAX_W = 3200 // px cap; past it the blit upscales
  let snap: { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null
  let snapScale = 0 // device px per page unit in the snapshot
  let snapDirty = true

  function ensureSnap() {
    if (!ink) return
    const maxScale = SNAP_MAX_W / pw()
    const want = Math.min(view.s * dpr * SNAP_HEADROOM, maxScale)
    if (!snap) {
      const c = document.createElement('canvas')
      const c2 = c.getContext('2d', { willReadFrequently: true })
      if (!c2) return
      snap = { c, ctx: c2 }
    }
    if (!snapDirty && snapScale >= want * 0.999) return
    snapScale = Math.min(Math.max(want, snapScale), maxScale)
    const { c, ctx: sc } = snap
    c.width = Math.round(pw() * snapScale)
    c.height = Math.round(ph() * snapScale)
    sc.setTransform(1, 0, 0, 1, 0, 0)
    sc.fillStyle = PAPER
    sc.fillRect(0, 0, c.width, c.height)
    replayPageInto(c, sc, snapScale, 0, 0)
    snapDirty = false
  }

  function reRender() {
    if (!ctx || !ink) return
    ensureSnap()
    const el = canvas.value!
    paintPaper(ctx)
    if (layerTransformDrag && layerPreview.value) {
      // Composite cached layer rasters during the gesture; commit and rebuild the snapshot only on release.
      const p = currentPage()
      if (p) {
        paintLayers(
          el,
          ctx,
          p,
          ink,
          snapScale,
          0,
          0,
          false,
          dpr * view.s,
          dpr * view.ox,
          dpr * view.oy,
          new Map([[layerPreview.value.id, layerPreview.value]]),
        )
        drawTransformControls()
        return
      }
    }
    if (snap) {
      ctx.save()
      setPageTransform(ctx)
      ctx.drawImage(snap.c, 0, 0, pw(), ph())
      ctx.restore()
    } else {
      replayPageInto(el, ctx, dpr * view.s, dpr * view.ox, dpr * view.oy)
    }
    // Sheet center marker — a subtle cross in page space (pans/zooms with it).
    ctx.save()
    setPageTransform(ctx)
    ctx.strokeStyle = 'rgba(60,60,60,0.28)'
    ctx.lineWidth = 1 / view.s
    ctx.beginPath()
    const cs = 6 // page units half-length of the cross arms
    ctx.moveTo(pw() / 2 - cs, ph() / 2)
    ctx.lineTo(pw() / 2 + cs, ph() / 2)
    ctx.moveTo(pw() / 2, ph() / 2 - cs)
    ctx.lineTo(pw() / 2, ph() / 2 + cs)
    ctx.stroke()
    ctx.restore()
    // A full repaint wipes the in-progress stroke (and any predicted paint) —
    // put the committed samples back.
    predRect = null
    if (drawing && liveStroke && curSamples.length) {
      drawSamples({ tool: liveStroke.tool, color: liveStroke.color, pts: curPts }, curSamples, seed)
    }
    drawTransformControls()
    drawGuide()
  }

  // Content changed: force a snapshot rebuild on the next paint.
  function refresh() {
    snapDirty = true
    reRender()
  }

  function drawPendingCut() {
    if (!ctx || !cutPending) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(cutPending.base, 0, 0)
    ctx.shadowColor = 'rgba(0,0,0,0.35)'
    ctx.shadowBlur = 14 * dpr
    ctx.shadowOffsetY = 6 * dpr
    ctx.drawImage(cutPending.piece, cutPending.dx * dpr * view.s, cutPending.dy * dpr * view.s)
    ctx.restore()
  }

  function drawCutSegment(a: { x: number; y: number }, b: { x: number; y: number }) {
    if (!ctx) return
    ctx.save()
    setPageTransform(ctx)
    ctx.strokeStyle = 'rgba(50,50,55,0.8)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([6, 4])
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    ctx.restore()
  }

  // Pointer pt -> layer-local pt, snapped onto the drawing guide (line/arc)
  // when one is active. Guides snap ink strokes only.
  function toLayerSnapped(pt: Pt, layerId: string): Pt {
    if (store.guide === 'off' || !INK_TOOLS.includes(store.tool)) return toLayerPt(pt, layerId)
    const pg = snapToGuide({ x: toPageX(pt.x), y: toPageY(pt.y) })
    return toLayerPt({ ...pt, x: pg.x * view.s + view.ox, y: pg.y * view.s + view.oy }, layerId)
  }

  // Mirrored variants of live samples under the current symmetry mode.
  function mirroredSampleSets(samples: Sample[]): Sample[] {
    return mirroredSamples(samples, store.symmetry, pw(), ph())
  }

  function beginStroke(pt: Pt) {
    if (!ink) return
    const layer = activeLayer()
    if (!layer) return
    curLayerId = layer.id
    curStrokeSize = brushOf(store.tool).size
    curStab = INK_TOOLS.includes(store.tool) ? brushOf(store.tool).stab : -1
    strokeId = ink.begin(store.tool, curStrokeSize, curStab)
    const q = toLayerSnapped(pt, curLayerId)
    curPts = [q]
    curSamples = []
    predRect = null
    liveStroke = { tool: store.tool, color: store.color }
    drawing = true
    const s = ink.addPoint(strokeId, q.x, q.y, q.t, q.p)
    curSamples.push(...s)
    drawSamples({ tool: store.tool, color: store.color, pts: curPts }, s, seed)
  }

  function addStrokePoint(pt: Pt) {
    if (!ink || !drawing) return
    const q = toLayerSnapped(pt, curLayerId)
    curPts.push(q)
    const s = ink.addPoint(strokeId, q.x, q.y, q.t, q.p)
    curSamples.push(...s)
    drawSamples({ tool: store.tool, color: store.color, pts: curPts }, s, seed)
  }

  function finishStroke(commit: boolean) {
    if (!ink || !drawing) return
    predRect = null
    const tail = ink.end(strokeId)
    curSamples.push(...tail)
    const strokeLayer = pageLayers().find((item) => item.id === curLayerId)
    const toMask = store.maskEdit && !!strokeLayer?.mask && INK_TOOLS.includes(store.tool)
    const stroke: Stroke = {
      tool: store.tool,
      color: store.color,
      pts: curPts,
      size: curStrokeSize,
      stab: curStab >= 0 ? curStab : undefined,
      layerId: curLayerId,
      mask: toMask || undefined,
      alphaLock: !toMask && strokeLayer?.alphaLock && store.tool !== 'eraser' ? true : undefined,
      ...(INK_TOOLS.includes(store.tool) ? brushSnapshot(store.tool) : null),
    }
    drawSamples(stroke, tail, seed)
    if (commit && curPts.length) {
      pushStroke(stroke) // strokes watcher -> refresh() rebuilds the snapshot
      for (const pts of mirroredPtSets(curPts, pageSize(currentPage())))
        pushStroke({ ...stroke, pts })
      seed++
    } else {
      reRender()
    }
    drawing = false
    strokeId = -1
    curPts = []
    curSamples = []
    liveStroke = null
    curLayerId = ''
  }

  // Predicted pointer events are painted ahead of the real input to hide the
  // last ~16ms of latency. Their paint is speculative: before the next batch
  // the predicted region is re-blit from the snapshot and the committed live
  // stroke is repainted inside it.
  function layerRectToPage(layerId: string, r: { x: number; y: number; w: number; h: number }) {
    const layer = pageLayers().find((item) => item.id === layerId)
    return layerRectToPageMath(layer, r, pw(), ph())
  }

  function erasePredicted() {
    if (!predRect) return
    const r = predRect
    predRect = null
    if (!ctx || !snap) {
      reRender()
      return
    }
    ctx.save()
    setPageTransform(ctx)
    // Restore the clean committed content under the predicted paint.
    ctx.drawImage(
      snap.c,
      r.x * snapScale,
      r.y * snapScale,
      r.w * snapScale,
      r.h * snapScale,
      r.x,
      r.y,
      r.w,
      r.h,
    )
    // Repaint the live stroke inside the restored region only.
    ctx.beginPath()
    ctx.rect(r.x, r.y, r.w, r.h)
    ctx.clip()
    if (liveStroke && curSamples.length) {
      drawSamples({ tool: liveStroke.tool, color: liveStroke.color, pts: curPts }, curSamples, seed)
    }
    ctx.restore()
  }

  function paintPredicted(e: PointerEvent) {
    if (!ink || !drawing || typeof e.getPredictedEvents !== 'function') return
    const { left, top } = canvas.value!.getBoundingClientRect()
    const predicted = e.getPredictedEvents()
    if (!predicted.length) return
    let acc: { x: number; y: number; w: number; h: number } | null = null
    for (const ev of predicted) {
      const q = toLayerPt(
        { x: ev.clientX - left, y: ev.clientY - top, t: ev.timeStamp, p: ev.pressure || 0.5 },
        curLayerId,
      )
      const s = ink.predict(strokeId, q.x, q.y, q.t, q.p)
      if (!s.length) continue
      drawSamples({ tool: store.tool, color: store.color, pts: curPts }, s, seed)
      const b = layerRectToPage(curLayerId, sampleBounds(s))
      acc = acc
        ? {
            x: Math.min(acc.x, b.x),
            y: Math.min(acc.y, b.y),
            w: Math.max(acc.x + acc.w, b.x + b.w) - Math.min(acc.x, b.x),
            h: Math.max(acc.y + acc.h, b.y + b.h) - Math.min(acc.y, b.y),
          }
        : b
    }
    predRect = acc
  }

  // ---- gestures ----
  function gestureMetrics(): { dist: number; x: number; y: number } | null {
    if (pointers.size !== 2) return null
    const [a, b] = [...pointers.values()]
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    }
  }

  function onPointerDown(e: PointerEvent) {
    const el = canvas.value!
    el.setPointerCapture(e.pointerId)
    const { left, top } = el.getBoundingClientRect()
    const x = e.clientX - left
    const y = e.clientY - top

    if (e.pointerType === 'pen') penActive = true
    // palm rejection: ignore touches while a pen is drawing
    if (e.pointerType === 'touch' && penActive && drawing) return

    pointers.set(e.pointerId, { x, y, t: e.timeStamp, type: e.pointerType })

    if (pointers.size === 2) {
      // second finger down -> cancel stroke, start rewind/pinch gesture
      if (drawing) finishStroke(false)
      if (shapeDrag) {
        shapeDrag = null
        reRender()
      }
      if (cutting) {
        cutting = false
        cutPath = []
        cutLayerId = null
        reRender()
      }
      panStart = null
      moveStart = null
      cancelLayerTransformFrame()
      layerTransformDrag = null
      if (layerPreview.value) {
        layerPreview.value = null
        reRender()
      }
      fillStart = null
      const m = gestureMetrics()!
      gestureActive = true
      gDist0 = m.dist
      gCenter0 = { x: m.x, y: m.y }
      return
    }

    if (pointers.size > 2) return

    // move tool: drags pan the sheet instead of drawing
    if (store.tool === 'move') {
      panStart = { x, y }
      return
    }
    if (store.tool === 'transform') {
      const layer = activeLayer()
      // Hidden or empty layers have no frame — nothing to grab.
      if (layer?.visible && cachedLayerBounds(layer.id))
        layerTransformDrag = beginLayerTransform(layer, x, y)
      if (e.pointerType === 'mouse') updateCanvasCursor(x, y)
      return
    }

    // a cut piece is floating: any drag moves it
    if (cutPending) {
      moveStart = { x, y }
      return
    }

    if (store.tool === 'cut') cutLayerId = activeLayer()?.id ?? null

    const { w } = canvasSize()
    if (x < EDGE || x > w - EDGE) {
      edgeCandidate = true
      edgeDir = x < EDGE ? -1 : 1
      edgeX0 = x
      edgeY0 = y
      edgeBuf = [{ x, y, t: e.timeStamp, p: e.pressure || 0.5 }]
      return
    }
    const gHit = guideHit({ x: toPageX(x), y: toPageY(y) })
    if (gHit) {
      guideDrag = gHit
      return
    }
    if (store.tool === 'fill') {
      fillStart = { x, y }
      return
    }
    if (store.tool === 'cut') {
      cutting = true
      cutPath = [{ x: toPageX(x), y: toPageY(y) }]
      return
    }
    if (store.tool === 'shapes') {
      const layer = activeLayer()
      if (layer) {
        shapeDrag = {
          start: { x, y },
          shape: store.shape,
          layerId: layer.id,
          color: store.color,
          size: brushOf('shapes').size,
        }
      }
      return
    }
    if (store.tool === 'filter') return // filter only commits ops via its panel
    beginStroke({ x, y, t: e.timeStamp, p: e.pressure || 0.5 })
  }

  // --- drawing guides (ruler / french curve) ---------------------------------
  // The guide overlay draws in page space; its handles drag in canvas px.
  const GUIDE_HANDLE_U = 60 // page-unit hit radius for guide handles
  let guideDrag: 'move' | 'rotate' | 'radius' | null = null

  function guideHandlePt(): { x: number; y: number } {
    const d = store.guide === 'line' ? pw() * 0.4 : store.guideR
    return {
      x: store.guideX + Math.cos(store.guideAngle) * d,
      y: store.guideY + Math.sin(store.guideAngle) * d,
    }
  }

  // Returns a drag mode when a page-space point hits a guide handle.
  function guideHit(p: { x: number; y: number }): typeof guideDrag {
    if (store.guide === 'off') return null
    const h = guideHandlePt()
    if (Math.hypot(p.x - h.x, p.y - h.y) <= GUIDE_HANDLE_U)
      return store.guide === 'line' ? 'rotate' : 'radius'
    if (Math.hypot(p.x - store.guideX, p.y - store.guideY) <= GUIDE_HANDLE_U) return 'move'
    return null
  }

  function drawGuide() {
    const c = ctx
    if (!c || store.guide === 'off') return
    c.save()
    setPageTransform(c)
    c.strokeStyle = 'rgba(42,128,151,0.75)'
    c.fillStyle = 'rgba(42,128,151,0.9)'
    c.lineWidth = 1.5 / view.s
    const handle = guideHandlePt()
    if (store.guide === 'line') {
      c.save()
      c.translate(store.guideX, store.guideY)
      c.rotate(store.guideAngle)
      // straightedge bar + edge line
      c.fillStyle = 'rgba(42,128,151,0.12)'
      c.fillRect(-pw(), -14 / view.s, pw() * 2, 28 / view.s)
      c.strokeRect(-pw(), -14 / view.s, pw() * 2, 28 / view.s)
      c.beginPath()
      c.moveTo(-pw(), 0)
      c.lineTo(pw() * 2, 0)
      c.stroke()
      c.restore()
    } else {
      c.setLineDash([8 / view.s, 6 / view.s])
      c.beginPath()
      c.arc(store.guideX, store.guideY, store.guideR, 0, Math.PI * 2)
      c.stroke()
      c.setLineDash([])
    }
    const dot = (x: number, y: number, r: number) => {
      c.beginPath()
      c.arc(x, y, r / view.s, 0, Math.PI * 2)
      c.fill()
      c.stroke()
    }
    dot(store.guideX, store.guideY, 9)
    dot(handle.x, handle.y, 9)
    c.restore()
  }

  function cycleSymmetry() {
    const order: SymmetryMode[] = ['none', 'v', 'h', 'xy']
    store.symmetry = order[(order.indexOf(store.symmetry) + 1) % order.length]
  }

  function cycleGuide() {
    const order: GuideMode[] = ['off', 'line', 'arc']
    store.guide = order[(order.indexOf(store.guide) + 1) % order.length]
    reRender()
  }

  function onPointerMove(e: PointerEvent) {
    const rec = pointers.get(e.pointerId)
    const { left, top } = canvas.value!.getBoundingClientRect()
    const x = e.clientX - left
    const y = e.clientY - top
    if (!rec) {
      if (e.pointerType === 'mouse') updateCanvasCursor(x, y)
      return
    }
    rec.x = x
    rec.y = y
    rec.t = e.timeStamp

    if (guideDrag) {
      const px = toPageX(x)
      const py = toPageY(y)
      if (guideDrag === 'move') {
        store.guideX = px
        store.guideY = py
      } else if (guideDrag === 'rotate') {
        store.guideAngle = Math.atan2(py - store.guideY, px - store.guideX)
      } else {
        store.guideR = Math.max(20, Math.hypot(px - store.guideX, py - store.guideY))
      }
      reRender()
      return
    }

    if (gestureActive && pointers.size === 2) {
      const m = gestureMetrics()
      if (!m) return
      const { w, h } = canvasSize()
      const cover = coverViewport(w, h, pageSize(currentPage()))
      const minS = Math.min(w / pw(), h / ph()) * ZOOM_MARGIN
      const nextS = Math.min(
        cover.s * ZOOM_MAX,
        Math.max(minS, (view.s * m.dist) / Math.max(gDist0, 1)),
      )
      const k = nextS / view.s
      const c = clampOffset(
        m.x - (gCenter0.x - view.ox) * k,
        m.y - (gCenter0.y - view.oy) * k,
        nextS,
        w,
        h,
        pageSize(currentPage()),
      )
      view.s = nextS
      view.ox = c.ox
      view.oy = c.oy
      gDist0 = m.dist
      gCenter0 = { x: m.x, y: m.y }
      syncViewUI()
      reRender()
      return
    }

    if (edgeCandidate) {
      edgeBuf.push({ x, y, t: e.timeStamp, p: e.pressure || 0.5 })
      const dx = x - edgeX0
      const dy = y - edgeY0
      if (Math.abs(dx) > 14) {
        if (Math.abs(dx) > Math.abs(dy) * 1.6) return // horizontal -> nav swipe, keep buffering
        edgeCandidate = false // vertical-ish -> it was a drawing stroke
        if (store.tool === 'cut') {
          cutting = true
          cutPath = edgeBuf.map((p) => ({ x: toPageX(p.x), y: toPageY(p.y) }))
        } else if (store.tool === 'shapes') {
          const layer = activeLayer()
          if (layer && edgeBuf.length) {
            shapeDrag = {
              start: { x: edgeBuf[0].x, y: edgeBuf[0].y },
              shape: store.shape,
              layerId: layer.id,
              color: store.color,
              size: brushOf('shapes').size,
            }
            paintShapeDrag(shapeDrag, { x, y }, false)
          }
        } else if (store.tool !== 'fill' && store.tool !== 'filter') {
          beginStroke(edgeBuf[0])
          for (const pt of edgeBuf.slice(1)) addStrokePoint(pt)
        }
        edgeBuf = []
      }
      return
    }

    if (panStart) {
      const { w, h } = canvasSize()
      const c = clampOffset(
        view.ox + (x - panStart.x),
        view.oy + (y - panStart.y),
        view.s,
        w,
        h,
        pageSize(currentPage()),
      )
      if (c.ox !== view.ox || c.oy !== view.oy) {
        view.ox = c.ox
        view.oy = c.oy
        reRender()
      }
      panStart = { x, y }
      return
    }

    if (layerTransformDrag) {
      scheduleLayerTransform(x, y)
      return
    }

    if (moveStart && cutPending) {
      cutPending.dx = (x - moveStart.x) / view.s
      cutPending.dy = (y - moveStart.y) / view.s
      drawPendingCut()
      return
    }

    if (cutting) {
      const q = { x: toPageX(x), y: toPageY(y) }
      const last = cutPath[cutPath.length - 1]
      if (Math.hypot(q.x - last.x, q.y - last.y) > 2.5 / view.s) {
        cutPath.push(q)
        drawCutSegment(last, q)
      }
      return
    }

    if (shapeDrag) {
      paintShapeDrag(shapeDrag, { x, y }, false)
      return
    }

    if (!drawing) return
    erasePredicted()
    // getCoalescedEvents() is empty for synthetic events — fall back to [e]
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null
    const events = coalesced?.length ? coalesced : [e]
    for (const ev of events) {
      const cx = ev.clientX - left
      const cy = ev.clientY - top
      addStrokePoint({ x: cx, y: cy, t: ev.timeStamp, p: ev.pressure || 0.5 })
    }
    paintPredicted(e)
  }

  function finishCutSelection() {
    cutting = false
    const layerId = cutLayerId
    cutLayerId = null
    const page = currentPage()
    const layer = pageLayers().find((item) => item.id === layerId)
    if (!layerId || !page || !layer?.visible || !ink) {
      cutPath = []
      reRender()
      return
    }

    const el = canvas.value!
    const path = rdp(cutPath, 3)
    const pageLayerId = page.layers?.[0]?.id ?? 'legacy'
    const layerPage: Page = {
      ...page,
      layers: [layer],
      strokes: page.strokes.filter((stroke) => (stroke.layerId ?? pageLayerId) === layerId),
      ops: (page.ops ?? []).filter(
        (op) => op.layerId === '*' || (op.layerId ?? pageLayerId) === layerId,
      ),
    }
    const source = document.createElement('canvas')
    source.width = el.width
    source.height = el.height
    const sourceCtx = source.getContext('2d', { willReadFrequently: true })
    const base = document.createElement('canvas')
    base.width = el.width
    base.height = el.height
    const baseCtx = base.getContext('2d', { willReadFrequently: true })
    if (!sourceCtx || !baseCtx) {
      cutPath = []
      reRender()
      return
    }

    const displayScale = dpr * view.s
    const displayOx = dpr * view.ox
    const displayOy = dpr * view.oy
    paintLayers(
      source,
      sourceCtx,
      layerPage,
      ink,
      snapScale,
      0,
      0,
      false,
      displayScale,
      displayOx,
      displayOy,
    )
    const piece = extractRegion(source, sourceCtx, path, displayScale, displayOx, displayOy, null)
    paintPaper(baseCtx)
    const previewPage: Page = {
      ...page,
      ops: [
        ...(page.ops ?? []),
        { kind: 'cut', path, dx: 0, dy: 0, after: page.strokes.length, layerId },
      ],
    }
    paintLayers(
      base,
      baseCtx,
      previewPage,
      ink,
      snapScale,
      0,
      0,
      false,
      displayScale,
      displayOx,
      displayOy,
    )

    const pieceCtx = piece?.getContext('2d', { willReadFrequently: true })
    const hasPixels =
      piece && pieceCtx
        ? pieceCtx
            .getImageData(0, 0, piece.width, piece.height)
            .data.some((value, index) => index % 4 === 3 && value > 0)
        : false
    if (piece && hasPixels) {
      // Lift only the active layer; other layers stay visible in the base preview.
      cutPending = { piece, base, path, layerId, dx: 0, dy: 0 }
      drawPendingCut()
    } else {
      reRender()
    }
    cutPath = []
  }

  function commitFill(x: number, y: number) {
    const p = currentPage()
    if (!p) return
    const after = p.strokes.length
    const alphaLock = activeLayer()?.alphaLock || undefined
    // 'erase' mode is the magic-wand background removal; 'invert' is the
    // inverse/background fill — both run on the layer raster like 'fill'.
    if (store.fillMode === 'erase') {
      pushOp({ kind: 'erase', x: toPageX(x), y: toPageY(y), after, alphaLock })
    } else {
      pushOp({
        kind: 'fill',
        x: toPageX(x),
        y: toPageY(y),
        color: store.color,
        after,
        alphaLock,
        invert: store.fillMode === 'invert' || undefined,
      })
    }
    reRender()
  }

  function onPointerUp(e: PointerEvent) {
    guideDrag = null
    const rec = pointers.get(e.pointerId)
    pointers.delete(e.pointerId)
    if (e.pointerType === 'pen') penActive = false

    if (gestureActive) {
      if (pointers.size < 2) {
        gestureActive = false
        syncViewUI()
        saveView()
      }
      return
    }

    if (panStart) {
      panStart = null
      syncViewUI()
      saveView()
      return
    }

    if (layerTransformDrag) {
      const { left, top } = canvas.value!.getBoundingClientRect()
      flushLayerTransform({ x: e.clientX - left, y: e.clientY - top })
      const drag = layerTransformDrag
      const preview = layerPreview.value
      layerTransformDrag = null
      layerPreview.value = null
      if (preview?.id === drag.layerId) {
        updateLayer(drag.layerId, {
          x: preview.x,
          y: preview.y,
          scale: preview.scale,
          rotation: preview.rotation,
        })
      }
      if (e.pointerType === 'mouse') {
        const { left, top } = canvas.value!.getBoundingClientRect()
        updateCanvasCursor(e.clientX - left, e.clientY - top)
      }
      return
    }

    if (edgeCandidate) {
      edgeCandidate = false
      if (rec) {
        const dx = rec.x - edgeX0
        const dy = rec.y - edgeY0
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          // swipe from edge: left edge + swipe right = previous page; right edge + left = next
          const dir = edgeDir === -1 ? (dx > 0 ? -1 : 0) : dx < 0 ? 1 : 0
          if (dir !== 0 && navPage(dir as 1 | -1)) {
            navClass.value = dir === 1 ? 'from-right' : 'from-left'
            reRender()
            setTimeout(() => {
              navClass.value = ''
            }, 300)
          }
        } else if (store.tool === 'fill' && edgeBuf.length) {
          commitFill(edgeBuf[0].x, edgeBuf[0].y)
        } else if (store.tool === 'cut' && edgeBuf.length) {
          cutPath = edgeBuf.map((p) => ({ x: toPageX(p.x), y: toPageY(p.y) }))
          finishCutSelection()
        } else if (store.tool === 'shapes') {
          reRender()
        } else if (
          store.tool !== 'fill' &&
          store.tool !== 'cut' &&
          store.tool !== 'filter' &&
          edgeBuf.length
        ) {
          // slow/short tap in edge zone — treat as drawing
          beginStroke(edgeBuf[0])
          for (const pt of edgeBuf.slice(1)) addStrokePoint(pt)
          finishStroke(true)
        }
      }
      edgeBuf = []
      cutLayerId = null
      return
    }

    if (moveStart && cutPending) {
      const { dx, dy, path, layerId } = cutPending
      const p = currentPage()
      if (p && Math.hypot(dx, dy) > 3) {
        pushOp({ kind: 'cut', path, dx, dy, after: p.strokes.length, layerId })
      }
      cutPending = null
      moveStart = null
      reRender()
      return
    }

    if (cutting) {
      finishCutSelection()
      return
    }

    if (fillStart) {
      if (rec && Math.hypot(rec.x - fillStart.x, rec.y - fillStart.y) < 8) {
        commitFill(rec.x, rec.y)
      }
      fillStart = null
      return
    }

    if (shapeDrag && pointers.size === 0) {
      const drag = shapeDrag
      shapeDrag = null
      if (rec) paintShapeDrag(drag, { x: rec.x, y: rec.y }, true)
      else reRender()
      return
    }

    if (drawing && pointers.size === 0) finishStroke(true)
  }

  function closeLayerModal() {
    layerPanelOpen.value = false
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && layerPanelOpen.value) {
      e.preventDefault()
      closeLayerModal()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault()
      if (e.shiftKey) {
        if (redoStroke()) reRender()
      } else if (undoStroke()) reRender()
    }
  }

  const undoOk = computed(() => canUndo())
  const redoOk = computed(() => canRedo())

  async function importPhoto(file: File) {
    const img = await imageFileToPhoto(file)
    const scale = Math.min(1, (pw() * 0.6) / img.w, (ph() * 0.6) / img.h)
    const photoW = img.w * scale
    const photoH = img.h * scale
    const p = currentPage()
    if (!p) return
    pushOp({
      kind: 'photo',
      photo: { src: img.src, x: (pw() - photoW) / 2, y: (ph() - photoH) / 2, w: photoW, h: photoH },
      after: p.strokes.length,
      alphaLock: activeLayer()?.alphaLock || undefined,
    })
    reRender()
  }

  let offImageLoad: (() => void) | undefined
  let sizeObserver: ResizeObserver | undefined

  onMounted(async () => {
    ink = await initInk()
    resize()
    // Canvas size can change without a window resize (layout shifts in the
    // WebView); re-apply the viewport so the saved view and the fit button's
    // visibility stay correct.
    if (typeof ResizeObserver !== 'undefined' && canvas.value) {
      sizeObserver = new ResizeObserver(() => resize())
      sizeObserver.observe(canvas.value)
    }
    window.addEventListener('resize', resize)
    window.addEventListener('keydown', onKeyDown)
    offImageLoad = onImageLoaded(() => {
      transformBoundsCache = null
      thumbRev.value++
      clearLayerRasterCache(store.pageId ?? undefined)
      refresh()
    })
  })

  // Layer compositing means even an appended stroke may belong below another
  // layer, so rebuild the page snapshot after each committed action.
  watch(
    () => currentPage()?.strokes?.length,
    () => {
      transformBoundsCache = null
      thumbRev.value++
      snapDirty = true
      reRender()
    },
    { flush: 'sync' },
  )
  watch(
    () => currentPage()?.ops?.length,
    () => {
      transformBoundsCache = null
      thumbRev.value++
      snapDirty = true
      reRender()
    },
    { flush: 'sync' },
  )
  watch(
    () =>
      currentPage()
        ?.layers?.map(
          (layer) =>
            `${layer.id}:${layer.visible}:${layer.opacity}:${layer.x}:${layer.y}:${layer.scale}:${layer.rotation}:${layer.blend}:${layer.alphaLock}:${layer.clip}`,
        )
        .join('|'),
    () => {
      transformBoundsCache = null
      thumbRev.value++
      snapDirty = true
      reRender()
    },
    { flush: 'sync' },
  )
  watch(
    () => currentPage()?.activeLayerId,
    () => reRender(),
    { flush: 'sync' },
  )
  watch(
    () => store.tool,
    () => {
      if (canvas.value) canvas.value.style.cursor = store.tool === 'move' ? 'grab' : 'default'
      reRender()
    },
    { flush: 'sync' },
  )
  watch(
    () => store.pageId,
    () => {
      cutPending = null
      layerTransformDrag = null
      layerPreview.value = null
      transformBoundsCache = null
      thumbCache.clear()
      thumbRev.value++
      snapDirty = true
      applyViewport()
      reRender()
    },
    { flush: 'sync' },
  )

  onBeforeUnmount(() => {
    cancelLayerTransformFrame()
    sizeObserver?.disconnect()
    window.removeEventListener('resize', resize)
    window.removeEventListener('keydown', onKeyDown)
    offImageLoad?.()
  })

  return {
    canvas,
    navClass,
    journal,
    pageIndex,
    layerPanelOpen,
    layerThumb,
    brushSize,
    brushProgress,
    brushMarkWidth,
    TRAY_HEIGHT,
    INK_TOOLS,
    ZOOM_STEP,
    isFit,
    canZoomIn,
    canZoomOut,
    selectedLayer,
    layerPreview,
    zoomBy,
    resetView,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    cycleSymmetry,
    cycleGuide,
    undoOk,
    redoOk,
    importPhoto,
    reRender,
    store,
    brushOf,
    updateLayer,
    undoStroke,
    redoStroke,
    closeToJournal,
  }
}
