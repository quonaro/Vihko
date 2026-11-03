import { describe, expect, it, vi } from 'vitest'
import { initializeJournalDatabase, type JournalDatabase } from './persistence'
import type { Journal } from './types'

function fakeDatabase(savedValue?: string): JournalDatabase {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({
      values: savedValue === undefined ? [] : [{ value: savedValue }],
    }),
    run: vi.fn().mockResolvedValue(undefined),
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

describe('SQLite journal persistence', () => {
  it('restores saved journals from the database', async () => {
    const db = fakeDatabase(JSON.stringify(saved))
    const result = await initializeJournalDatabase(db, [])

    expect(result).toEqual(saved)
    expect(db.run).not.toHaveBeenCalled()
  })

  it('migrates the existing local data when the database is empty', async () => {
    const db = fakeDatabase()
    const result = await initializeJournalDatabase(db, saved)

    expect(result).toEqual(saved)
    expect(db.run).toHaveBeenCalledWith(
      'INSERT INTO app_state (key, value) VALUES (?, ?)',
      ['journals', JSON.stringify(saved)],
      true,
    )
  })

  it('does not overwrite malformed database data', async () => {
    const db = fakeDatabase('{broken')

    await expect(initializeJournalDatabase(db, saved)).rejects.toThrow()
    expect(db.run).not.toHaveBeenCalled()
  })
})
