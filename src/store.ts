import { reactive, toRaw, watch } from 'vue'
import type {
  BrushParams,
  BrushPreset,
  CoverTexture,
  GuideMode,
  Journal,
  Layer,
  Page,
  PageOp,
  Pt,
  ShapeKind,
  SpreadMode,
  Stroke,
  SymmetryMode,
  ToolId,
} from './types'
import { i18n } from './i18n'
import { logger } from './log'

const log = logger('store')
import { PAGE_W, PAGE_H, pageSize, pageSizePreset, spreadRect } from './pageSpace'
import type { PageSizeId } from './pageSpace'
import {
  assembleJournals,
  loadOrCreateBrowserJournals,
  loadOrCreateNativeJournals,
  saveJournalEntries,
  usesNativeSqlite,
  type JournalIndex,
  type JournalSaveBatch,
} from './persistence'

const t = (key: string, named?: Record<string, unknown>) => i18n.global.t(key, named ?? {})

export type ViewName = 'shelf' | 'journal' | 'canvas'
export type JournalMode = 'stack' | 'overview'

interface StoreState {
  view: ViewName
  journals: Journal[]
  journalId: string | null
  pageId: string | null
  journalMode: JournalMode
  journalPageIdx: number
  journalOverviewIdx: number
  tool: ToolId
  brush: Record<ToolId, BrushParams> // per-tool brush settings (see the panel)
  brushPresets: BrushPreset[]
  shape: ShapeKind
  fillMode: 'normal' | 'invert' | 'erase' // fill tool: bucket / inverse / bg-removal
  pageSize: PageSizeId // size preset applied to newly created pages
  symmetry: SymmetryMode // mirror drawn strokes across the page-center axes
  spreadMode: SpreadMode // canvas focus: whole sheet or just one half
  guide: GuideMode // 'line' straightedge | 'arc' french curve; strokes snap to it
  guideX: number // guide anchor in page units
  guideY: number
  guideAngle: number // line: angle; arc: arc start angle (radians)
  guideR: number // arc radius (page units)
  maskEdit: boolean // paint into the active layer's alpha mask
  color: string
  trayOpen: boolean
}

const STORAGE_KEY = 'vihko:v1'
const SPACE_KEY = 'vihko:page-space'

// --- persistence -------------------------------------------------------------
// Dirty-tracking saves. Storage v2 keeps an index row plus one `journal:<id>`
// row (meta + page stubs) and one `page:<id>` row per page, so a stroke edit
// serializes and writes a single page instead of the whole journal tree. This
// block must initialize before `store`: load() reaches markPageDirty through
// migrateToPageSpace -> touchPage during module init.
const dirtyPages = new Set<string>()
const dirtyJournals = new Set<string>()
const removedPages = new Set<string>()
const removedJournals = new Set<string>()
let orderDirty = false
let storageV2Ready = false // every live page already has a stored row
let saveTimer: ReturnType<typeof setTimeout> | null = null
let persistenceReady = !usesNativeSqlite()
let saveQueue = Promise.resolve()

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, 400)
}

function markPageDirty(id: string) {
  dirtyPages.add(id)
  scheduleSave()
}

function markJournalDirty(id: string) {
  dirtyJournals.add(id)
  scheduleSave()
}

function markOrderDirty() {
  orderDirty = true
  scheduleSave()
}

// A journal row keeps only page stubs; contents live in `page:<id>` rows.
function journalRow(j: Journal) {
  return {
    ...j,
    pages: j.pages.map((p) => ({ id: p.id, w: p.w, h: p.h, createdAt: p.createdAt })),
  }
}

function flushSave() {
  saveTimer = null
  if (!persistenceReady) {
    log.debug('save deferred: persistence not ready yet')
    return
  }
  const rawJournals = store.journals.map((j) => toRaw(j))
  const byId = new Map(rawJournals.map((j) => [j.id, j]))
  const batch: JournalSaveBatch = {
    journals: [],
    pages: [],
    deleteJournals: [...removedJournals],
    deletePages: [...removedPages],
  }
  const queued = new Set<string>()
  const queuePage = (p: Page) => {
    if (queued.has(p.id)) return
    queued.add(p.id)
    batch.pages.push({ id: p.id, json: JSON.stringify(p) })
  }
  const queueJournal = (j: Journal) => {
    batch.journals.push({ id: j.id, json: JSON.stringify(journalRow(j)) })
    // Page stubs must never point at a missing row: a dirty journal rewrites
    // all of its page rows together with the meta.
    for (const p of j.pages) queuePage(p)
  }
  if (!storageV2Ready) {
    // First save after a legacy/seed load: write every row once so the index
    // never references pages that were never persisted.
    batch.order = rawJournals.map((j) => j.id)
    for (const j of rawJournals) queueJournal(j)
    storageV2Ready = true
  } else {
    if (orderDirty) batch.order = rawJournals.map((j) => j.id)
    for (const id of dirtyJournals) {
      const j = byId.get(id)
      if (j) queueJournal(j)
    }
    for (const id of dirtyPages) {
      for (const j of rawJournals) {
        const p = j.pages.find((x) => x.id === id)
        if (p) {
          queuePage(p)
          break
        }
      }
    }
  }
  dirtyPages.clear()
  dirtyJournals.clear()
  removedPages.clear()
  removedJournals.clear()
  orderDirty = false
  if (
    !batch.order &&
    !batch.journals.length &&
    !batch.pages.length &&
    !batch.deleteJournals.length &&
    !batch.deletePages.length
  )
    return
  log.debug('flushing save batch', {
    order: !!batch.order,
    journals: batch.journals.length,
    pages: batch.pages.length,
    deleteJournals: batch.deleteJournals.length,
    deletePages: batch.deletePages.length,
  })
  saveQueue = saveQueue
    .then(() => saveJournalEntries(batch))
    .catch((error: unknown) => log.error('Could not save journals', error))
}
const LEGACY_KEYS: [string, string][] = [
  ['paper-port:v1', STORAGE_KEY],
  ['paper-port:page-space', SPACE_KEY],
]

// Legacy saves recorded stroke/op coordinates in screen CSS pixels. Scale them
// anisotropically into page units so whatever filled the screen back then now
// fills the sheet (the old canvas was always fullscreen).
export function migrateToPageSpace(journals: Journal[], cssW: number, cssH: number) {
  const kx = PAGE_W / cssW
  const ky = PAGE_H / cssH
  log.info('migrating legacy screen-px saves to page space', { cssW, cssH, kx, ky })
  for (const j of journals) {
    for (const p of j.pages) {
      touchPage(p)
      for (const s of p.strokes) {
        for (const pt of s.pts) {
          pt.x *= kx
          pt.y *= ky
        }
      }
      for (const op of p.ops ?? []) {
        if (op.kind === 'fill') {
          op.x *= kx
          op.y *= ky
        } else if (op.kind === 'cut') {
          for (const pt of op.path) {
            pt.x *= kx
            pt.y *= ky
          }
          op.dx *= kx
          op.dy *= ky
        } else if (op.kind === 'photo') {
          op.photo.x *= kx
          op.photo.y *= ky
          op.photo.w *= kx
          op.photo.h *= ky
        }
      }
    }
  }
}

const uid = () => Math.random().toString(36).slice(2, 10)

// Page content revisions. The WebGL journal caches rasterized page paints
// keyed by this counter, so every mutation that changes what's on a page
// must bump it. A WeakMap keeps the counter out of the reactive graph —
// bumps shouldn't trigger the persistence watcher.
const pageRevs = new WeakMap<Page, number>()
// Keys normalize through toRaw: callers reach the same page via the
// reactive proxy (currentPage) or the raw object (journalToJson output,
// tests) — a proxy and its target must share one revision.
export function pageRev(p: Page): number {
  return pageRevs.get(toRaw(p)) ?? 0
}
function touchPage(p: Page) {
  const raw = toRaw(p)
  pageRevs.set(raw, pageRev(raw) + 1)
  markPageDirty(p.id)
}

function newPage(size?: { w: number; h: number }): Page {
  const id = uid()
  const layerId = uid()
  return {
    id,
    // Non-default sizes travel on the page; the spread keeps fields absent.
    ...(size && (size.w !== PAGE_W || size.h !== PAGE_H) ? { w: size.w, h: size.h } : null),
    strokes: [],
    createdAt: Date.now(),
    activeLayerId: layerId,
    layers: [
      {
        id: layerId,
        name: t('layers.defaultName', { n: 1 }),
        visible: true,
        opacity: 1,
        x: 0,
        y: 0,
        scale: 1,
        rotation: 0,
      },
    ],
  }
}

function newJournal(title: string, cover: number): Journal {
  return { id: uid(), title, cover, pages: [newPage()], createdAt: Date.now() }
}

function seed(): Journal[] {
  return [
    { ...newJournal(t('names.sketches'), 0), pages: [newPage(), newPage(), newPage()] },
    newJournal(t('names.ideas'), 3),
    newJournal(t('names.travel'), 5),
  ]
}

function load(): Journal[] {
  try {
    for (const [from, to] of LEGACY_KEYS) {
      const v = localStorage.getItem(from)
      if (v !== null && localStorage.getItem(to) === null) {
        localStorage.setItem(to, v)
        log.debug('migrated legacy storage key', { from, to })
      }
    }
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Journal[] | JournalIndex
      if (Array.isArray(parsed) && parsed.length) {
        log.debug('loaded v1 whole-blob save', parsed.length)
        if (localStorage.getItem(SPACE_KEY) !== '1' && typeof window !== 'undefined') {
          migrateToPageSpace(parsed, window.innerWidth, window.innerHeight)
          try {
            // Persist migrated coords + flag together: the debounced save
            // might not flush before a reload, leaving stale data otherwise.
            localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
            localStorage.setItem(SPACE_KEY, '1')
          } catch {
            /* ignore */
          }
        }
        return parsed
      }
      // v2 row layout: an index + per-journal/page keys. Missing or broken
      // rows degrade inside assembleJournals (empty page / skipped journal).
      if (!Array.isArray(parsed) && (parsed as JournalIndex)?.v === 2) {
        const journals = assembleJournals(parsed as JournalIndex, (key) => {
          const v = localStorage.getItem(`${STORAGE_KEY}:${key}`)
          return v ?? undefined
        })
        storageV2Ready = true
        log.debug('assembled v2 rows into journals', journals.length)
        return journals
      }
    }
  } catch {
    /* corrupted state -> reseed */
    log.warn('stored state unreadable, reseeding defaults')
  }
  log.debug('seeding default journals')
  return seed()
}

export const store = reactive<StoreState>({
  view: 'shelf',
  journals: load(),
  journalId: null,
  pageId: null,
  journalMode: 'stack',
  journalPageIdx: 0,
  journalOverviewIdx: 0,
  tool: 'draw',
  shape: 'rectangle',
  brush: {
    eraser: { size: 1, opacity: 1, stab: 0.5 },
    draw: { size: 1, opacity: 1, stab: 0.5 },
    sketch: { size: 1, opacity: 1, stab: 0.5 },
    outline: { size: 1, opacity: 1, stab: 0.5 },
    write: { size: 1, opacity: 1, stab: 0.5 },
    color: { size: 1, opacity: 1, stab: 0.5 },
    shapes: { size: 1, opacity: 1, stab: -1 },
    fill: { size: 1, opacity: 1, stab: -1 },
    cut: { size: 1, opacity: 1, stab: -1 },
    filter: { size: 1, opacity: 1, stab: -1 },
    move: { size: 1, opacity: 1, stab: -1 },
    transform: { size: 1, opacity: 1, stab: -1 },
  },
  brushPresets: loadPresets(),
  fillMode: 'normal',
  pageSize: 'spread',
  symmetry: 'none',
  spreadMode: 'full',
  guide: 'off',
  guideX: PAGE_W / 2,
  guideY: PAGE_H / 2,
  guideAngle: 0,
  guideR: PAGE_W / 4,
  maskEdit: false,
  color: '#22221f',
  trayOpen: true,
})

const PRESETS_KEY = 'vihko:brushes'

function defaultPresets(): BrushPreset[] {
  const p = (
    id: string,
    name: string,
    tool: ToolId,
    params: Partial<BrushParams>,
  ): BrushPreset => ({
    id,
    name,
    tool,
    params: { size: 1, opacity: 1, stab: 0.5, ...params },
  })
  return [
    p('pencil', 'brushes.pencil', 'sketch', { tip: 'noise', spacing: 0.25, jitter: 0.4 }),
    p('round', 'brushes.round', 'draw', { tip: 'round' }),
    p('marker', 'brushes.marker', 'outline', { tip: 'marker', spacing: 0.45, opacity: 0.9 }),
    p('airbrush', 'brushes.airbrush', 'draw', { tip: 'airbrush', spacing: 0.3, opacity: 0.55 }),
    p('watercolor', 'brushes.watercolor', 'color', { wet: 0.65 }),
  ]
}

function loadPresets(): BrushPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as BrushPreset[]
      if (Array.isArray(parsed) && parsed.length) return parsed
    }
  } catch {
    /* corrupted -> reseed */
  }
  return defaultPresets()
}

// Brush params for the active tool — always returns a live store record.
export function brushOf(id: ToolId): BrushParams {
  if (!store.brush[id]) store.brush[id] = { size: 1, opacity: 1, stab: -1 }
  return store.brush[id]
}

// Fields snapshotted onto a stroke at draw time for deterministic replay.
export function brushSnapshot(id: ToolId): Partial<BrushParams> {
  const b = brushOf(id)
  return {
    opacity: b.opacity < 1 ? b.opacity : undefined,
    blend: b.blend && b.blend !== 'source-over' ? b.blend : undefined,
    tip: b.tip && b.tip !== 'round' ? b.tip : undefined,
    spacing: b.spacing,
    jitter: b.jitter,
    scatter: b.scatter,
    angle: b.angle,
    wet: id === 'color' ? (b.wet ?? 0) : undefined,
  }
}

export function applyBrushPreset(preset: BrushPreset) {
  store.tool = preset.tool
  Object.assign(brushOf(preset.tool), preset.params)
}

export function saveBrushPreset() {
  const b = brushOf(store.tool)
  const preset: BrushPreset = {
    id: uid(),
    name: `Brush ${store.brushPresets.length + 1}`,
    tool: store.tool,
    params: { ...b },
  }
  store.brushPresets.push(preset)
  return preset
}

// --- symmetry & guides ------------------------------------------------------
// Mirror a page-space point across the axes through the rect's center — the
// whole sheet by default, the focused half under a spread focus.
export function mirrorX(x: number, w = PAGE_W, x0 = 0) {
  return 2 * x0 + w - x
}
export function mirrorY(y: number, h = PAGE_H, y0 = 0) {
  return 2 * y0 + h - y
}

// The extra mirrored point sets for a stroke under the current symmetry mode
// (the original points are always drawn; these are the copies). `rect` is the
// mirror frame — a focused spread half keeps its copies inside itself.
export function mirroredPtSets(
  pts: Pt[],
  rect: { x?: number; y?: number; w: number; h: number } = { w: PAGE_W, h: PAGE_H },
): Pt[][] {
  const mv = (p: Pt): Pt => ({ ...p, x: mirrorX(p.x, rect.w, rect.x ?? 0) })
  const mh = (p: Pt): Pt => ({ ...p, y: mirrorY(p.y, rect.h, rect.y ?? 0) })
  switch (store.symmetry) {
    case 'v':
      return [pts.map(mv)]
    case 'h':
      return [pts.map(mh)]
    case 'xy':
      return [pts.map(mv), pts.map(mh), pts.map((p) => mh(mv(p)))]
    default:
      return []
  }
}

// Snap a page-space point onto the active drawing guide: the straightedge is
// an infinite line through (guideX,guideY) at guideAngle; the french curve is
// a circle of guideR around the same anchor. Returns the input when guides
// are off.
export function snapToGuide(p: { x: number; y: number }): { x: number; y: number } {
  if (store.guide === 'line') {
    const c = Math.cos(store.guideAngle)
    const s = Math.sin(store.guideAngle)
    const d = (p.x - store.guideX) * c + (p.y - store.guideY) * s
    return { x: store.guideX + c * d, y: store.guideY + s * d }
  }
  if (store.guide === 'arc') {
    const dx = p.x - store.guideX
    const dy = p.y - store.guideY
    const l = Math.hypot(dx, dy) || 1
    return { x: store.guideX + (dx / l) * store.guideR, y: store.guideY + (dy / l) * store.guideR }
  }
  return p
}

watch(
  () => store.brushPresets,
  (presets) => {
    try {
      localStorage.setItem(PRESETS_KEY, JSON.stringify(toRaw(presets)))
    } catch {
      /* quota */
    }
  },
  { deep: true },
)

export const covers = [
  '#3a3f4a',
  '#6b4a3a',
  '#3f5a4c',
  '#7a6a3f',
  '#54321f',
  '#2f4a5a',
  '#6e3a52',
  '#444444',
]

export const palette = [
  '#22221f',
  '#b8a88a',
  '#e8dcc0',
  '#d9a441',
  '#e2601e',
  '#f2c43d',
  '#4a6b8a',
  '#7a9e7e',
  '#9a7bb8',
  '#3f8f8a',
]

export function currentJournal(): Journal | null {
  return store.journals.find((j) => j.id === store.journalId) ?? null
}

export function currentPage(): Page | null {
  const j = currentJournal()
  return j?.pages.find((p) => p.id === store.pageId) ?? null
}

export function openJournal(id: string) {
  log.debug('openJournal', id)
  store.journalId = id
  store.pageId = null
  store.journalMode = 'stack'
  store.journalPageIdx = 0
  store.journalOverviewIdx = 0
  store.view = 'journal'
}

export function openPage(id: string) {
  log.debug('openPage', id)
  const pageIndex = currentJournal()?.pages.findIndex((p) => p.id === id) ?? -1
  if (pageIndex >= 0) {
    store.journalPageIdx = pageIndex
    store.journalOverviewIdx = pageIndex
  }
  store.pageId = id
  store.view = 'canvas'
}

export function closeToJournal() {
  log.debug('closeToJournal', store.journalId)
  store.view = store.journalId ? 'journal' : 'shelf'
  store.pageId = null
}

export function closeToShelf() {
  store.view = 'shelf'
  store.journalId = null
  store.pageId = null
}

export function addJournal() {
  const j = newJournal(
    t('names.journal', { n: store.journals.length + 1 }),
    Math.floor(Math.random() * covers.length),
  )
  store.journals.push(j)
  markJournalDirty(j.id)
  markOrderDirty()
  log.debug('journal added', j.id)
  return j
}

export function addPage() {
  const j = currentJournal()
  if (!j) return null
  const p = newPage(pageSizePreset(store.pageSize))
  j.pages.push(p)
  markJournalDirty(j.id)
  log.debug('page added', { journal: j.id, page: p.id })
  return p
}

export function deletePage(id: string) {
  const j = currentJournal()
  if (!j) return
  const i = j.pages.findIndex((p) => p.id === id)
  if (i >= 0) {
    j.pages.splice(i, 1)
    removedPages.add(id)
    markJournalDirty(j.id)
  }
  if (!j.pages.length) {
    log.debug('last page deleted, inserting a fresh page')
    j.pages.push(newPage())
    markJournalDirty(j.id)
  }
}

export function deleteJournal(id: string) {
  const i = store.journals.findIndex((j) => j.id === id)
  if (i < 0) return
  log.debug('journal deleted', id)
  const [j] = store.journals.splice(i, 1)
  removedJournals.add(id)
  for (const p of j.pages) removedPages.add(p.id)
  markOrderDirty()
}

export function renameJournal(id: string, title: string) {
  const j = store.journals.find((x) => x.id === id)
  if (j && title.trim()) {
    j.title = title.trim()
    markJournalDirty(id)
  }
}

export function setCoverImage(id: string, src: string | null) {
  const j = store.journals.find((x) => x.id === id)
  if (!j) return
  if (src) j.coverImg = src
  else delete j.coverImg
  markJournalDirty(id)
}

export function setCoverTexture(id: string, texture: CoverTexture) {
  const j = store.journals.find((x) => x.id === id)
  if (!j) return
  j.coverTexture = texture
  markJournalDirty(id)
}

export function journalToJson(id: string): string | null {
  const j = store.journals.find((x) => x.id === id)
  return j ? JSON.stringify(j, null, 2) : null
}

export function navPage(dir: 1 | -1): Page | null {
  const j = currentJournal()
  const p = currentPage()
  if (!j || !p) return null
  const i = j.pages.findIndex((x) => x.id === p.id)
  const n = i + dir
  if (n < 0 || n >= j.pages.length) return null
  store.pageId = j.pages[n].id
  return j.pages[n]
}

const MAX_UNDO = 40

export function ensurePageLayers(p: Page): Layer[] {
  let changed = false
  if (!p.layers?.length) {
    const id = uid()
    p.layers = [
      {
        id,
        name: t('layers.defaultName', { n: 1 }),
        visible: true,
        opacity: 1,
        x: 0,
        y: 0,
        scale: 1,
        rotation: 0,
      },
    ]
    p.activeLayerId = id
    changed = true
  }
  const first = p.layers[0]
  for (const stroke of p.strokes) {
    if (stroke.layerId === undefined) {
      stroke.layerId = first.id
      changed = true
    }
  }
  for (const op of p.ops ?? []) {
    if (op.layerId === undefined) {
      op.layerId = first.id
      changed = true
    }
  }
  if (!p.layers.some((layer) => layer.id === p.activeLayerId)) {
    p.activeLayerId = p.layers[p.layers.length - 1].id
    changed = true
  }
  if (changed) {
    log.debug('ensurePageLayers repaired legacy assignments', p.id)
    markPageDirty(p.id)
  }
  return p.layers
}

export function pageLayers(): Layer[] {
  const p = currentPage()
  return p ? ensurePageLayers(p) : []
}

export function activeLayer(): Layer | null {
  const p = currentPage()
  if (!p) return null
  return ensurePageLayers(p).find((layer) => layer.id === p.activeLayerId) ?? null
}

export function addLayer(): Layer | null {
  const p = currentPage()
  if (!p) return null
  const layers = ensurePageLayers(p)
  const layer: Layer = {
    id: uid(),
    name: t('layers.defaultName', { n: layers.length + 1 }),
    visible: true,
    opacity: 1,
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
  }
  layers.push(layer)
  p.activeLayerId = layer.id
  touchPage(p)
  return layer
}

export function selectLayer(id: string) {
  const p = currentPage()
  if (!p || !ensurePageLayers(p).some((layer) => layer.id === id)) return
  if (p.activeLayerId !== id) {
    p.activeLayerId = id
    markPageDirty(p.id)
  }
}

export function updateLayer(id: string, changes: Partial<Omit<Layer, 'id'>>) {
  const p = currentPage()
  const layer = p && ensurePageLayers(p).find((item) => item.id === id)
  if (!p || !layer) return
  Object.assign(layer, changes)
  touchPage(p)
}

export function moveLayer(id: string, direction: -1 | 1) {
  const p = currentPage()
  if (!p) return
  const layers = ensurePageLayers(p)
  const i = layers.findIndex((layer) => layer.id === id)
  const n = i + direction
  if (i < 0 || n < 0 || n >= layers.length) return
  ;[layers[i], layers[n]] = [layers[n], layers[i]]
  touchPage(p)
}

export function reorderLayer(id: string, index: number) {
  const p = currentPage()
  if (!p) return
  const layers = ensurePageLayers(p)
  const from = layers.findIndex((layer) => layer.id === id)
  if (from < 0) return
  const to = Math.max(0, Math.min(layers.length - 1, Math.trunc(index)))
  if (from === to) return
  const [layer] = layers.splice(from, 1)
  layers.splice(to, 0, layer)
  touchPage(p)
}

export function deleteLayer(id: string) {
  const p = currentPage()
  if (!p) return
  const layers = ensurePageLayers(p)
  if (layers.length <= 1) return
  const i = layers.findIndex((layer) => layer.id === id)
  if (i < 0) return
  layers.splice(i, 1)
  p.strokes = p.strokes.filter((stroke) => stroke.layerId !== id)
  p.ops = (p.ops ?? []).filter((op) => op.layerId !== id)
  if (p.activeLayerId === id) p.activeLayerId = layers[Math.min(i, layers.length - 1)].id
  touchPage(p)
}

export function pushStroke(stroke: Stroke) {
  const p = currentPage()
  if (!p) return
  stroke.layerId ??= p.activeLayerId ?? ensurePageLayers(p)[0].id
  p.strokes.push(stroke)
  touchPage(p)
  if (p.strokes.length > 400) {
    p.strokes.shift()
    log.warn('page stroke cap reached, dropped the oldest stroke', p.id)
  }
  undone.length = 0
  log.debug('stroke pushed', { page: p.id, tool: stroke.tool, pts: stroke.pts.length })
}

// Raster ops (fill/cut/photo/clear) interleave with strokes via `after`.
export function pushOp(op: PageOp) {
  const p = currentPage()
  if (!p) return
  op.layerId ??= p.activeLayerId ?? ensurePageLayers(p)[0].id
  p.ops ??= []
  p.ops.push(op)
  touchPage(p)
  undone.length = 0
  log.debug('op pushed', { page: p.id, kind: op.kind })
}

type Action = { kind: 'stroke'; stroke: Stroke } | { kind: 'op'; op: PageOp }

// The newest action is the tail op iff it sits at/after the last stroke index.
function newestIsOp(p: Page): boolean {
  const ops = p.ops ?? []
  const last = ops[ops.length - 1]
  return !!last && last.after >= p.strokes.length
}

export function canUndo(): boolean {
  const p = currentPage()
  return !!p && (p.strokes.length > 0 || (p.ops?.length ?? 0) > 0)
}

export function canRedo(): boolean {
  return undone.length > 0
}

export function undoStroke(): boolean {
  const p = currentPage()
  if (!p || !canUndo()) return false
  if (newestIsOp(p)) {
    undone.push({ kind: 'op', op: p.ops!.pop()! })
    log.debug('undid op')
  } else {
    undone.push({ kind: 'stroke', stroke: p.strokes.pop()! })
    log.debug('undid stroke')
  }
  touchPage(p)
  if (undone.length > MAX_UNDO) undone.shift()
  return true
}

export function redoStroke(): boolean {
  const p = currentPage()
  const a = undone.pop()
  if (!p || !a) return false
  if (a.kind === 'op') {
    p.ops ??= []
    p.ops.push(a.op)
  } else p.strokes.push(a.stroke)
  touchPage(p)
  log.debug('redid', a.kind)
  return true
}

export function clearPage() {
  const p = currentPage()
  if (!p || !canUndo()) return
  const size = pageSize(p)
  const r = spreadRect(store.spreadMode, size.w, size.h)
  pushOp({
    kind: 'clear',
    after: p.strokes.length,
    layerId: '*',
    rect: r.w !== size.w ? r : undefined,
  })
}

// Actions popped by undo, kept for redo (global stack is fine for a single user).
export const undone = reactive<Action[]>([])

export async function initializeStorePersistence(): Promise<void> {
  if (!usesNativeSqlite()) {
    if (typeof indexedDB === 'undefined') {
      log.debug('browser storage path (localStorage rows)')
      return
    }
    // Same async hydrate as the native path below: the sync load() output is
    // the first paint (and the migration source); IndexedDB is the truth.
    persistenceReady = false
    try {
      const journals = await loadOrCreateBrowserJournals(store.journals)
      if (journals) {
        store.journals.splice(0, store.journals.length, ...journals)
        storageV2Ready = true // init already seeded/migrated every row
        log.info('indexeddb persistence ready', journals.length)
      }
    } catch (e) {
      log.warn('indexeddb persistence failed, staying on localStorage', e)
    } finally {
      persistenceReady = true
      // Flush whatever was dirtied while hydrating (migrations, early edits).
      scheduleSave()
    }
    return
  }
  log.info('native sqlite persistence initializing')
  const journals = await loadOrCreateNativeJournals(store.journals)
  store.journals.splice(0, store.journals.length, ...journals)
  persistenceReady = true
  storageV2Ready = true // init already seeded/migrated every row
  log.info('native sqlite persistence ready', journals.length)
}

// Structural safety net: array-level mutations not routed through the
// helpers (the init splice above, tests) still flush the index and journal
// rows. Content edits reach the save queue via touchPage -> markPageDirty —
// no deep traversal of the whole corpus on every stroke.
watch(
  () => store.journals.map((j) => j.id).join('|'),
  () => markOrderDirty(),
)
watch(
  () => store.journals.map((j) => `${j.id}:${j.pages.map((p) => p.id).join(',')}`).join('|'),
  (val, old) => {
    const before = new Set((old ?? '').split('|'))
    const liveIds = new Set(val.split('|').map((part) => part.slice(0, part.indexOf(':'))))
    for (const part of val.split('|'))
      if (!before.has(part)) dirtyJournals.add(part.slice(0, part.indexOf(':')))
    for (const part of before) {
      const id = part.slice(0, part.indexOf(':'))
      if (!liveIds.has(id)) removedJournals.add(id)
    }
    scheduleSave()
  },
)
