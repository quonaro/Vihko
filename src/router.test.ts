import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { applyNav, initRouter, loadNav, NAV_KEY, navPath, parseNav } from './router'
import { store } from './store'
import type { Journal } from './types'

function makeJournal(id: string, pageIds: string[]): Journal {
  return {
    id,
    title: `Journal ${id}`,
    cover: 0,
    createdAt: 0,
    pages: pageIds.map((pid) => ({ id: pid, strokes: [], createdAt: 0 })),
  }
}

const resetStore = () => {
  store.journals.splice(0, store.journals.length, makeJournal('j1', ['p1', 'p2']))
  store.view = 'shelf'
  store.journalId = null
  store.pageId = null
  store.journalMode = 'stack'
  store.journalPageIdx = 0
  store.journalOverviewIdx = 0
}

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/')
  resetStore()
})

describe('navPath', () => {
  it('maps views to paths', () => {
    const base = { journalId: 'j1', pageId: null, journalMode: 'stack' as const }
    expect(navPath({ ...base, view: 'shelf' })).toBe('/')
    expect(navPath({ ...base, view: 'journal' })).toBe('/journal/j1')
    expect(navPath({ ...base, view: 'journal', journalMode: 'overview' })).toBe(
      '/journal/j1/overview',
    )
    expect(navPath({ ...base, view: 'canvas', pageId: 'p2' })).toBe('/journal/j1/page/p2')
  })

  it('falls back to / when ids are missing', () => {
    expect(navPath({ view: 'canvas', journalId: null, pageId: 'p1', journalMode: 'stack' })).toBe(
      '/',
    )
    expect(navPath({ view: 'journal', journalId: null, pageId: null, journalMode: 'stack' })).toBe(
      '/',
    )
  })
})

describe('parseNav', () => {
  it('parses all route shapes', () => {
    expect(parseNav('/')).toMatchObject({ view: 'shelf', journalId: null, pageId: null })
    expect(parseNav('/journal/j1')).toMatchObject({ view: 'journal', journalId: 'j1' })
    expect(parseNav('/journal/j1/overview')).toMatchObject({
      view: 'journal',
      journalMode: 'overview',
    })
    expect(parseNav('/journal/j1/page/p2')).toMatchObject({
      view: 'canvas',
      journalId: 'j1',
      pageId: 'p2',
    })
    expect(parseNav('/bogus/path')).toMatchObject({ view: 'shelf' })
  })
})

describe('applyNav', () => {
  it('opens a page and syncs the journal indices', () => {
    applyNav(parseNav('/journal/j1/page/p2'))
    expect(store.view).toBe('canvas')
    expect(store.journalId).toBe('j1')
    expect(store.pageId).toBe('p2')
    expect(store.journalPageIdx).toBe(1)
    expect(store.journalOverviewIdx).toBe(1)
  })

  it('drops to the journal when the page is gone', () => {
    applyNav(parseNav('/journal/j1/page/missing'))
    expect(store.view).toBe('journal')
    expect(store.journalId).toBe('j1')
    expect(store.pageId).toBeNull()
  })

  it('drops to the shelf when the journal is gone', () => {
    applyNav(parseNav('/journal/nope/page/p1'))
    expect(store.view).toBe('shelf')
    expect(store.journalId).toBeNull()
    expect(store.pageId).toBeNull()
  })
})

describe('initRouter', () => {
  it('restores the persisted position on /', () => {
    localStorage.setItem(
      NAV_KEY,
      JSON.stringify({ view: 'canvas', journalId: 'j1', pageId: 'p2', journalMode: 'stack' }),
    )
    initRouter()
    expect(store.view).toBe('canvas')
    expect(store.pageId).toBe('p2')
    expect(location.pathname).toBe('/journal/j1/page/p2')
  })

  it('replaces junk urls with the resolved route', () => {
    history.replaceState(null, '', '/bogus')
    initRouter()
    expect(store.view).toBe('shelf')
    expect(location.pathname).toBe('/')
  })

  it('persists and pushes on store navigation', async () => {
    initRouter()
    store.journalId = 'j1'
    store.view = 'journal'
    await nextTick()
    expect(location.pathname).toBe('/journal/j1')
    expect(JSON.parse(localStorage.getItem(NAV_KEY) ?? '')).toMatchObject({
      view: 'journal',
      journalId: 'j1',
    })
    store.pageId = 'p1'
    store.view = 'canvas'
    await nextTick()
    expect(location.pathname).toBe('/journal/j1/page/p1')
  })

  it('applies popstate without pushing a new entry', async () => {
    localStorage.setItem(
      NAV_KEY,
      JSON.stringify({ view: 'canvas', journalId: 'j1', pageId: 'p1', journalMode: 'stack' }),
    )
    initRouter()
    const len = history.length
    history.replaceState(null, '', '/journal/j1')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await nextTick()
    await Promise.resolve()
    expect(store.view).toBe('journal')
    expect(store.pageId).toBeNull()
    expect(history.length).toBe(len)

    store.view = 'shelf'
    store.journalId = null
    await nextTick()
    expect(location.pathname).toBe('/')
    expect(history.length).toBe(len + 1)
  })

  it('loadNav tolerates corrupted data', () => {
    expect(loadNav()).toBeNull()
    localStorage.setItem(NAV_KEY, '{oops')
    expect(loadNav()).toBeNull()
    localStorage.setItem(NAV_KEY, '42')
    expect(loadNav()).toBeNull()
  })
})
