import { reactive, toRaw, watch } from 'vue'
import type { Journal, Layer, Page, PageOp, ShapeKind, Stroke, ToolId } from './types'
import { i18n } from './i18n'
import { PAGE_W, PAGE_H } from './pageSpace'
import { loadOrCreateNativeJournals, saveJournalSnapshot, usesNativeSqlite } from './persistence'

const t = (key: string, named?: Record<string, unknown>) =>
  i18n.global.t(key, named ?? {})

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
  toolSizes: Record<ToolId, number>
  shape: ShapeKind
  color: string
  trayOpen: boolean
}

const STORAGE_KEY = 'vihko:v1'
const SPACE_KEY = 'vihko:page-space'
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
  for (const j of journals) {
    for (const p of j.pages) {
      touchPage(p)
      for (const s of p.strokes) {
        for (const pt of s.pts) { pt.x *= kx; pt.y *= ky }
      }
      for (const op of p.ops ?? []) {
        if (op.kind === 'fill') { op.x *= kx; op.y *= ky }
        else if (op.kind === 'cut') {
          for (const pt of op.path) { pt.x *= kx; pt.y *= ky }
          op.dx *= kx; op.dy *= ky
        } else if (op.kind === 'photo') {
          op.photo.x *= kx; op.photo.y *= ky
          op.photo.w *= kx; op.photo.h *= ky
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
}

function newPage(): Page {
  const id = uid()
  const layerId = uid()
  return {
    id, strokes: [], createdAt: Date.now(), activeLayerId: layerId,
    layers: [{ id: layerId, name: t('layers.defaultName', { n: 1 }), visible: true, opacity: 1, x: 0, y: 0, scale: 1, rotation: 0 }],
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
      if (v !== null && localStorage.getItem(to) === null) localStorage.setItem(to, v)
    }
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Journal[]
      if (Array.isArray(parsed) && parsed.length) {
        if (localStorage.getItem(SPACE_KEY) !== '1' && typeof window !== 'undefined') {
          migrateToPageSpace(parsed, window.innerWidth, window.innerHeight)
          try {
            // Persist migrated coords + flag together: the debounced watcher
            // might not flush before a reload, leaving stale data otherwise.
            localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
            localStorage.setItem(SPACE_KEY, '1')
          } catch { /* ignore */ }
        }
        return parsed
      }
    }
  } catch { /* corrupted state -> reseed */ }
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
  toolSizes: {
    eraser: 1, draw: 1, sketch: 1, outline: 1, write: 1,
    color: 1, shapes: 1, fill: 1, cut: 1, move: 1, transform: 1,
  },
  color: '#22221f',
  trayOpen: true,
})

export const covers = [
  '#3a3f4a', '#6b4a3a', '#3f5a4c', '#7a6a3f',
  '#54321f', '#2f4a5a', '#6e3a52', '#444444',
]

export const palette = [
  '#22221f', '#b8a88a', '#e8dcc0', '#d9a441',
  '#e2601e', '#f2c43d', '#4a6b8a', '#7a9e7e',
  '#9a7bb8', '#3f8f8a',
]

export function currentJournal(): Journal | null {
  return store.journals.find((j) => j.id === store.journalId) ?? null
}

export function currentPage(): Page | null {
  const j = currentJournal()
  return j?.pages.find((p) => p.id === store.pageId) ?? null
}

export function openJournal(id: string) {
  store.journalId = id
  store.pageId = null
  store.journalMode = 'stack'
  store.journalPageIdx = 0
  store.journalOverviewIdx = 0
  store.view = 'journal'
}

export function openPage(id: string) {
  const pageIndex = currentJournal()?.pages.findIndex((p) => p.id === id) ?? -1
  if (pageIndex >= 0) {
    store.journalPageIdx = pageIndex
    store.journalOverviewIdx = pageIndex
  }
  store.pageId = id
  store.view = 'canvas'
}

export function closeToJournal() {
  store.view = store.journalId ? 'journal' : 'shelf'
  store.pageId = null
}

export function closeToShelf() {
  store.view = 'shelf'
  store.journalId = null
  store.pageId = null
}

export function addJournal() {
  const j = newJournal(t('names.journal', { n: store.journals.length + 1 }), Math.floor(Math.random() * covers.length))
  store.journals.push(j)
  return j
}

export function addPage() {
  const j = currentJournal()
  if (!j) return null
  const p = newPage()
  j.pages.push(p)
  return p
}

export function deletePage(id: string) {
  const j = currentJournal()
  if (!j) return
  const i = j.pages.findIndex((p) => p.id === id)
  if (i >= 0) j.pages.splice(i, 1)
  if (!j.pages.length) j.pages.push(newPage())
}

export function deleteJournal(id: string) {
  const i = store.journals.findIndex((j) => j.id === id)
  if (i >= 0) store.journals.splice(i, 1)
}

export function renameJournal(id: string, title: string) {
  const j = store.journals.find((x) => x.id === id)
  if (j && title.trim()) j.title = title.trim()
}

export function setCoverImage(id: string, src: string | null) {
  const j = store.journals.find((x) => x.id === id)
  if (!j) return
  if (src) j.coverImg = src
  else delete j.coverImg
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
  if (!p.layers?.length) {
    const id = uid()
    p.layers = [{ id, name: t('layers.defaultName', { n: 1 }), visible: true, opacity: 1, x: 0, y: 0, scale: 1, rotation: 0 }]
    p.activeLayerId = id
  }
  const first = p.layers[0]
  for (const stroke of p.strokes) stroke.layerId ??= first.id
  for (const op of p.ops ?? []) op.layerId ??= first.id
  if (!p.layers.some((layer) => layer.id === p.activeLayerId))
    p.activeLayerId = p.layers[p.layers.length - 1].id
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
    id: uid(), name: t('layers.defaultName', { n: layers.length + 1 }), visible: true, opacity: 1,
    x: 0, y: 0, scale: 1, rotation: 0,
  }
  layers.push(layer)
  p.activeLayerId = layer.id
  touchPage(p)
  return layer
}

export function selectLayer(id: string) {
  const p = currentPage()
  if (!p || !ensurePageLayers(p).some((layer) => layer.id === id)) return
  p.activeLayerId = id
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
  if (p.strokes.length > 400) p.strokes.shift()
  undone.length = 0
}

// Raster ops (fill/cut/photo/clear) interleave with strokes via `after`.
export function pushOp(op: PageOp) {
  const p = currentPage()
  if (!p) return
  op.layerId ??= p.activeLayerId ?? ensurePageLayers(p)[0].id
  ;(p.ops ??= []).push(op)
  touchPage(p)
  undone.length = 0
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
  } else {
    undone.push({ kind: 'stroke', stroke: p.strokes.pop()! })
  }
  touchPage(p)
  if (undone.length > MAX_UNDO) undone.shift()
  return true
}

export function redoStroke(): boolean {
  const p = currentPage()
  const a = undone.pop()
  if (!p || !a) return false
  if (a.kind === 'op') (p.ops ??= []).push(a.op)
  else p.strokes.push(a.stroke)
  touchPage(p)
  return true
}

export function clearPage() {
  const p = currentPage()
  if (!p || !canUndo()) return
  pushOp({ kind: 'clear', after: p.strokes.length, layerId: '*' })
}

// Actions popped by undo, kept for redo (global stack is fine for a single user).
export const undone = reactive<Action[]>([])

let saveTimer: ReturnType<typeof setTimeout> | null = null
let persistenceReady = !usesNativeSqlite()
let saveQueue = Promise.resolve()

export async function initializeStorePersistence(): Promise<void> {
  if (!usesNativeSqlite()) return
  const journals = await loadOrCreateNativeJournals(store.journals)
  store.journals.splice(0, store.journals.length, ...journals)
  persistenceReady = true
}

watch(
  () => store.journals,
  () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (!persistenceReady) return
      const snapshot = JSON.stringify(store.journals)
      saveQueue = saveQueue
        .then(() => saveJournalSnapshot(snapshot))
        .catch((error: unknown) => console.error('Could not save journals', error))
    }, 400)
  },
  { deep: true },
)
