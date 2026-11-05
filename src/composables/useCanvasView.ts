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
  addLayer,
  updateLayer,
} from '../store'
import { initInk } from '../ink/engine'
import { renderSamples } from '../ink/renderer'
import {
  adoptLayerRasterTail,
  clearLayerRasterCache,
  layerMaskRasterCanvas,
  layerRasterCanvas,
  paintLayers,
  setRasterScaleHint,
} from '../ink/layers'
import { extractRegion, onImageLoaded, imageFileToPhoto, pathTo } from '../ink/ops'
import { rdp } from '../ink/path'
import { shapePoints } from '../ink/shapes'
import { pageSize, coverViewport, spreadRect } from '../pageSpace'
import { INK_TOOLS } from '../ink/tools'
import {
  buildTransformFrame,
  cursorForHandle,
  hitTransformControl,
  layerPoint,
  layerRectToPage as layerRectToPageMath,
  mirroredSamples,
  oppositeHandle,
  pageRectToLayer,
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
} from '../types'
import { SPREAD_MODES } from '../types'

export function useCanvasView() {
  const PAPER = '#f6f1e6'
  const BACKDROP = '#2a2a2c'
  const EDGE = 34 // px edge zone for page-swipe nav
  const TRAY_HEIGHT = 60
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
  // Open with the whole sheet visible and some breathing room; pinch gestures
  // zoom and pan, and each page remembers its own view.
  const INITIAL_FIT = 0.8
  const ZOOM_MAX = 5 // scale relative to cover fit
  const ZOOM_MARGIN = 0.5 // zoom-out stops at half-size contain fit
  const view = { s: 1, ox: 0, oy: 0, angle: 0 }
  const zoom = ref(1)
  const views = new Map<string, { zoom: number; fx: number; fy: number; angle: number }>() // per-page
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

  // The view rotation is applied inside the canvas 2D transform, not via CSS
  // rotate on the element: a rotated viewport-sized element gets clipped by
  // .viewport (its edges cut across the screen, shrinking the visible area)
  // and its getBoundingClientRect() inflates to the rotated bounding box,
  // breaking pointer mapping. toLocalPoint inverts the same center rotation,
  // so screen coordinates map back into the unrotated canvas space.
  function toLocalPoint(pt: { x: number; y: number }, angle = view.angle) {
    if (!angle) return pt
    const { w, h } = canvasSize()
    const cx = pt.x - w / 2
    const cy = pt.y - h / 2
    const cos = Math.cos(-angle)
    const sin = Math.sin(-angle)
    return { x: w / 2 + cx * cos - cy * sin, y: h / 2 + cx * sin + cy * cos }
  }

  const toPageX = (x: number) => (x - view.ox) / view.s
  const toPageY = (y: number) => (y - view.oy) / view.s
  // Current page's size in page units (custom sizes come from page.w/h).
  const pw = () => pageSize(currentPage()).w
  const ph = () => pageSize(currentPage()).h
  // The working rect the viewport frames and paint clips to: the whole
  // sheet, or one half when the spread focus picks a side. Portrait and
  // square pages always use the full sheet.
  const workRect = () => spreadRect(store.spreadMode, pw(), ph())
  const workHalved = () => workRect().w !== pw()
  const spreadCapable = computed(() => pw() > ph())
  // A focused half is a hard edge for painting too: strokes can't start
  // outside it, and a pointer leaving it ends the stroke at the fold.
  const inWorkPage = (p: { x: number; y: number }) => {
    const r = workRect()
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
  }
  const inWork = (x: number, y: number) =>
    !workHalved() || inWorkPage({ x: toPageX(x), y: toPageY(y) })
  // Clamps a canvas-px point so its page position stays inside the rect.
  const clampWork = (pt: { x: number; y: number }) => {
    if (!workHalved()) return pt
    const r = workRect()
    const p = {
      x: Math.min(Math.max(toPageX(pt.x), r.x), r.x + r.w),
      y: Math.min(Math.max(toPageY(pt.y), r.y), r.y + r.h),
    }
    return { x: p.x * view.s + view.ox, y: p.y * view.s + view.oy }
  }
  const clampWorkPage = (p: { x: number; y: number }) => {
    const r = workRect()
    return {
      x: Math.min(Math.max(p.x, r.x), r.x + r.w),
      y: Math.min(Math.max(p.y, r.y), r.y + r.h),
    }
  }
  // The focused half as a clip polygon in a layer's local space — strokes
  // committed under a spread focus carry it, so brush/eraser width can't
  // bleed past the fold on live paint or on replay.
  function workClip(layer: Layer) {
    if (!workHalved()) return null
    const r = workRect()
    return pageRectToLayer(layer, { x: r.x, y: r.y, w: r.w, h: r.h }, pw(), ph())
  }
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

  // Saved offsets are fractions of the sheet size relative to the centered
  // position, so any free pan survives canvas resizes; 0 = centered.
  const frac = (o: number, css: number, sheet: number) =>
    sheet > 0 ? (o - (css - sheet) / 2) / sheet : 0
  const unfrac = (f: number, css: number, sheet: number) => (css - sheet) / 2 + f * sheet

  // Saved views are per page AND per spread focus: each side of the sheet
  // remembers its own framing.
  const viewKey = () => `${store.pageId ?? ''}|${store.spreadMode}`

  function applyViewport() {
    const { w, h } = canvasSize()
    const r = workRect()
    const cover = coverViewport(w, h, { w: r.w, h: r.h })
    const saved = views.get(viewKey())
    view.s = saved ? cover.s * saved.zoom : Math.min(w / r.w, h / r.h) * INITIAL_FIT
    view.angle = saved?.angle ?? 0
    view.ox = (saved ? unfrac(saved.fx, w, r.w * view.s) : (w - r.w * view.s) / 2) - r.x * view.s
    view.oy = (saved ? unfrac(saved.fy, h, r.h * view.s) : (h - r.h * view.s) / 2) - r.y * view.s
    syncZoomState()
  }

  function syncZoomState() {
    const { w, h } = canvasSize()
    const r = workRect()
    const cover = coverViewport(w, h, { w: r.w, h: r.h })
    zoom.value = cover.s ? view.s / cover.s : 1
  }

  function saveView() {
    const { w, h } = canvasSize()
    const r = workRect()
    views.set(viewKey(), {
      zoom: zoom.value,
      fx: frac(view.ox + r.x * view.s, w, r.w * view.s),
      fy: frac(view.oy + r.y * view.s, h, r.h * view.s),
      angle: view.angle,
    })
  }

  // device px = rotate(canvas-local px) about the canvas center. Used to draw
  // things that live in canvas space (paper rect, transform frame) so they
  // turn with the sheet.
  function setViewTransform(c: CanvasRenderingContext2D) {
    const { w, h } = canvasSize()
    const cx = (w * dpr) / 2
    const cy = (h * dpr) / 2
    const cos = Math.cos(view.angle)
    const sin = Math.sin(view.angle)
    c.setTransform(
      dpr * cos,
      dpr * sin,
      -dpr * sin,
      dpr * cos,
      cx * (1 - cos) + cy * sin,
      cy * (1 - cos) - cx * sin,
    )
  }

  function setPageTransform(c: CanvasRenderingContext2D) {
    if (!view.angle) {
      c.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.ox, dpr * view.oy)
      return
    }
    const { w, h } = canvasSize()
    const cx = (w * dpr) / 2
    const cy = (h * dpr) / 2
    const s = view.s * dpr
    const ox = view.ox * dpr
    const oy = view.oy * dpr
    const cos = Math.cos(view.angle)
    const sin = Math.sin(view.angle)
    // device = R(canvas center, angle) ∘ (page * s + offset)
    c.setTransform(
      s * cos,
      s * sin,
      -s * sin,
      s * cos,
      cos * (ox - cx) - sin * (oy - cy) + cx,
      sin * (ox - cx) + cos * (oy - cy) + cy,
    )
  }

  // The same center rotation as a standalone value for the display transform
  // paintLayers applies when compositing rasters straight to the screen.
  function viewRot() {
    if (!view.angle) return null
    const { w, h } = canvasSize()
    return { angle: view.angle, cx: (w * dpr) / 2, cy: (h * dpr) / 2 }
  }

  // Page units -> device px through the full view transform (scale + offset,
  // then the center rotation).
  function viewToDevice(pt: { x: number; y: number }) {
    const lx = pt.x * view.s + view.ox
    const ly = pt.y * view.s + view.oy
    if (!view.angle) return { x: lx * dpr, y: ly * dpr }
    const { w, h } = canvasSize()
    const cos = Math.cos(view.angle)
    const sin = Math.sin(view.angle)
    return {
      x: (w / 2 + (lx - w / 2) * cos - (ly - h / 2) * sin) * dpr,
      y: (h / 2 + (lx - w / 2) * sin + (ly - h / 2) * cos) * dpr,
    }
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
    setViewTransform(ctx)
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
  const pointers = new Map<
    number,
    { x: number; y: number; t: number; type: string; gx: number; gy: number }
  >()
  let drawing = false
  // The pointer left the focused half mid-stroke: the stroke was committed
  // at the fold, and re-entering the half starts a fresh one.
  let strokeOut = false
  let strokeId = -1
  let curPts: Pt[] = []
  let curSamples: Sample[] = [] // emitted so far, for repaints
  // Page-space region the live stroke currently paints over — restored from
  // the snapshot before each whole-stroke repaint.
  let liveDirty: { x: number; y: number; w: number; h: number } | null = null
  let liveStroke: Stroke | null = null
  let repaintRaf = 0 // pending rAF for the live-eraser composite repaint
  // Region the live eraser touched, in page units — the scheduled repaint
  // recomposites only this rect instead of rebuilding the page snapshot.
  let eraseDirty: { x: number; y: number; w: number; h: number } | null = null
  let eraseDirtyView: { s: number; ox: number; oy: number; angle: number } | null = null
  // Pre-stroke copy of the raster the live eraser mutates — a cancelled
  // stroke (the second finger of a pinch) restores it instead of dropping
  // the cache and re-replaying the whole layer through the ink engine.
  let eraseBackup: {
    raster: HTMLCanvasElement | null
    c: HTMLCanvasElement
    ctx: CanvasRenderingContext2D
  } | null = null
  // Live-into-raster strokes: deterministic ink tools paint emitted samples
  // straight into the layer raster during the stroke (same painter output
  // as the commit replay), so pointerup only adopts the cache signature
  // instead of re-rendering the whole stroke at raster resolution — that
  // replay was the multi-hundred-ms freeze after each brush stroke.
  let liveRaster: {
    canvas: HTMLCanvasElement
    ctx: CanvasRenderingContext2D
    scale: number
    layerId: string
    last: Sample | null
  } | null = null
  // Set around pushStroke calls whose raster already contains the stroke —
  // the strokes watcher skips the synchronous rebuild it would otherwise do.
  let suppressStrokeRebuild = false
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
  let gAngle0 = 0
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
    // No willReadFrequently here: pixel reads (floodFill, filters, bounds
    // scans) run on the snapshot/layer rasters, never this context — opting
    // in would force CPU compositing of every blit.
    ctx = el.getContext('2d')
    applyViewport()
    reRender()
  }

  function paintPaper(c: CanvasRenderingContext2D) {
    const { w, h } = canvasSize()
    const r = workRect()
    c.save()
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.fillStyle = BACKDROP
    c.fillRect(0, 0, w, h)
    c.fillStyle = PAPER
    setPageTransform(c)
    c.fillRect(r.x, r.y, r.w, r.h)
    c.restore()
  }

  // Spread-half focus: clips the target to the working rect so nothing
  // paints onto the hidden half. Returns true when a clip was pushed (the
  // caller restores); the whole-sheet mode skips it entirely.
  function clipWork(c: CanvasRenderingContext2D): boolean {
    const r = workRect()
    if (r.x === 0 && r.y === 0 && r.w === pw() && r.h === ph()) return false
    c.save()
    setPageTransform(c)
    c.beginPath()
    c.rect(r.x, r.y, r.w, r.h)
    c.clip()
    // Keep painting in device px — the clip path was recorded under the
    // page transform, so it tracks the rotated view.
    c.setTransform(1, 0, 0, 1, 0, 0)
    return true
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
    if (stroke.tool === 'eraser') {
      eraseLiveIntoRaster(stroke, samples, s, layerId, size)
      return
    }
    const layer = pageLayers().find((item) => item.id === layerId)
    const paintInto = (c: CanvasRenderingContext2D) => {
      c.save()
      setPageTransform(c)
      // Paint never leaves the working rect: clip in page space so the
      // layer transform below can't push ink past the paper edge — or past
      // the fold while a spread half is focused.
      const r = workRect()
      c.beginPath()
      c.rect(r.x, r.y, r.w, r.h)
      c.clip()
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
    // The eraser already left through the raster branch above.
    const locked = !!layer?.alphaLock
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

  // Coalesce live-eraser repaints to one composite per frame — each batch
  // already mutated the layer raster, so a single rebuild shows them all.
  function scheduleRepaint() {
    if (repaintRaf || typeof requestAnimationFrame !== 'function') return
    repaintRaf = requestAnimationFrame(() => {
      repaintRaf = 0
      if (eraseDirty) repaintEraseRegion()
      else reRender()
    })
  }

  // Repaint only the region the live eraser touched: clip the display canvas
  // to the dirty rect and recomposite paper + cached layer rasters inside it.
  // Rebuilding the full page snapshot every frame was what made the eraser
  // lag; the snapshot stays stale until the stroke commits and refreshes it.
  function repaintEraseRegion() {
    const r = eraseDirty
    const v = eraseDirtyView
    eraseDirty = null
    eraseDirtyView = null
    if (!ctx || !ink || !r || !v) return
    const el = canvas.value
    // The view moved since the region was recorded — a clipped repaint would
    // leave everything outside the rect stale, so fall back to a full paint.
    if (!el || v.s !== view.s || v.ox !== view.ox || v.oy !== view.oy || v.angle !== view.angle) {
      reRender()
      return
    }
    // Page-space rect -> device px bbox (view rotation inflates it).
    let l = Infinity,
      t = Infinity,
      rr = -Infinity,
      b = -Infinity
    for (const [px, py] of [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x, r.y + r.h],
      [r.x + r.w, r.y + r.h],
    ]) {
      const d = viewToDevice({ x: px, y: py })
      if (d.x < l) l = d.x
      if (d.x > rr) rr = d.x
      if (d.y < t) t = d.y
      if (d.y > b) b = d.y
    }
    const pad = 3 * dpr
    l = Math.max(0, Math.floor(l - pad))
    t = Math.max(0, Math.floor(t - pad))
    rr = Math.min(el.width, Math.ceil(rr + pad))
    b = Math.min(el.height, Math.ceil(b + pad))
    if (rr <= l || b <= t) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.beginPath()
    ctx.rect(l, t, rr - l, b - t)
    ctx.clip()
    if (workHalved()) {
      // Don't repaint the hidden half: its backdrop (and any floating
      // overlays, like a lifted cut piece) stays untouched.
      setPageTransform(ctx)
      const wr = workRect()
      ctx.beginPath()
      ctx.rect(wr.x, wr.y, wr.w, wr.h)
      ctx.clip()
    }
    paintPaper(ctx)
    replayPageInto(el, ctx, dpr * view.s, dpr * view.ox, dpr * view.oy, viewRot())
    ctx.restore()
    // The clipped repaint wiped any overlay ink inside the rect.
    drawSheetMarker()
    drawTransformControls()
    drawGuide()
  }

  // Snapshot a raster's pixels so a cancelled live-into-raster stroke can
  // roll its incremental paint back.
  function backupRaster(raster: HTMLCanvasElement) {
    if (!eraseBackup) {
      const c = document.createElement('canvas')
      const bc = c.getContext('2d')
      if (bc) eraseBackup = { raster: null, c, ctx: bc }
    }
    if (eraseBackup && eraseBackup.raster !== raster) {
      const { c, ctx: bc } = eraseBackup
      if (c.width !== raster.width || c.height !== raster.height) {
        c.width = raster.width
        c.height = raster.height
      }
      bc.drawImage(raster, 0, 0)
      eraseBackup.raster = raster
    }
  }

  function restoreRaster(raster: HTMLCanvasElement) {
    if (eraseBackup?.raster !== raster) return
    const rc = raster.getContext('2d', { willReadFrequently: true })
    if (!rc) return
    rc.setTransform(1, 0, 0, 1, 0, 0)
    rc.drawImage(eraseBackup.c, 0, 0)
  }

  // Tools whose committed paint is identical when applied incrementally.
  // Watercolor qualifies: every dab's position and alpha come from its own
  // sample pair, so chained batches multiply out to the same pixels as the
  // single-call replay. The others don't: solid painters take alpha from
  // samples[0] (one uniform fill), pencil and stamped tips carry seeded
  // rand/spacing state across calls, wet strokes run a whole-bbox kernel.
  function rasterLiveTool(stroke: Stroke, layer: Layer): boolean {
    if (stroke.tool !== 'color' || (stroke.wet ?? 0) > 0) return false
    if (stroke.tip && stroke.tip !== 'round') return false
    if (stroke.alphaLock || stroke.mask || layer.alphaLock) return false
    if (store.symmetry !== 'none' || store.maskEdit) return false
    return true
  }

  // Paint newly emitted samples into the layer raster, chaining the batch
  // onto the last painted sample so stamp spacing and outline joins match
  // the single-call replay.
  function paintLiveRaster(samples: Sample[]) {
    const lr = liveRaster
    const stroke = liveStroke
    if (!lr || !stroke || !samples.length) return
    const batch = lr.last ? [lr.last, ...samples] : samples
    lr.ctx.save()
    lr.ctx.setTransform(lr.scale, 0, 0, lr.scale, 0, 0)
    if (stroke.clip?.length) {
      pathTo(lr.ctx, stroke.clip, lr.scale, 0, 0)
      lr.ctx.clip()
    }
    renderSamples(lr.ctx, stroke.tool, stroke.color, batch, seed, curStrokeSize, stroke)
    lr.ctx.restore()
    lr.last = batch[batch.length - 1]
  }

  // Live eraser preview: erase straight into the layer's cached raster and
  // re-composite the page. destination-out on the display canvas would erase
  // the paper and every layer together — a dark line until the next repaint.
  function eraseLiveIntoRaster(
    stroke: Stroke,
    samples: ReturnType<InkEngine['end']>,
    s: number,
    layerId: string,
    size: number,
  ) {
    const p = currentPage()
    const layer = pageLayers().find((item) => item.id === layerId)
    if (!p || !ink || !layer?.visible) return
    const raster =
      stroke.mask || (store.maskEdit && layer.mask)
        ? layerMaskRasterCanvas(p, ink, layer.id)
        : layerRasterCanvas(p, ink, layer.id)
    if (!raster) return
    const rc = raster.getContext('2d', { willReadFrequently: true })
    if (!rc) return
    backupRaster(raster)
    const scale = raster.width / pw()
    rc.save()
    rc.setTransform(scale, 0, 0, scale, 0, 0)
    // A focused-half stroke carries a clip polygon: the eraser's bite stops
    // at the fold instead of nibbling the hidden half's pixels.
    if (stroke.clip?.length) {
      pathTo(rc, stroke.clip, scale, 0, 0)
      rc.clip()
    }
    renderSamples(rc, 'eraser', stroke.color, samples, s, size, stroke)
    const mirrored = mirroredSampleSets(samples)
    if (mirrored.length) renderSamples(rc, 'eraser', stroke.color, mirrored, s, size, stroke)
    rc.restore()
    // Record the erased region so the scheduled repaint can clip-composite
    // just this area; stamped tips scatter paint beyond the sample radius.
    const spread =
      stroke.tip && stroke.tip !== 'round' ? (stroke.jitter ?? 0) + (stroke.scatter ?? 0) : 0
    const addDirty = (set: Sample[]) => {
      if (!set.length) return
      let l = Infinity,
        t = Infinity,
        r = -Infinity,
        b = -Infinity
      for (const sm of set) {
        const rad = sm.w * size * (1 + spread) + 2
        if (sm.x - rad < l) l = sm.x - rad
        if (sm.x + rad > r) r = sm.x + rad
        if (sm.y - rad < t) t = sm.y - rad
        if (sm.y + rad > b) b = sm.y + rad
      }
      const pr = layerRectToPage(layerId, { x: l, y: t, w: r - l, h: b - t })
      if (!eraseDirty) eraseDirtyView = { ...view }
      eraseDirty = eraseDirty
        ? {
            x: Math.min(eraseDirty.x, pr.x),
            y: Math.min(eraseDirty.y, pr.y),
            w: Math.max(eraseDirty.x + eraseDirty.w, pr.x + pr.w) - Math.min(eraseDirty.x, pr.x),
            h: Math.max(eraseDirty.y + eraseDirty.h, pr.y + pr.h) - Math.min(eraseDirty.y, pr.y),
          }
        : pr
    }
    addDirty(samples)
    addDirty(mirrored)
    // Only mark the snapshot dirty — callers schedule the repaint so repaint-
    // driven drawSamples calls (reRender's live repaint) can't loop forever.
    snapDirty = true
  }

  function paintShapeDrag(
    drag: NonNullable<typeof shapeDrag>,
    end: { x: number; y: number },
    commit: boolean,
  ) {
    if (!ink) return
    // The drag's far corner pins to the fold — a shape can't grow into the
    // hidden half.
    const e = clampWork(end)
    const startPoint = toLayerPt({ ...drag.start, t: 0, p: 0.5 }, drag.layerId)
    const endPoint = toLayerPt({ ...e, t: 16, p: 0.5 }, drag.layerId)
    if (Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y) < 3) {
      reRender()
      return
    }

    // A committed shape lands on its own new layer so the transform tool can
    // grab it right away; the fresh layer has identity transform, so points
    // map straight into its space from the on-screen drag.
    const layerId = commit ? (addLayer()?.id ?? drag.layerId) : drag.layerId
    const pts = shapePoints(
      drag.shape,
      toLayerPt({ ...drag.start, t: 0, p: 0.5 }, layerId),
      toLayerPt({ ...e, t: 16, p: 0.5 }, layerId),
    )
    const id = ink.begin('shapes', drag.size, -1)
    const samples = pts.flatMap((point) => ink!.addPoint(id, point.x, point.y, point.t, point.p))
    samples.push(...ink.end(id))
    const stroke: Stroke = {
      tool: 'shapes',
      color: drag.color,
      pts,
      size: drag.size,
      layerId,
      alphaLock: pageLayers().find((item) => item.id === layerId)?.alphaLock || undefined,
    }
    reRender()
    drawSamples(stroke, samples, seed, layerId, drag.size)
    if (commit) {
      pushStroke(stroke)
      seed++
      store.tool = 'transform'
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
    rot: { angle: number; cx: number; cy: number } | null = null,
  ) {
    const p = currentPage()
    if (!p || !ink) return
    paintLayers(el, c, p, ink, scale, ox, oy, false, scale, ox, oy, undefined, rot)
  }

  // --- page snapshot ---------------------------------------------------------
  // Committed strokes+ops are cached in an offscreen canvas so pans and zooms
  // blit it in one drawImage instead of replaying the whole page per frame
  // (flood fills read every pixel back — far too heavy per pointermove). It is
  // rebuilt only when content changes (snapDirty) or when zooming in past its
  // resolution — except mid-pinch, where the blit upscales the existing raster
  // and the high-res rebuild waits for the gesture to settle. Without that
  // gate every pointermove replays the whole page into an ever-larger bitmap.
  const SNAP_HEADROOM = 2 // build at 2x the needed device scale so zoom stays crisp
  const SNAP_MAX_DIM = 4096 // px cap on the largest side; past it the blit upscales
  let snap: { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null
  let snapScale = 0 // device px per page unit in the snapshot
  let snapDirty = true

  function ensureSnap() {
    if (!ink) return
    const maxScale = Math.min(SNAP_MAX_DIM / pw(), SNAP_MAX_DIM / ph())
    const want = Math.min(view.s * dpr * SNAP_HEADROOM, maxScale)
    if (!snap) {
      const c = document.createElement('canvas')
      const c2 = c.getContext('2d', { willReadFrequently: true })
      if (!c2) return
      snap = { c, ctx: c2 }
    }
    if (!snapDirty && (gestureActive || snapScale >= want * 0.999)) return
    snapScale = Math.min(Math.max(want, snapScale), maxScale)
    const { c, ctx: sc } = snap
    c.width = Math.round(pw() * snapScale)
    c.height = Math.round(ph() * snapScale)
    sc.setTransform(1, 0, 0, 1, 0, 0)
    sc.fillStyle = PAPER
    sc.fillRect(0, 0, c.width, c.height)
    setRasterScaleHint(snapScale)
    replayPageInto(c, sc, snapScale, 0, 0)
    snapDirty = false
  }

  function reRender() {
    if (!ctx || !ink || !canvas.value) return
    eraseDirty = null
    eraseDirtyView = null
    ensureSnap()
    const el = canvas.value!
    paintPaper(ctx)
    const clipped = clipWork(ctx)
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
          viewRot(),
        )
        if (clipped) ctx.restore()
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
      replayPageInto(el, ctx, dpr * view.s, dpr * view.ox, dpr * view.oy, viewRot())
    }
    if (clipped) ctx.restore()
    drawSheetMarker()
    // A full repaint wipes the in-progress stroke — put it back in one fill.
    if (drawing && liveStroke && curSamples.length) {
      drawSamples(liveStroke, curSamples, seed)
      liveDirty = livePaintBounds(liveStroke, curSamples)
    }
    drawTransformControls()
    drawGuide()
  }

  // Working-rect center marker — a subtle cross in page space (pans/zooms
  // with it) — plus a faint fold line down the middle of a landscape sheet.
  function drawSheetMarker() {
    if (!ctx) return
    const r = workRect()
    const cx = r.x + r.w / 2
    const cy = r.y + r.h / 2
    ctx.save()
    setPageTransform(ctx)
    ctx.lineWidth = 1 / view.s
    if (pw() > ph()) {
      ctx.strokeStyle = 'rgba(60,60,60,0.14)'
      ctx.beginPath()
      ctx.moveTo(pw() / 2, 0)
      ctx.lineTo(pw() / 2, ph())
      ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(60,60,60,0.28)'
    ctx.beginPath()
    const cs = 6 // page units half-length of the cross arms
    ctx.moveTo(cx - cs, cy)
    ctx.lineTo(cx + cs, cy)
    ctx.moveTo(cx, cy - cs)
    ctx.lineTo(cx, cy + cs)
    ctx.stroke()
    ctx.restore()
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
    // The drag delta is stored in page units; rotate it into screen space.
    const cos = Math.cos(view.angle)
    const sin = Math.sin(view.angle)
    const dx = (cutPending.dx * cos - cutPending.dy * sin) * dpr * view.s
    const dy = (cutPending.dx * sin + cutPending.dy * cos) * dpr * view.s
    ctx.drawImage(cutPending.piece, dx, dy)
    ctx.restore()
  }

  function drawCutSegment(a: { x: number; y: number }, b: { x: number; y: number }) {
    if (!ctx) return
    const clipped = clipWork(ctx)
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
    if (clipped) ctx.restore()
  }

  // Pointer pt -> layer-local pt, snapped onto the drawing guide (line/arc)
  // when one is active. Guides snap ink strokes only.
  function toLayerSnapped(pt: Pt, layerId: string): Pt {
    if (store.guide === 'off' || !INK_TOOLS.includes(store.tool)) return toLayerPt(pt, layerId)
    const pg = snapToGuide({ x: toPageX(pt.x), y: toPageY(pt.y) })
    return toLayerPt({ ...pt, x: pg.x * view.s + view.ox, y: pg.y * view.s + view.oy }, layerId)
  }

  // Mirrored variants of live samples under the current symmetry mode —
  // mirrored across the working rect's axes so a focused half mirrors
  // inside itself instead of spilling onto the hidden half.
  function mirroredSampleSets(samples: Sample[]): Sample[] {
    return mirroredSamples(samples, store.symmetry, workRect())
  }

  function beginStroke(pt: Pt) {
    if (!ink) return
    strokeOut = !inWork(pt.x, pt.y)
    if (strokeOut) return // the focused half is a hard edge
    const layer = activeLayer()
    if (!layer) return
    curLayerId = layer.id
    curStrokeSize = brushOf(store.tool).size
    curStab = INK_TOOLS.includes(store.tool) ? brushOf(store.tool).stab : -1
    strokeId = ink.begin(store.tool, curStrokeSize, curStab)
    const q = toLayerSnapped(pt, curLayerId)
    curPts = [q]
    curSamples = []
    liveDirty = null
    if (eraseBackup) eraseBackup.raster = null
    // The live stroke carries the brush snapshot from the start so what the
    // user sees while drawing is exactly what the committed replay paints.
    liveStroke = {
      tool: store.tool,
      color: store.color,
      pts: curPts,
      size: curStrokeSize,
      stab: curStab >= 0 ? curStab : undefined,
      layerId: curLayerId,
      clip: workClip(layer) ?? undefined,
      ...(INK_TOOLS.includes(store.tool) ? brushSnapshot(store.tool) : null),
    }
    drawing = true
    if (rasterLiveTool(liveStroke, layer)) {
      const raster = currentPage() ? layerRasterCanvas(currentPage()!, ink, layer.id) : null
      const rc = raster?.getContext('2d', { willReadFrequently: true })
      if (raster && rc) {
        backupRaster(raster)
        liveRaster = {
          canvas: raster,
          ctx: rc,
          scale: raster.width / pw(),
          layerId: layer.id,
          last: null,
        }
      }
    }
    const s = ink.addPoint(strokeId, q.x, q.y, q.t, q.p)
    curSamples.push(...s)
    paintLiveRaster(s)
    if (liveStroke.tool === 'eraser') {
      drawSamples(liveStroke, s, seed)
      scheduleRepaint()
    } else {
      repaintLive()
    }
  }

  function addStrokePoint(pt: Pt) {
    if (!ink) return
    if (!inWork(pt.x, pt.y)) {
      // Off the focused half: park the stroke — its committed part ends at
      // the fold and can't paint or erase the hidden half.
      if (drawing) finishStroke(true)
      strokeOut = true
      return
    }
    if (!drawing) {
      if (!strokeOut) return
      beginStroke(pt) // re-entering the half starts a new stroke
      return
    }
    const q = toLayerSnapped(pt, curLayerId)
    curPts.push(q)
    const s = ink.addPoint(strokeId, q.x, q.y, q.t, q.p)
    curSamples.push(...s)
    paintLiveRaster(s)
    // The live eraser paints incrementally into the layer raster; ink tools
    // repaint the whole stroke once per event in repaintLive().
    if (liveStroke?.tool === 'eraser') {
      drawSamples(liveStroke, s, seed)
      scheduleRepaint()
    }
  }

  function finishStroke(commit: boolean) {
    if (!ink || !drawing) return
    const tail = ink.end(strokeId)
    curSamples.push(...tail)
    paintLiveRaster(tail)
    const strokeLayer = pageLayers().find((item) => item.id === curLayerId)
    const toMask = store.maskEdit && !!strokeLayer?.mask && INK_TOOLS.includes(store.tool)
    const stroke: Stroke = {
      ...liveStroke!,
      mask: toMask || undefined,
      alphaLock: !toMask && strokeLayer?.alphaLock && store.tool !== 'eraser' ? true : undefined,
    }
    const strokePts = curPts
    if (stroke.tool === 'eraser') {
      drawSamples(stroke, tail, seed)
      scheduleRepaint()
    } else {
      repaintLive(stroke)
    }
    // Clear the live state before committing: the strokes watcher repaints
    // synchronously, and a still-live stroke would be painted twice.
    drawing = false
    strokeId = -1
    curPts = []
    curSamples = []
    liveStroke = null
    curLayerId = ''
    liveDirty = null
    if (stroke.tool === 'eraser') {
      if (commit) {
        // The live preview erased into the cached raster — drop it so the
        // committed stroke replays from a clean layer instead.
        clearLayerRasterCache(store.pageId ?? undefined, stroke.layerId || undefined)
      } else if (eraseBackup?.raster) {
        // Cancelled by the pinch's second finger: restore the raster the
        // preview erased. The cache entry stays valid (same signature), so
        // the next repaint composites instead of re-replaying the layer.
        const bc2 = eraseBackup.raster.getContext('2d', { willReadFrequently: true })
        if (bc2) {
          bc2.setTransform(1, 0, 0, 1, 0, 0)
          bc2.drawImage(eraseBackup.c, 0, 0)
        }
      }
      if (eraseBackup) eraseBackup.raster = null
      snapDirty = true
    }
    if (liveRaster) {
      // A cancelled stroke (pinch's second finger) rolls its incremental
      // paint back; a committed one is folded into the signature below.
      if (!commit) restoreRaster(liveRaster.canvas)
      if (eraseBackup) eraseBackup.raster = null
    }
    if (commit && strokePts.length) {
      const p = currentPage()
      if (liveRaster && p && strokeLayer) {
        // The raster already holds this stroke — keep the strokes watcher
        // from re-rendering it and adopt the live paint as the fresh tail.
        // If the push evicted the oldest stroke (page cap) the raster's
        // painted prefix is stale — fall back to a normal replay.
        const first = p.strokes[0]
        suppressStrokeRebuild = true
        try {
          pushStroke(stroke)
        } finally {
          suppressStrokeRebuild = false
        }
        // The raster didn't take the live paint (eviction or cache rebuild)
        // — roll it back so the closing reRender's replay doesn't double up.
        if (p.strokes[0] !== first || !adoptLayerRasterTail(p, strokeLayer, liveRaster.canvas))
          restoreRaster(liveRaster.canvas)
      } else {
        pushStroke(stroke) // strokes watcher -> refresh() rebuilds the snapshot
        for (const pts of mirroredPtSets(strokePts, workRect())) pushStroke({ ...stroke, pts })
      }
      seed++
    }
    liveRaster = null
    reRender()
  }

  function layerRectToPage(layerId: string, r: { x: number; y: number; w: number; h: number }) {
    const layer = pageLayers().find((item) => item.id === layerId)
    return layerRectToPageMath(layer, r, pw(), ph())
  }

  // Page-space bounds of everything a live repaint can touch: all samples
  // (plus mirrored symmetry copies) inflated by the painted radius — brush
  // size scales sample widths and stamped tips scatter beyond it — then
  // mapped through the layer transform.
  function livePaintBounds(stroke: Stroke, samples: Sample[]) {
    if (!samples.length) return null
    const spread =
      stroke.tip && stroke.tip !== 'round' ? (stroke.jitter ?? 0) + (stroke.scatter ?? 0) : 0
    let l = Infinity,
      t = Infinity,
      r = -Infinity,
      b = -Infinity
    for (const set of [samples, mirroredSampleSets(samples)])
      for (const sm of set) {
        const rad = sm.w * curStrokeSize * (1 + spread) + 2
        if (sm.x - rad < l) l = sm.x - rad
        if (sm.x + rad > r) r = sm.x + rad
        if (sm.y - rad < t) t = sm.y - rad
        if (sm.y + rad > b) b = sm.y + rad
      }
    return layerRectToPage(stroke.layerId ?? curLayerId, { x: l, y: t, w: r - l, h: b - t })
  }

  // Repaint the in-progress stroke as one fill: restore the snapshot under
  // the region it covers, then draw every emitted sample plus the tail the
  // engine would flush if the stroke ended now (taper + final raw point) —
  // the visible tip matches the committed stroke instead of snapping on
  // release. Translucent tools can't be painted incrementally — overlapping
  // batch joins double-darken — so the live stroke re-renders whole,
  // exactly like committed replay does in layers.ts.
  function repaintLive(stroke: Stroke | null = liveStroke) {
    // The eraser's preview lives in the layer raster, not on the display —
    // its repaint goes through repaintEraseRegion/scheduleRepaint instead.
    if (!ctx || !stroke || stroke.tool === 'eraser') return
    if (!snap) {
      reRender() // rebuilds committed content and repaints the live stroke
      return
    }
    const clipped = clipWork(ctx)
    if (liveDirty) {
      const r = liveDirty
      ctx.save()
      setPageTransform(ctx)
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
      ctx.restore()
      drawSheetMarker()
    }
    const tailSamples = ink && drawing && typeof ink.tail === 'function' ? ink.tail(strokeId) : []
    const all = tailSamples.length ? curSamples.concat(tailSamples) : curSamples
    if (all.length) drawSamples(stroke, all, seed)
    liveDirty = livePaintBounds(stroke, all)
    if (clipped) ctx.restore()
    drawTransformControls()
    drawGuide()
  }

  // ---- gestures ----
  function gestureMetrics(): { dist: number; angle: number; x: number; y: number } | null {
    if (pointers.size !== 2) return null
    const [a, b] = [...pointers.values()]
    // Chord and midpoint in raw screen space: the chord's rotation drives
    // view.angle; midpoints map to unrotated space per-frame in the handler.
    return {
      dist: Math.hypot(b.gx - a.gx, b.gy - a.gy),
      angle: Math.atan2(b.gy - a.gy, b.gx - a.gx),
      x: (a.gx + b.gx) / 2,
      y: (a.gy + b.gy) / 2,
    }
  }

  function onPointerDown(e: PointerEvent) {
    const el = canvas.value!
    el.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    const { x, y } = toLocalPoint({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })

    if (e.pointerType === 'pen') penActive = true
    // palm rejection: ignore touches while a pen is drawing
    if (e.pointerType === 'touch' && penActive && drawing) return

    pointers.set(e.pointerId, {
      x,
      y,
      t: e.timeStamp,
      type: e.pointerType,
      gx: e.clientX,
      gy: e.clientY,
    })

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
      gAngle0 = m.angle
      // Midpoints are tracked in canvas-local space for toLocalPoint.
      gCenter0 = { x: m.x - rect.left, y: m.y - rect.top }
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
      cutPath = [clampWorkPage({ x: toPageX(x), y: toPageY(y) })]
      return
    }
    if (store.tool === 'shapes') {
      const layer = activeLayer()
      if (layer && inWork(x, y)) {
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
    const clipped = clipWork(c)
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
    if (clipped) c.restore()
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

  function cycleSpread() {
    store.spreadMode =
      SPREAD_MODES[(SPREAD_MODES.indexOf(store.spreadMode) + 1) % SPREAD_MODES.length]
  }

  function onPointerMove(e: PointerEvent) {
    const rec = pointers.get(e.pointerId)
    const { left, top } = canvas.value!.getBoundingClientRect()
    const { x, y } = toLocalPoint({ x: e.clientX - left, y: e.clientY - top })
    if (!rec) {
      if (e.pointerType === 'mouse') updateCanvasCursor(x, y)
      return
    }
    rec.x = x
    rec.y = y
    rec.t = e.timeStamp
    rec.gx = e.clientX
    rec.gy = e.clientY

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
      const wr = workRect()
      const cover = coverViewport(w, h, { w: wr.w, h: wr.h })
      const minS = Math.min(w / wr.w, h / wr.h) * ZOOM_MARGIN
      const nextS = Math.min(
        cover.s * ZOOM_MAX,
        Math.max(minS, (view.s * m.dist) / Math.max(gDist0, 1)),
      )
      const k = nextS / view.s
      let angleDelta = m.angle - gAngle0
      if (angleDelta > Math.PI) angleDelta -= Math.PI * 2
      if (angleDelta < -Math.PI) angleDelta += Math.PI * 2
      const nextAngle = view.angle + angleDelta
      // Keep the page point under the fingers' previous screen midpoint under
      // the new midpoint: local coords map at the pre/post-rotation angles.
      const prev = toLocalPoint(gCenter0)
      const next = toLocalPoint({ x: m.x - left, y: m.y - top }, nextAngle)
      view.s = nextS
      view.ox = next.x - (prev.x - view.ox) * k
      view.oy = next.y - (prev.y - view.oy) * k
      if (angleDelta) view.angle = nextAngle
      gDist0 = m.dist
      gAngle0 = m.angle
      gCenter0 = { x: m.x - left, y: m.y - top }
      syncZoomState()
      // Coalesce repaints to one per frame — pointermove can outpace vsync.
      scheduleRepaint()
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
          cutPath = edgeBuf.map((p) => clampWorkPage({ x: toPageX(p.x), y: toPageY(p.y) }))
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
      const ox = view.ox + (x - panStart.x)
      const oy = view.oy + (y - panStart.y)
      if (ox !== view.ox || oy !== view.oy) {
        view.ox = ox
        view.oy = oy
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
      const q = clampWorkPage({ x: toPageX(x), y: toPageY(y) })
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

    if (!drawing && !strokeOut) return
    // getCoalescedEvents() is empty for synthetic events — fall back to [e]
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null
    const events = coalesced?.length ? coalesced : [e]
    for (const ev of events) {
      const point = toLocalPoint({ x: ev.clientX - left, y: ev.clientY - top })
      addStrokePoint({ x: point.x, y: point.y, t: ev.timeStamp, p: ev.pressure || 0.5 })
    }
    repaintLive()
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
    const rot = viewRot()
    const srcClip = clipWork(sourceCtx)
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
      undefined,
      rot,
    )
    if (srcClip) sourceCtx.restore()
    // extractRegion clips by device-px coordinates, so the page-space cut
    // path goes through the full view transform (including rotation).
    const piece = extractRegion(source, sourceCtx, path.map(viewToDevice), 1, 0, 0, null)
    paintPaper(baseCtx)
    const baseClip = clipWork(baseCtx)
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
      undefined,
      rot,
    )
    if (baseClip) baseCtx.restore()

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
    // A focused spread half confines the op's pixels to it — the flood
    // can't cross the fold into the hidden half, now or on replay.
    const rect = workHalved() ? workRect() : undefined
    // 'erase' mode is the magic-wand background removal; 'invert' is the
    // inverse/background fill — both run on the layer raster like 'fill'.
    if (store.fillMode === 'erase') {
      pushOp({ kind: 'erase', x: toPageX(x), y: toPageY(y), after, alphaLock, rect })
    } else {
      pushOp({
        kind: 'fill',
        x: toPageX(x),
        y: toPageY(y),
        color: store.color,
        after,
        alphaLock,
        invert: store.fillMode === 'invert' || undefined,
        rect,
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
        syncZoomState()
        saveView()
        // Rebuilds the snapshot at the final zoom level — during the gesture
        // the blit upscaled the existing raster (slightly soft, but fast).
        reRender()
      }
      return
    }

    if (panStart) {
      panStart = null
      syncZoomState()
      saveView()
      return
    }

    if (layerTransformDrag) {
      const { left, top } = canvas.value!.getBoundingClientRect()
      flushLayerTransform(toLocalPoint({ x: e.clientX - left, y: e.clientY - top }))
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
        const local = toLocalPoint({ x: e.clientX - left, y: e.clientY - top })
        updateCanvasCursor(local.x, local.y)
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
          cutPath = edgeBuf.map((p) => clampWorkPage({ x: toPageX(p.x), y: toPageY(p.y) }))
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
    strokeOut = false
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
    const r0 = workRect()
    const scale = Math.min(1, (r0.w * 0.6) / img.w, (r0.h * 0.6) / img.h)
    const photoW = img.w * scale
    const photoH = img.h * scale
    const p = currentPage()
    if (!p) return
    const layer = addLayer()
    const r = r0
    pushOp({
      kind: 'photo',
      photo: {
        src: img.src,
        x: r.x + (r.w - photoW) / 2,
        y: r.y + (r.h - photoH) / 2,
        w: photoW,
        h: photoH,
      },
      after: p.strokes.length,
      layerId: layer?.id,
    })
    store.tool = 'transform'
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
      // Invalidate only the layers that draw photo ops — a decoded image
      // shouldn't drop every layer raster of the page.
      const p = currentPage()
      const layerIds = new Set(
        (p?.ops ?? [])
          .filter((op) => op.kind === 'photo')
          .map((op) => op.layerId ?? p?.layers?.[0]?.id ?? 'legacy'),
      )
      for (const id of layerIds) clearLayerRasterCache(store.pageId ?? undefined, id)
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
      // Live-into-raster commits already painted the stroke — their
      // caller's reRender recomposites without re-rendering it.
      if (!suppressStrokeRebuild) reRender()
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
    () => store.spreadMode,
    () => {
      applyViewport() // each side keeps its own saved framing
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
    if (repaintRaf) cancelAnimationFrame(repaintRaf)
    sizeObserver?.disconnect()
    window.removeEventListener('resize', resize)
    window.removeEventListener('keydown', onKeyDown)
    offImageLoad?.()
  })

  return {
    canvas,
    view,
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
    selectedLayer,
    layerPreview,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    cycleSymmetry,
    cycleGuide,
    cycleSpread,
    spreadCapable,
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
