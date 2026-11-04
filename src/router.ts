import { watch } from 'vue'
import { currentJournal, store } from './store'
import type { JournalMode, ViewName } from './store'

export interface NavState {
  view: ViewName
  journalId: string | null
  pageId: string | null
  journalMode: JournalMode
}

export const NAV_KEY = 'vihko:nav'
const SHELF: NavState = { view: 'shelf', journalId: null, pageId: null, journalMode: 'stack' }

const enc = encodeURIComponent

export function navPath(nav: NavState): string {
  if (nav.view === 'journal' && nav.journalId)
    return `/journal/${enc(nav.journalId)}${nav.journalMode === 'overview' ? '/overview' : ''}`
  if (nav.view === 'canvas' && nav.journalId && nav.pageId)
    return `/journal/${enc(nav.journalId)}/page/${enc(nav.pageId)}`
  return '/'
}

export function parseNav(pathname: string): NavState {
  const seg = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (seg[0] !== 'journal' || !seg[1]) return { ...SHELF }
  const journalId = seg[1]
  if (seg[2] === 'page' && seg[3])
    return { view: 'canvas', journalId, pageId: seg[3], journalMode: 'stack' }
  if (seg[2] === 'overview')
    return { view: 'journal', journalId, pageId: null, journalMode: 'overview' }
  return { view: 'journal', journalId, pageId: null, journalMode: 'stack' }
}

// Drop references to journals/pages that no longer exist, falling back one
// level at a time (canvas -> journal -> shelf).
function resolveNav(nav: NavState): NavState {
  const j = store.journals.find((x) => x.id === nav.journalId)
  if (!j) return { ...SHELF }
  if (nav.view === 'journal')
    return { view: 'journal', journalId: j.id, pageId: null, journalMode: nav.journalMode }
  const p = j.pages.find((x) => x.id === nav.pageId)
  if (!p) return { view: 'journal', journalId: j.id, pageId: null, journalMode: nav.journalMode }
  return { view: 'canvas', journalId: j.id, pageId: p.id, journalMode: nav.journalMode }
}

export function applyNav(nav: NavState) {
  const r = resolveNav(nav)
  const switched = r.journalId !== store.journalId
  store.journalId = r.journalId
  store.pageId = r.pageId
  store.journalMode = r.journalMode
  const idx = currentJournal()?.pages.findIndex((p) => p.id === r.pageId) ?? -1
  if (idx >= 0) {
    store.journalPageIdx = idx
    store.journalOverviewIdx = idx
  } else if (switched) {
    store.journalPageIdx = 0
    store.journalOverviewIdx = 0
  }
  store.view = r.view
}

function currentNav(): NavState {
  return {
    view: store.view,
    journalId: store.journalId,
    pageId: store.pageId,
    journalMode: store.journalMode,
  }
}

function persistNav() {
  try {
    localStorage.setItem(NAV_KEY, JSON.stringify(currentNav()))
  } catch {
    /* quota */
  }
}

export function loadNav(): NavState | null {
  try {
    const raw = localStorage.getItem(NAV_KEY)
    if (!raw) return null
    const nav = JSON.parse(raw) as NavState
    if (typeof nav?.view !== 'string') return null
    return { ...SHELF, ...nav }
  } catch {
    return null
  }
}

function syncUrl(replace: boolean) {
  const path = navPath(currentNav())
  if (location.pathname === path) return
  if (replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
}

let popping = false

// Two-way sync between the URL and store.view/journalId/pageId/journalMode,
// plus a localStorage copy of the last position so the native WebView (which
// always boots on "/") and a bare dev-server reload reopen where we left off.
export function initRouter() {
  const initial = location.pathname === '/' ? loadNav() : parseNav(location.pathname)
  if (initial) applyNav(initial)
  syncUrl(true)
  persistNav()

  watch(
    () => [store.view, store.journalId, store.pageId, store.journalMode] as const,
    () => {
      persistNav()
      syncUrl(popping)
    },
  )

  window.addEventListener('popstate', () => {
    popping = true
    applyNav(parseNav(location.pathname))
    // The watcher is microtask-queued behind this, so the flag is still set
    // when it runs; clear it afterwards in case applyNav changed nothing.
    queueMicrotask(() => {
      popping = false
    })
  })
}
