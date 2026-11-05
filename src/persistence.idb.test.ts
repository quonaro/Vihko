import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { Journal } from './types'

// jsdom has no IndexedDB; fake-indexeddb supplies the real API surface. Each
// test gets a fresh factory AND fresh module state (the persistence module
// caches the opened database handle) to simulate separate app boots.
type PersistenceModule = typeof import('./persistence')

async function freshPersistence(): Promise<PersistenceModule> {
  vi.resetModules()
  return import('./persistence')
}

const saved: Journal[] = [
  {
    id: 'saved',
    title: 'Saved journal',
    cover: 0,
    createdAt: 1,
    pages: [{ id: 'page', strokes: [], createdAt: 1 }],
  },
]

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('IndexedDB journal persistence', () => {
  it('seeds an empty database from the fallback journals', async () => {
    const p = await freshPersistence()
    const journals = await p.loadOrCreateBrowserJournals(saved)
    expect(journals).toEqual(saved)

    // Next boot assembles the same data from IDB alone — fallback ignored.
    const p2 = await freshPersistence()
    expect(await p2.loadOrCreateBrowserJournals([])).toEqual(saved)
  })

  it('round-trips a page edit through a save batch', async () => {
    const p = await freshPersistence()
    await p.loadOrCreateBrowserJournals(saved)

    const page = {
      ...saved[0].pages[0],
      strokes: [{ tool: 'draw', color: '#000', pts: [{ x: 1, y: 2, t: 0, p: 0.5 }] }],
    }
    await p.saveJournalEntries({
      journals: [],
      pages: [{ id: 'page', json: JSON.stringify(page) }],
      deleteJournals: [],
      deletePages: [],
    })

    const p2 = await freshPersistence()
    const journals = await p2.loadOrCreateBrowserJournals([])
    expect(journals?.[0].pages[0].strokes).toHaveLength(1)
  })

  it('applies row deletes in a batch', async () => {
    const p = await freshPersistence()
    await p.loadOrCreateBrowserJournals(saved)
    await p.saveJournalEntries({
      order: [],
      journals: [],
      pages: [],
      deleteJournals: ['saved'],
      deletePages: ['page'],
    })

    const p2 = await freshPersistence()
    expect(await p2.loadOrCreateBrowserJournals([])).toEqual([])
  })

  it('migrates localStorage rows and clears them afterwards', async () => {
    const p = await freshPersistence()
    localStorage.setItem('vihko:v1', JSON.stringify({ v: 2, order: ['saved'] }))
    localStorage.setItem('vihko:v1:journal:saved', '{"id":"saved","pages":[{"id":"page"}]}')
    localStorage.setItem('vihko:v1:page:page', '{"id":"page","strokes":[]}')
    localStorage.setItem('vihko:brushes', '[]') // non-journal keys stay put

    // `saved` stands in for what the synchronous load() read out of those
    // localStorage rows before init ran.
    expect(await p.loadOrCreateBrowserJournals(saved)).toEqual(saved)
    expect(localStorage.getItem('vihko:v1')).toBeNull()
    expect(localStorage.getItem('vihko:v1:journal:saved')).toBeNull()
    expect(localStorage.getItem('vihko:v1:page:page')).toBeNull()
    expect(localStorage.getItem('vihko:brushes')).toBe('[]')

    const p2 = await freshPersistence()
    expect(await p2.loadOrCreateBrowserJournals([])).toEqual(saved)
  })

  it('keeps subsequent saves on indexeddb after hydration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await freshPersistence()
    await p.loadOrCreateBrowserJournals(saved)
    await p.saveJournalEntries({
      order: ['saved'],
      journals: [],
      pages: [],
      deleteJournals: [],
      deletePages: [],
    })
    expect(warn).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })
})
