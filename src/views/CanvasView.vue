<script setup lang="ts">
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
  selectLayer,
  updateLayer,
  reorderLayer,
  deleteLayer,
} from '../store'
import { initInk } from '../ink/engine'
import { renderSamples } from '../ink/renderer'
import {
  clearLayerRasterCache,
  layerContentBounds,
  layerRasterCanvas,
  paintLayers,
} from '../ink/layers'
import { extractRegion, onImageLoaded, imageFileToPhoto, imageDataURL } from '../ink/ops'
import { rdp } from '../ink/path'
import { shapePoints } from '../ink/shapes'
import { PAGE_W, PAGE_H, pageSize, coverViewport, clampOffset } from '../pageSpace'
import ToolTray from '../components/ToolTray.vue'
import MobileSlider from '../components/MobileSlider.vue'
import { BLEND_MODES } from '../types'
import type {
  BlendMode,
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
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const PAPER = '#f6f1e6'
const BACKDROP = '#2a2a2c'
const EDGE = 34 // px edge zone for page-swipe nav
const TRAY_HEIGHT = 86
// Tools that lay ink — they get the stabilizer setting and stroke previews.
const INK_TOOLS: ToolId[] = ['eraser', 'draw', 'sketch', 'outline', 'write', 'color']
type LayerBounds = { left: number; top: number; right: number; bottom: number }
type LayerPoint = { x: number; y: number }
type TransformHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate' | 'move'
type ResizeHandle = Exclude<TransformHandle, 'rotate' | 'move'>
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
const layers = computed(() => pageLayers())
const displayLayers = computed(() => [...layers.value].reverse())
const selectedLayer = computed(() => activeLayer())
const layerList = ref<HTMLElement>()
const draggingLayerId = ref<string | null>(null)

// Layer thumbnails in the panel: dataURLs of each layer's cached raster
// cropped to its content bounds (full-page thumbs lose thin strokes at
// this size), rebuilt whenever page content changes (thumbRev bumps in
// the watchers).
const THUMB_W = 56
const THUMB_H = 36
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
  const p = currentPage()
  if (!p || !ink) return null
  const bounds = layerContentBounds(p, ink, id, BOUNDS_SCALE)
  if (!bounds) return null
  const raster = layerRasterCanvas(p, ink, id)
  if (!raster) return null
  const c = document.createElement('canvas')
  c.width = THUMB_W
  c.height = THUMB_H
  const tc = c.getContext('2d')
  if (!tc || typeof c.toDataURL !== 'function') return null
  const rs = raster.width / pw()
  const pad = 4 / BOUNDS_SCALE
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
const layerDropIndex = ref<number | null>(null)
let layerDragPointerId: number | null = null
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
  if (!p) return null
  if (ink) {
    // Exact bounds of the rendered layer; the point-padding heuristic below
    // is only a fallback for environments without a canvas backend (jsdom).
    const bounds = layerContentBounds(p, ink, layerId, BOUNDS_SCALE)
    if (bounds !== undefined) return bounds
  }
  const defaultId = p.layers?.[0]?.id ?? 'legacy'
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
  for (const stroke of p.strokes) {
    if ((stroke.layerId ?? defaultId) !== layerId) continue
    const pad =
      (stroke.tool === 'color' ? 50 : stroke.tool === 'eraser' ? 30 : 15) * (stroke.size ?? 1)
    for (const point of stroke.pts) include(point.x, point.y, pad)
  }
  for (const op of p.ops ?? []) {
    if (op.layerId !== '*' && (op.layerId ?? defaultId) !== layerId) continue
    if (op.kind === 'fill') {
      include(0, 0)
      include(pw(), ph())
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

function cachedLayerBounds(layerId: string): LayerBounds | null {
  const pageId = store.pageId
  if (transformBoundsCache?.pageId === pageId && transformBoundsCache.layerId === layerId)
    return transformBoundsCache.bounds
  const bounds = getLayerBounds(layerId)
  transformBoundsCache = { pageId, layerId, bounds }
  return bounds
}

function layerPoint(
  layer: NonNullable<ReturnType<typeof activeLayer>>,
  point: LayerPoint,
): LayerPoint {
  const angle = (layer.rotation * Math.PI) / 180
  const dx = (point.x - pw() / 2) * layer.scale
  const dy = (point.y - ph() / 2) * layer.scale
  return {
    x: pw() / 2 + layer.x + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: ph() / 2 + layer.y + dx * Math.sin(angle) + dy * Math.cos(angle),
  }
}

function frameLocalPoints(
  bounds: LayerBounds,
): Record<Exclude<TransformHandle, 'rotate' | 'move'>, LayerPoint> {
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

function transformFrame(layer = selectedLayer.value) {
  if (!layer?.visible) return null
  if (layerPreview.value?.id === layer.id) layer = { ...layer, ...layerPreview.value }
  const bounds = cachedLayerBounds(layer.id)
  if (!bounds) return null
  const local = frameLocalPoints(bounds)
  const screen: Record<Exclude<TransformHandle, 'rotate' | 'move'>, LayerPoint> = {} as Record<
    Exclude<TransformHandle, 'rotate' | 'move'>,
    LayerPoint
  >
  for (const key of Object.keys(local) as (keyof typeof local)[]) {
    const pagePt = layerPoint(layer, local[key])
    screen[key] = { x: pagePt.x * view.s + view.ox, y: pagePt.y * view.s + view.oy }
  }
  const center = layerPoint(layer, {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
  })
  const centerScreen = { x: center.x * view.s + view.ox, y: center.y * view.s + view.oy }
  const top = screen.n
  const len = Math.hypot(top.x - centerScreen.x, top.y - centerScreen.y) || 1
  const rotate = {
    x: top.x + ((top.x - centerScreen.x) / len) * 24,
    y: top.y + ((top.y - centerScreen.y) / len) * 24,
  }
  return {
    bounds,
    local,
    screen,
    center: { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 },
    centerWorld: center,
    centerScreen,
    rotate,
  }
}

function hitTransformControl(
  frame: NonNullable<ReturnType<typeof transformFrame>>,
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

function cursorForHandle(
  frame: NonNullable<ReturnType<typeof transformFrame>>,
  handle: TransformHandle | null,
) {
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
      anchorLocal = frame.local[OPPOSITE_HANDLE[hit]]
      startHandleWorld = layerPoint(layer, frame.local[hit])
    }
    pivotLocal = frame.center
    pivotWorld = layerPoint(layer, frame.center)
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
    anchorWorld: anchorLocal ? layerPoint(layer, anchorLocal) : null,
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
    const zero = layerPoint({ ...layer, x: 0, y: 0, rotation }, drag.pivotLocal)
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
    const zero = layerPoint({ ...layer, x: 0, y: 0, scale }, drag.anchorLocal)
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
let snapPage: string | null = null // page the snapshot was built for
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
  snapPage = store.pageId
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
  const sets: Sample[][] = []
  const mv = (s: Sample) => ({ ...s, x: pw() - s.x })
  const mh = (s: Sample) => ({ ...s, y: ph() - s.y })
  if (store.symmetry === 'v' || store.symmetry === 'xy') sets.push(samples.map(mv))
  if (store.symmetry === 'h' || store.symmetry === 'xy') sets.push(samples.map(mh))
  if (store.symmetry === 'xy') sets.push(samples.map((s) => mh(mv(s))))
  return sets.flat()
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
function sampleBounds(samples: Sample[]) {
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
function layerRectToPage(layerId: string, r: { x: number; y: number; w: number; h: number }) {
  const layer = pageLayers().find((item) => item.id === layerId)
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
    const dx = px - pw() / 2
    const dy = py - ph() / 2
    const x = pw() / 2 + layer.x + (dx * cos - dy * sin) * layer.scale
    const y = ph() / 2 + layer.y + (dx * sin + dy * cos) * layer.scale
    if (x < left) left = x
    if (x > right) right = x
    if (y < top) top = y
    if (y > bottom) bottom = y
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
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

function toggleLayerMask(on: boolean) {
  const layer = selectedLayer.value
  if (!layer) return
  updateLayer(layer.id, { mask: on || undefined })
  store.maskEdit = on
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
  cancelLayerReorder()
}

function startLayerReorder(e: PointerEvent, id: string) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  layerDragPointerId = e.pointerId
  draggingLayerId.value = id
  layerDropIndex.value = displayLayers.value.findIndex((layer) => layer.id === id)
}

function moveLayerReorder(e: PointerEvent) {
  if (layerDragPointerId !== e.pointerId) return
  const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  const row = target?.closest<HTMLElement>('.layer-row')
  if (!row || !layerList.value?.contains(row)) return
  const targetIndex = Number(row.dataset.displayIndex)
  const bounds = row.getBoundingClientRect()
  const fromIndex = displayLayers.value.findIndex((layer) => layer.id === draggingLayerId.value)
  let toIndex = targetIndex + (e.clientY > bounds.top + bounds.height / 2 ? 1 : 0)
  if (toIndex > fromIndex) toIndex--
  layerDropIndex.value = Math.max(0, Math.min(displayLayers.value.length - 1, toIndex))
}

function finishLayerReorder(e: PointerEvent) {
  if (layerDragPointerId !== e.pointerId) return
  const id = draggingLayerId.value
  const displayIndex = layerDropIndex.value
  cancelLayerReorder()
  if (id && displayIndex !== null) reorderLayer(id, displayLayers.value.length - 1 - displayIndex)
}

function cancelLayerReorder() {
  layerDragPointerId = null
  draggingLayerId.value = null
  layerDropIndex.value = null
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
</script>

<template>
  <div class="canvas-view" :style="{ '--tray-height': `${TRAY_HEIGHT}px` }">
    <aside
      v-if="!['fill', 'cut', 'move', 'transform'].includes(store.tool)"
      class="brush-rail"
      :class="{ expanded: INK_TOOLS.includes(store.tool) }"
    >
      <span class="brush-value">{{ Math.round(brushSize * 100) }}%</span>
      <div class="brush-control" :style="{ '--brush-mark-width': brushMarkWidth }">
        <div class="brush-mark" />
        <span
          class="brush-thumb"
          :style="{ top: `${100 - brushProgress * 100}%`, width: brushMarkWidth, height: brushMarkWidth }"
        />
        <input
          class="brush-slider"
          type="range"
          min="0.25"
          max="4"
          step="0.05"
          :value="brushSize"
          :aria-label="t('canvas.size')"
          @input="brushOf(store.tool).size = Number(($event.target as HTMLInputElement).value)"
          @pointerdown.stop
        />
      </div>
      <template v-if="INK_TOOLS.includes(store.tool)">
        <span class="brush-value stab">{{ Math.round(brushOf(store.tool).stab * 100) }}%</span>
        <div class="stab-control">
          <div class="stab-track" />
          <span class="stab-thumb" :style="{ top: `${(1 - brushOf(store.tool).stab) * 100}%` }" />
          <input
            class="brush-slider"
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="brushOf(store.tool).stab"
            :aria-label="t('canvas.stabilize')"
            @input="brushOf(store.tool).stab = Number(($event.target as HTMLInputElement).value)"
            @pointerdown.stop
          />
        </div>
      </template>
    </aside>

    <canvas
      ref="canvas"
      :class="[navClass, { grab: store.tool === 'move' }]"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerUp"
      @contextmenu.prevent
    />

    <button class="close-btn" @click="closeToJournal" :title="t('canvas.close')">
      <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>

    <div class="page-badge" v-if="journal">
      {{ journal.title }} — {{ pageIndex + 1 }}/{{ journal.pages.length }}
    </div>

    <div class="top-actions">
      <button class="round-btn" :disabled="!undoOk" @click="undoStroke() && reRender()" :title="t('canvas.undo')">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
      </button>
      <button class="round-btn" :disabled="!redoOk" @click="redoStroke() && reRender()" :title="t('canvas.redo')">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg>
      </button>
      <button class="round-btn" :class="{ selected: layerPanelOpen }" @click="layerPanelOpen = !layerPanelOpen" :title="t('layers.title')">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>
      </button>
      <button class="round-btn" :class="{ selected: store.symmetry !== 'none' }" @click="cycleSymmetry" :title="t('canvas.symmetry')">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M8 5 4 8l4 3V5ZM8 13l-4 3 4 3v-6ZM16 5l4 3-4 3V5ZM16 13l4 3-4 3v-6Z"/><path v-if="store.symmetry === 'h' || store.symmetry === 'xy'" d="M4 12h16" stroke-dasharray="2 2"/><path v-if="store.symmetry === 'v' || store.symmetry === 'xy'" d="M12 4v16" stroke-dasharray="2 2"/></svg>
      </button>
      <button class="round-btn" :class="{ selected: store.guide !== 'off' }" @click="cycleGuide" :title="t('canvas.guide')">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path v-if="store.guide === 'arc'" d="M4 18a8 8 0 0 1 16 0"/><path v-else d="M4 18 20 6"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>
      </button>
    </div>

    <MobileSlider
      :open="layerPanelOpen"
      :title="t('layers.title')"
      size="sm"
      :z-index="1000"
      @update:open="closeLayerModal"
    >
      <template #actions>
        <button class="layer-add" :title="t('layers.add')" :aria-label="t('layers.add')" @click="addLayer">+</button>
      </template>
      <div ref="layerList" class="layer-list">
        <div
          v-for="(layer, index) in displayLayers"
          :key="layer.id"
          class="layer-row"
          :data-layer-id="layer.id"
          :data-display-index="index"
          :class="{
            active: selectedLayer?.id === layer.id,
            dragging: draggingLayerId === layer.id,
            'drop-target': layerDropIndex === index && draggingLayerId !== layer.id,
          }"
          @click="selectLayer(layer.id)"
        >
          <button class="layer-eye" @click.stop="updateLayer(layer.id, { visible: !layer.visible })" :title="layer.visible ? t('layers.hide') : t('layers.show')">
            {{ layer.visible ? '◉' : '○' }}
          </button>
          <img
            v-if="layerThumb(layer.id)"
            class="layer-thumb"
            :src="layerThumb(layer.id)"
            :alt="layer.name"
          />
          <div v-else class="layer-thumb" />
          <input
            v-model="layer.name"
            class="layer-name"
            :aria-label="t('layers.name')"
            @click.stop
            @change="updateLayer(layer.id, { name: layer.name })"
          />
          <button
            class="layer-grab"
            :title="t('layers.reorder')"
            :aria-label="t('layers.reorder')"
            @pointerdown.stop="startLayerReorder($event, layer.id)"
            @pointermove="moveLayerReorder"
            @pointerup="finishLayerReorder"
            @pointercancel="cancelLayerReorder"
            @lostpointercapture="cancelLayerReorder"
            @click.stop
          >⠿</button>
          <button class="layer-delete" :disabled="layers.length <= 1" @click.stop="deleteLayer(layer.id)" :title="t('layers.delete')">×</button>
        </div>
      </div>
      <div v-if="selectedLayer" class="layer-properties">
        <label>{{ t('layers.opacity') }} <span>{{ Math.round(selectedLayer.opacity * 100) }}%</span></label>
        <input
          type="range" min="0" max="1" step="0.01" :value="selectedLayer.opacity"
          @input="updateLayer(selectedLayer.id, { opacity: Number(($event.target as HTMLInputElement).value) })"
        />
        <label>{{ t('layers.blend') }}</label>
        <select
          class="layer-blend"
          :value="selectedLayer.blend ?? 'source-over'"
          :aria-label="t('layers.blend')"
          @change="updateLayer(selectedLayer.id, { blend: ($event.target as HTMLSelectElement).value as BlendMode })"
        >
          <option v-for="mode in BLEND_MODES" :key="mode" :value="mode">
            {{ t(`layers.blends.${mode}`) }}
          </option>
        </select>
        <label class="layer-flag">
          <input
            type="checkbox"
            :checked="!!selectedLayer.alphaLock"
            @change="updateLayer(selectedLayer.id, { alphaLock: ($event.target as HTMLInputElement).checked })"
          />
          {{ t('layers.alphaLock') }}
        </label>
        <label class="layer-flag">
          <input
            type="checkbox"
            :checked="!!selectedLayer.clip"
            @change="updateLayer(selectedLayer.id, { clip: ($event.target as HTMLInputElement).checked })"
          />
          {{ t('layers.clip') }}
        </label>
        <label class="layer-flag">
          <input
            type="checkbox"
            :checked="!!selectedLayer.mask"
            @change="toggleLayerMask(($event.target as HTMLInputElement).checked)"
          />
          {{ t('layers.mask') }}
        </label>
        <label v-if="selectedLayer.mask" class="layer-flag">
          <input type="checkbox" v-model="store.maskEdit" />
          {{ t('layers.maskEdit') }}
        </label>
      </div>
    </MobileSlider>

    <div class="zoom-actions">
      <button v-if="!isFit" class="round-btn fit-btn" @click="resetView" :title="t('canvas.zoomFit')">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5 M15 4h5v5 M9 20H4v-5 M15 20h5v-5"/></svg>
      </button>
      <button class="round-btn" :disabled="!canZoomIn" @click="zoomBy(ZOOM_STEP)" :title="t('canvas.zoomIn')">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <button class="round-btn" :disabled="!canZoomOut" @click="zoomBy(1 / ZOOM_STEP)" :title="t('canvas.zoomOut')">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>

    <ToolTray @photo="importPhoto" />
  </div>
</template>

<style scoped>
.canvas-view {
  position: relative;
  height: 100%;
  background: #2a2a2c;
}
.brush-rail {
  position: absolute;
  z-index: 12;
  left: 12px;
  top: 50%;
  transform: translateY(-58%);
  width: 48px;
  height: 224px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border: 1px solid var(--brush-panel-border);
  border-radius: 22px;
  background: var(--brush-panel-bg);
  color: var(--brush-panel-text);
  box-shadow: 0 6px 22px var(--brush-panel-shadow);
  backdrop-filter: blur(12px);
}
/* Touch-first devices: the rail overlaps the page on small screens. */
@media (pointer: coarse) {
  .brush-rail { display: none; }
}
.brush-value { font: 600 10px/1 ui-monospace, monospace; color: var(--brush-value); }
.brush-control {
  position: relative;
  width: 24px;
  height: 158px;
  display: grid;
  place-items: center;
}
.brush-mark {
  width: var(--brush-mark-width);
  height: 100%;
  background: var(--brush-mark);
  clip-path: polygon(12% 0, 88% 0, 68% 91%, 58% 99%, 50% 100%, 42% 99%, 32% 91%);
}
.brush-thumb {
  position: absolute;
  left: 50%;
  z-index: 1;
  border: 1px solid var(--brush-thumb-border);
  border-radius: 50%;
  background: var(--brush-thumb);
  box-shadow: 0 1px 3px var(--brush-thumb-shadow);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.brush-slider {
  position: absolute;
  inset: 0;
  z-index: 2;
  height: 100%;
  width: 100%;
  margin: 0;
  opacity: 0;
  writing-mode: vertical-lr;
  direction: rtl;
  touch-action: none;
}
.brush-rail.expanded {
  height: 306px;
}
.brush-value.stab {
  opacity: 0.65;
}
.stab-control {
  position: relative;
  width: 24px;
  height: 56px;
  display: grid;
  place-items: center;
}
.stab-track {
  width: 3px;
  height: 100%;
  border-radius: 2px;
  background: var(--brush-mark);
}
.stab-thumb {
  position: absolute;
  left: 50%;
  width: 12px;
  height: 12px;
  border: 1px solid var(--brush-thumb-border);
  border-radius: 50%;
  background: var(--brush-thumb);
  box-shadow: 0 1px 3px var(--brush-thumb-shadow);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
canvas {
  display: block;
  width: 100%;
  /* Keep the drawing viewport above the overlaying tool tray. */
  height: calc(100% - var(--tray-height));
  touch-action: none;
}
canvas.from-right { animation: slide-from-right 0.28s ease; }
canvas.from-left { animation: slide-from-left 0.28s ease; }
canvas.grab { cursor: grab; }
.close-btn {
  position: absolute;
  top: 16px;
  left: 18px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(40, 40, 42, 0.75);
  color: #eee;
  display: grid;
  place-items: center;
  z-index: 20;
}
@media (hover: hover) {
  .close-btn:hover { background: rgba(40, 40, 42, 0.9); }
}
.top-actions {
  position: absolute;
  top: 16px;
  right: 18px;
  display: flex;
  gap: 10px;
  z-index: 20;
}
.round-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(40, 40, 42, 0.75);
  color: #eee;
  display: grid;
  place-items: center;
}
@media (hover: hover) {
  .round-btn:hover { background: rgba(40, 40, 42, 0.9); }
}
.round-btn:disabled { opacity: 0.35; cursor: default; }
.round-btn.selected { color: #6dbbcf; background: rgba(40, 40, 42, .95); }
.layer-add, .layer-delete, .layer-eye, .layer-grab {
  display: grid;
  place-items: center;
  line-height: 1;
  color: var(--chrome-text);
  background: transparent;
  border-radius: 8px;
}
.layer-add {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  font-size: 24px;
  background: var(--chrome-control-bg);
}
@media (hover: hover) {
  .layer-add:hover { background: var(--chrome-hover); }
}
.layer-list { min-height: 48px; padding: 6px 3px; overscroll-behavior: contain; }
.layer-row {
  position: relative;
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 3px;
  border: 1px solid transparent;
  border-radius: 9px;
  padding: 3px;
}
.layer-row.active { border-color: var(--layer-active-border); background: var(--layer-active-bg); }
.layer-row.dragging { opacity: .38; }
.layer-row.drop-target { outline: 2px solid var(--layer-accent-bg); outline-offset: 1px; }
.layer-eye { width: 28px; height: 30px; font-size: 14px; }
.layer-thumb {
  width: 46px;
  height: 30px;
  flex: 0 0 auto;
  object-fit: contain;
  border-radius: 5px;
  border: 1px solid var(--chrome-border);
  background:
    repeating-conic-gradient(rgba(128,128,128,.28) 0% 25%, rgba(255,255,255,.28) 0% 50%) 0 0 / 8px 8px;
}
.layer-name {
  min-width: 30px;
  flex: 1;
  height: 30px;
  padding: 0;
  color: var(--chrome-text);
  background: transparent;
  border: 0;
  outline: 0;
  font-size: 12px;
  line-height: 30px;
}
.layer-grab {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  font-size: 19px;
  color: var(--chrome-muted);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.layer-grab:active { cursor: grabbing; }
.layer-delete { width: 28px; height: 30px; font-size: 18px; }
.layer-delete:disabled { opacity: .25; }
.layer-properties {
  display: grid;
  gap: 5px;
  padding: 10px 14px 13px;
  border-top: 1px solid var(--chrome-border);
}
.layer-properties label {
  display: flex;
  justify-content: space-between;
  color: var(--chrome-muted);
  font-size: 11px;
  margin-top: 2px;
}
.layer-properties label span { color: var(--layer-accent); font-variant-numeric: tabular-nums; }
.layer-properties input[type="range"] { width: 100%; margin: 0; accent-color: var(--layer-accent); }
.layer-blend {
  width: 100%;
  height: 30px;
  color: var(--chrome-text);
  background: var(--chrome-control-bg);
  border: 1px solid var(--chrome-border);
  border-radius: 8px;
  font-size: 12px;
}
.layer-properties label.layer-flag {
  justify-content: flex-start;
  align-items: center;
  gap: 8px;
  color: var(--chrome-text);
  font-size: 12px;
  cursor: pointer;
}
.layer-flag input { accent-color: var(--layer-accent); margin: 0; }
.zoom-actions {
  position: absolute;
  right: 18px;
  bottom: 102px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 20;
}
.page-badge {
  position: absolute;
  top: 26px;
  left: 50%;
  transform: translateX(-50%);
  color: rgba(60, 55, 45, 0.55);
  font-size: 13px;
  pointer-events: none;
}
</style>
