import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  store,
  covers,
  currentJournal,
  currentPage,
  openJournal,
  openPage,
  closeToJournal,
  closeToShelf,
  addJournal,
  addPage,
  deletePage,
  deleteJournal,
  navPage,
  pushStroke,
  pushOp,
  undoStroke,
  redoStroke,
  pageRev,
  renameJournal,
  setCoverImage,
  journalToJson,
  migrateToPageSpace,
  addLayer,
  pageLayers,
  selectLayer,
  activeLayer,
  updateLayer,
  moveLayer,
  deleteLayer,
} from './store'
import { PAGE_W, PAGE_H } from './pageSpace'
import { i18n } from './i18n'
import { nextTick } from 'vue'
import type { Journal, Stroke } from './types'

const t = (key: string, named?: Record<string, unknown>) => i18n.global.t(key, named ?? {})

function makeJournal(id: string, pageIds: string[]): Journal {
  return {
    id,
    title: `Journal ${id}`,
    cover: 0,
    createdAt: 0,
    pages: pageIds.map((pid) => ({ id: pid, strokes: [], createdAt: 0 })),
  }
}

const stroke = (n = 1): Stroke => ({
  tool: 'draw',
  color: '#22221f',
  pts: [{ x: n, y: n, t: n, p: 0.5 }],
})

beforeEach(() => {
  localStorage.clear()
  store.journals.splice(
    0,
    store.journals.length,
    makeJournal('j1', ['p1', 'p2']),
    makeJournal('j2', ['q1']),
  )
  store.journalId = 'j1'
  store.pageId = 'p1'
  store.view = 'canvas'
  store.journalMode = 'stack'
  store.journalPageIdx = 0
  store.journalOverviewIdx = 0
  // drain the shared redo stack so tests stay order-independent
  while (redoStroke()) {
    /* pop leftovers onto p1 */
  }
  currentPage()!.strokes.length = 0
})

describe('navigation', () => {
  it('resolves current journal and page', () => {
    expect(currentJournal()?.id).toBe('j1')
    expect(currentPage()?.id).toBe('p1')
    store.journalId = 'nope'
    expect(currentJournal()).toBeNull()
    expect(currentPage()).toBeNull()
  })

  it('openJournal / openPage / close* update the view', () => {
    openJournal('j2')
    expect(store.view).toBe('journal')
    expect(store.journalId).toBe('j2')
    expect(store.pageId).toBeNull()
    expect(store.journalMode).toBe('stack')
    expect(store.journalPageIdx).toBe(0)

    store.journalMode = 'overview'
    store.journalPageIdx = 2
    openPage('q1')
    expect(store.view).toBe('canvas')
    expect(store.pageId).toBe('q1')
    expect(store.journalPageIdx).toBe(0)

    closeToJournal()
    expect(store.view).toBe('journal')
    expect(store.pageId).toBeNull()

    closeToShelf()
    expect(store.view).toBe('shelf')
    expect(store.journalId).toBeNull()
  })

  it('opens a page with the stack focused on it', () => {
    store.journals[0].pages.push(
      { id: 'p3', strokes: [], createdAt: 0 },
      { id: 'p4', strokes: [], createdAt: 0 },
    )
    store.journalMode = 'overview'

    openPage('p1')
    expect(store.journalPageIdx).toBe(0)
    openPage('p2')
    expect(store.journalPageIdx).toBe(1)
    openPage('p3')
    expect(store.journalPageIdx).toBe(2)
    openPage('p4')
    expect(store.journalPageIdx).toBe(3)
    expect(store.journalOverviewIdx).toBe(3)
  })

  it('closeToJournal falls back to shelf without a journal', () => {
    store.journalId = null
    closeToJournal()
    expect(store.view).toBe('shelf')
  })
})

describe('journals and pages', () => {
  it('addJournal creates a journal with one blank page', () => {
    const j = addJournal()
    expect(store.journals.map((x) => x.id)).toContain(j.id)
    expect(j.pages).toHaveLength(1)
    expect(j.pages[0].strokes).toEqual([])
    expect(j.cover).toBeGreaterThanOrEqual(0)
    expect(j.cover).toBeLessThan(covers.length)
    expect(j.title).toBe(t('names.journal', { n: 3 }))
  })

  it('addPage appends to the current journal only', () => {
    const p = addPage()
    expect(currentJournal()!.pages.map((x) => x.id)).toContain(p!.id)
    store.journalId = null
    expect(addPage()).toBeNull()
  })

  it('deletePage removes the page; last page is replaced', () => {
    openJournal('j2') // has only q1
    deletePage('q1')
    const j = currentJournal()!
    expect(j.pages).toHaveLength(1)
    expect(j.pages[0].id).not.toBe('q1')

    deletePage('does-not-exist')
    expect(j.pages).toHaveLength(1)
  })

  it('deleteJournal removes by id', () => {
    deleteJournal('j1')
    expect(store.journals.map((j) => j.id)).toEqual(['j2'])
    deleteJournal('missing')
    expect(store.journals).toHaveLength(1)
  })

  it('renames journals, stores/removes cover art, and exports JSON', () => {
    renameJournal('j1', '  Field Notes  ')
    expect(currentJournal()?.title).toBe('Field Notes')
    setCoverImage('j1', 'data:image/jpeg;base64,abc')
    expect(currentJournal()?.coverImg).toBe('data:image/jpeg;base64,abc')
    expect(JSON.parse(journalToJson('j1')!).title).toBe('Field Notes')
    setCoverImage('j1', null)
    expect(currentJournal()?.coverImg).toBeUndefined()
    renameJournal('j1', '   ')
    expect(currentJournal()?.title).toBe('Field Notes')
  })

  it('navPage walks pages and stops at the edges', () => {
    expect(navPage(-1)).toBeNull()
    const p2 = navPage(1)
    expect(p2?.id).toBe('p2')
    expect(store.pageId).toBe('p2')
    expect(navPage(1)).toBeNull()
    expect(store.pageId).toBe('p2')
  })

  it('navPage is a no-op outside a journal/page', () => {
    store.pageId = null
    expect(navPage(1)).toBeNull()
    store.journalId = null
    expect(navPage(1)).toBeNull()
  })
})

describe('strokes, undo and redo', () => {
  it('pushStroke appends to the current page', () => {
    pushStroke(stroke(1))
    pushStroke(stroke(2))
    expect(currentPage()!.strokes).toHaveLength(2)
  })

  it('pushStroke caps the page at 400 strokes', () => {
    for (let i = 0; i < 405; i++) pushStroke(stroke(i))
    const strokes = currentPage()!.strokes
    expect(strokes).toHaveLength(400)
    expect(strokes[0].pts[0].x).toBe(5) // first 5 shifted out
  })

  it('pushStroke without a current page is a no-op', () => {
    store.pageId = null
    pushStroke(stroke())
    expect(currentJournal()!.pages.every((p) => !p.strokes.length)).toBe(true)
  })

  it('undo pops the last stroke and redo restores it', () => {
    pushStroke(stroke(1))
    pushStroke(stroke(2))
    expect(undoStroke()).toBe(true)
    expect(currentPage()!.strokes.map((s) => s.pts[0].x)).toEqual([1])
    expect(redoStroke()).toBe(true)
    expect(currentPage()!.strokes.map((s) => s.pts[0].x)).toEqual([1, 2])
  })

  it('undo/redo return false when nothing to move', () => {
    expect(undoStroke()).toBe(false)
    expect(redoStroke()).toBe(false)
  })
})

describe('page content revisions', () => {
  it('bump on every content mutation so texture caches invalidate', () => {
    const p = currentPage()!
    const r0 = pageRev(p)
    pushStroke(stroke(1))
    expect(pageRev(p)).toBe(r0 + 1)
    pushOp({ kind: 'clear', after: 1 })
    expect(pageRev(p)).toBe(r0 + 2)
    expect(undoStroke()).toBe(true)
    expect(pageRev(p)).toBe(r0 + 3)
    expect(redoStroke()).toBe(true)
    expect(pageRev(p)).toBe(r0 + 4)
    // Non-content changes leave the revision alone.
    renameJournal('j1', 'Renamed')
    expect(pageRev(p)).toBe(r0 + 4)
  })

  it('migrateToPageSpace bumps pages whose coordinates it rewrites', () => {
    const j = makeJournal('jm', ['m1'])
    const r0 = pageRev(j.pages[0])
    migrateToPageSpace([j], 400, 800)
    expect(pageRev(j.pages[0])).toBe(r0 + 1)
  })
})

describe('layers', () => {
  it('migrates legacy page content into a default layer and routes new strokes to the selected layer', () => {
    const legacy = stroke(7)
    currentPage()!.strokes.push(legacy)
    const [base] = pageLayers()
    expect(legacy.layerId).toBe(base.id)

    const layer = addLayer()!
    pushStroke(stroke(8))
    expect(activeLayer()?.id).toBe(layer.id)
    expect(currentPage()!.strokes[1].layerId).toBe(layer.id)
    selectLayer(base.id)
    expect(activeLayer()?.id).toBe(base.id)
  })

  it('supports layer visibility, opacity, transforms, reordering and protected deletion', () => {
    const base = pageLayers()[0]
    const second = addLayer()!
    updateLayer(second.id, { visible: false, opacity: 0.4, x: 12, y: -8, scale: 1.5, rotation: 20 })
    expect(pageLayers()[1]).toMatchObject({
      visible: false,
      opacity: 0.4,
      x: 12,
      y: -8,
      scale: 1.5,
      rotation: 20,
    })

    moveLayer(second.id, -1)
    expect(pageLayers()[0].id).toBe(second.id)
    deleteLayer(second.id)
    expect(pageLayers().map((layer) => layer.id)).toEqual([base.id])
    deleteLayer(base.id)
    expect(pageLayers()).toHaveLength(1)
  })
})

describe('persistence', () => {
  it('saves journals to localStorage (debounced)', async () => {
    vi.useFakeTimers()
    try {
      addJournal()
      await nextTick() // let the deep watcher run and arm the 400ms save timer
      await vi.advanceTimersByTimeAsync(500)
      const raw = localStorage.getItem('vihko:v1')
      expect(raw).toBeTruthy()
      const saved = JSON.parse(raw!) as Journal[]
      expect(saved.map((j) => j.id)).toEqual(store.journals.map((j) => j.id))
    } finally {
      vi.useRealTimers()
    }
  })

  it('loads journals from storage instead of seeding', async () => {
    localStorage.setItem('vihko:v1', JSON.stringify([makeJournal('saved', ['s1'])]))
    vi.resetModules()
    const { store: fresh } = await import('./store')
    expect(fresh.journals.map((j) => j.id)).toEqual(['saved'])
  })

  it('reseeds on corrupted or empty storage', async () => {
    for (const raw of ['{not json', '[]', '"x"']) {
      localStorage.setItem('vihko:v1', raw)
      vi.resetModules()
      const { store: fresh } = await import('./store')
      expect(fresh.journals.length).toBe(3) // seed()
      expect(fresh.journals[0].title).toBe(t('names.sketches'))
    }
  })

  it('migrates stored screen-px coordinates to page space once', async () => {
    const j = makeJournal('saved', ['s1'])
    j.pages[0].strokes.push({
      tool: 'draw',
      color: '#000',
      pts: [{ x: 100, y: 200, t: 0, p: 0.5 }],
    })
    localStorage.setItem('vihko:v1', JSON.stringify([j]))
    vi.resetModules()
    const { store: fresh } = await import('./store')
    const pt = fresh.journals[0].pages[0].strokes[0].pts[0]
    expect(pt.x).toBeCloseTo(100 * (PAGE_W / window.innerWidth))
    expect(pt.y).toBeCloseTo(200 * (PAGE_H / window.innerHeight))
    expect(localStorage.getItem('vihko:page-space')).toBe('1')

    // a second load must not rescale again
    vi.resetModules()
    const { store: again } = await import('./store')
    expect(again.journals[0].pages[0].strokes[0].pts[0].x).toBeCloseTo(pt.x)
  })
})

describe('migrateToPageSpace', () => {
  it('scales strokes and op coordinates anisotropically', () => {
    const j: Journal[] = [
      {
        id: 'j',
        title: 't',
        cover: 0,
        createdAt: 0,
        pages: [
          {
            id: 'p',
            createdAt: 0,
            strokes: [{ tool: 'draw', color: '#000', pts: [{ x: 100, y: 200, t: 0, p: 0.5 }] }],
            ops: [
              { kind: 'fill', x: 40, y: 50, color: '#fff', after: 0 },
              { kind: 'cut', path: [{ x: 10, y: 20 }], dx: 5, dy: 6, after: 0 },
              { kind: 'photo', photo: { src: 'x', x: 1, y: 2, w: 30, h: 40 }, after: 0 },
            ],
          },
        ],
      },
    ]
    migrateToPageSpace(j, 400, 800)
    const kx = PAGE_W / 400
    const ky = PAGE_H / 800
    const p = j[0].pages[0]
    expect(p.strokes[0].pts[0].x).toBeCloseTo(100 * kx)
    expect(p.strokes[0].pts[0].y).toBeCloseTo(200 * ky)
    const [fill, cut, photo] = p.ops!
    if (fill.kind !== 'fill' || cut.kind !== 'cut' || photo.kind !== 'photo') throw new Error()
    expect(fill.x).toBeCloseTo(40 * kx)
    expect(fill.y).toBeCloseTo(50 * ky)
    expect(cut.path[0].x).toBeCloseTo(10 * kx)
    expect(cut.dy).toBeCloseTo(6 * ky)
    expect(photo.photo.w).toBeCloseTo(30 * kx)
    expect(photo.photo.h).toBeCloseTo(40 * ky)
  })
})
