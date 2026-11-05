import { describe, expect, it, vi } from 'vitest'
import {
  assembleJournals,
  initializeJournalDatabase,
  saveJournalEntries,
  type JournalDatabase,
} from './persistence'
import type { Journal } from './types'

function fakeDatabase(rows: Record<string, string> = {}): JournalDatabase {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation((_sql: string, vals?: unknown[]) => {
      const key = vals?.[0] as string
      const value = rows[key]
      return Promise.resolve({ values: value === undefined ? [] : [{ value }] })
    }),
    run: vi.fn().mockImplementation((sql: string, vals?: unknown[]) => {
      const key = vals?.[0] as string
      if (sql.startsWith('INSERT') && key) rows[key] = vals?.[1] as string
      if (sql.startsWith('DELETE') && key) delete rows[key]
      return Promise.resolve(undefined)
    }),
  }
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

const v2Rows = (journals: Journal[]): Record<string, string> => {
  const rows: Record<string, string> = {
    journals: JSON.stringify({ v: 2, order: journals.map((j) => j.id) }),
  }
  for (const j of journals) {
    rows[`journal:${j.id}`] = JSON.stringify({
      ...j,
      pages: j.pages.map((p) => ({ id: p.id, w: p.w, h: p.h, createdAt: p.createdAt })),
    })
    for (const p of j.pages) rows[`page:${p.id}`] = JSON.stringify(p)
  }
  return rows
}

describe('SQLite journal persistence', () => {
  it('restores saved journals from v2 rows', async () => {
    const db = fakeDatabase(v2Rows(saved))
    const result = await initializeJournalDatabase(db, [])

    expect(result).toEqual(saved)
    expect(db.run).not.toHaveBeenCalled()
  })

  it('splits a v1 blob into per-journal/page rows on load', async () => {
    const rows: Record<string, string> = { journals: JSON.stringify(saved) }
    const db = fakeDatabase(rows)
    const result = await initializeJournalDatabase(db, [])

    expect(result).toEqual(saved)
    expect(JSON.parse(rows.journals)).toEqual({ v: 2, order: ['saved'] })
    expect(JSON.parse(rows['journal:saved']).pages).toEqual([{ id: 'page', createdAt: 1 }])
    expect(JSON.parse(rows['page:page']).id).toBe('page')
  })

  it('writes the seed as v2 rows when the database is empty', async () => {
    const rows: Record<string, string> = {}
    const db = fakeDatabase(rows)
    const result = await initializeJournalDatabase(db, saved)

    expect(result).toEqual(saved)
    expect(JSON.parse(rows.journals)).toEqual({ v: 2, order: ['saved'] })
    expect(rows['journal:saved']).toBeTruthy()
    expect(rows['page:page']).toBeTruthy()
  })

  it('does not overwrite malformed database data', async () => {
    const db = fakeDatabase({ journals: '{broken' })

    await expect(initializeJournalDatabase(db, saved)).rejects.toThrow()
    expect(db.run).not.toHaveBeenCalled()
  })

  it('skips missing journal rows and falls back to stubs for missing pages', async () => {
    const rows = v2Rows(saved)
    delete rows['page:page']
    rows.journals = JSON.stringify({ v: 2, order: ['saved', 'gone'] })
    const db = fakeDatabase(rows)

    const result = await initializeJournalDatabase(db, [])
    expect(result).toHaveLength(1)
    expect(result[0].pages[0]).toMatchObject({ id: 'page', strokes: [] })
  })
})

describe('saveJournalEntries (localStorage path)', () => {
  it('writes only the batched rows and index', async () => {
    localStorage.clear()
    localStorage.setItem('vihko:v1:journal:old', '{}')
    localStorage.setItem('vihko:v1:page:gone', '{}')

    await saveJournalEntries({
      order: ['a'],
      journals: [{ id: 'a', json: '{"id":"a","pages":[{"id":"p"}]}' }],
      pages: [{ id: 'p', json: '{"id":"p","strokes":[]}' }],
      deleteJournals: ['old'],
      deletePages: ['gone'],
    })

    expect(JSON.parse(localStorage.getItem('vihko:v1')!)).toEqual({ v: 2, order: ['a'] })
    expect(localStorage.getItem('vihko:v1:journal:a')).toBe('{"id":"a","pages":[{"id":"p"}]}')
    expect(localStorage.getItem('vihko:v1:page:p')).toBe('{"id":"p","strokes":[]}')
    expect(localStorage.getItem('vihko:v1:journal:old')).toBeNull()
    expect(localStorage.getItem('vihko:v1:page:gone')).toBeNull()
  })

  it('assembleJournals reassembles split rows', () => {
    const rows = v2Rows(saved)
    const journals = assembleJournals({ v: 2, order: ['saved'] }, (key) => rows[key])
    expect(journals).toEqual(saved)
  })
})
