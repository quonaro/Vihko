import { Capacitor } from '@capacitor/core'
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite'
import type { Journal, Page } from './types'

const DATABASE_NAME = 'vihko'
const JOURNALS_KEY = 'journals'
const LOCAL_INDEX_KEY = 'vihko:v1'
const journalKey = (id: string) => `journal:${id}`
const pageKey = (id: string) => `page:${id}`
const localKey = (key: string) => `${LOCAL_INDEX_KEY}:${key}`

export interface JournalDatabase {
  execute(statement: string): Promise<unknown>
  query(statement: string, values?: unknown[]): Promise<{ values?: JournalRow[] }>
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<unknown>
}

interface JournalRow {
  value: string
}

// v2 layout: one index row listing journal order, one `journal:<id>` row per
// journal (meta + page stubs only) and one `page:<id>` row per page. A stroke
// edit then rewrites a single page row instead of the whole corpus. The v1
// `journals` row held the entire serialized array and is migrated on load.
export interface JournalIndex {
  v: 2
  order: string[]
}

// Page data kept inside the journal row: just enough to rebuild the page
// list and page size without loading contents.
export type PageStub = Pick<Page, 'id' | 'w' | 'h' | 'createdAt'>

export interface JournalSaveBatch {
  order?: string[] // full journal order; omitted when unchanged
  journals: { id: string; json: string }[]
  pages: { id: string; json: string }[]
  deleteJournals: string[]
  deletePages: string[]
}

// Reassemble full journals from split rows. `readRow` maps a logical row key
// (`journal:<id>` / `page:<id>`) to its stored JSON; missing or malformed
// rows degrade to an empty page / a skipped journal instead of failing.
export function assembleJournals(
  index: JournalIndex,
  readRow: (key: string) => string | undefined,
): Journal[] {
  const out: Journal[] = []
  for (const id of index.order) {
    const metaJson = readRow(journalKey(id))
    if (!metaJson) continue
    try {
      const meta = JSON.parse(metaJson) as Omit<Journal, 'pages'> & { pages: PageStub[] }
      const pages = (meta.pages ?? []).map((stub) => {
        const row = readRow(pageKey(stub.id))
        if (row) {
          try {
            return JSON.parse(row) as Page
          } catch {
            /* fall through to the stub */
          }
        }
        return { ...stub, strokes: [], createdAt: stub.createdAt ?? 0 } as Page
      })
      out.push({ ...meta, pages })
    } catch {
      /* a broken journal row shouldn't take down the whole shelf */
    }
  }
  return out
}

export { JOURNALS_KEY, LOCAL_INDEX_KEY, journalKey, pageKey }

export function usesNativeSqlite(): boolean {
  return Capacitor.isNativePlatform()
}

let connection: SQLiteConnection | null = null
let database: SQLiteDBConnection | null = null

async function openDatabase(): Promise<SQLiteDBConnection> {
  if (database) return database

  connection ??= new SQLiteConnection(CapacitorSQLite)
  const consistency = await connection.checkConnectionsConsistency()
  const exists = await connection.isConnection(DATABASE_NAME, false)
  database =
    consistency.result && exists.result
      ? await connection.retrieveConnection(DATABASE_NAME, false)
      : await connection.createConnection(DATABASE_NAME, false, 'no-encryption', 1, false)
  await database.open()
  // Small per-row writes make WAL even cheaper; checkpointing + VACUUM on
  // open still reclaim space left by superseded values (and the old blob).
  try {
    await database.query('PRAGMA journal_mode=WAL')
    await database.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    await database.execute('VACUUM')
  } catch {
    // PRAGMA support varies across SQLite bindings — non-fatal.
  }
  return database
}

// Serialize in-memory journals into a complete save batch (used for seeds
// and the v1→v2 split, where every row has to be written at once).
function fullBatch(journals: Journal[]): JournalSaveBatch {
  return {
    order: journals.map((j) => j.id),
    journals: journals.map((j) => ({
      id: j.id,
      json: JSON.stringify({
        ...j,
        pages: j.pages.map((p) => ({ id: p.id, w: p.w, h: p.h, createdAt: p.createdAt })),
      }),
    })),
    pages: journals.flatMap((j) => j.pages.map((p) => ({ id: p.id, json: JSON.stringify(p) }))),
    deleteJournals: [],
    deletePages: [],
  }
}

// Apply a batch to SQLite: upserts first, then the index, then deletes — a
// crash mid-write can only leave orphaned rows, never an index pointing at
// missing data.
async function writeBatch(db: JournalDatabase, batch: JournalSaveBatch) {
  const upsert =
    'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  for (const j of batch.journals) await db.run(upsert, [journalKey(j.id), j.json], true)
  for (const p of batch.pages) await db.run(upsert, [pageKey(p.id), p.json], true)
  if (batch.order) {
    const index: JournalIndex = { v: 2, order: batch.order }
    await db.run(upsert, [JOURNALS_KEY, JSON.stringify(index)], true)
  }
  for (const id of batch.deleteJournals)
    await db.run('DELETE FROM app_state WHERE key = ?', [journalKey(id)], true)
  for (const id of batch.deletePages)
    await db.run('DELETE FROM app_state WHERE key = ?', [pageKey(id)], true)
}

export async function initializeJournalDatabase(
  db: JournalDatabase,
  fallback: Journal[],
): Promise<Journal[]> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `)

  const result = await db.query('SELECT value FROM app_state WHERE key = ?', [JOURNALS_KEY])
  const value = result.values?.[0]?.value
  if (value !== undefined) {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) {
      // v1 blob: split it into per-row storage right away so the next save
      // is already incremental.
      const journals = parsed as Journal[]
      await writeBatch(db, fullBatch(journals))
      return journals
    }
    const index = parsed as JournalIndex
    if (index?.v !== 2 || !Array.isArray(index.order))
      throw new Error('Invalid journals data in SQLite')
    // Collect all referenced rows first, then assemble synchronously.
    const rows: Record<string, string> = {}
    for (const id of index.order) {
      const metaRow = await db.query('SELECT value FROM app_state WHERE key = ?', [journalKey(id)])
      const metaJson = metaRow.values?.[0]?.value
      if (!metaJson) continue
      rows[journalKey(id)] = metaJson
      try {
        const meta = JSON.parse(metaJson) as Omit<Journal, 'pages'> & { pages: PageStub[] }
        for (const stub of meta.pages ?? []) {
          const pageRow = await db.query('SELECT value FROM app_state WHERE key = ?', [
            pageKey(stub.id),
          ])
          const pageJson = pageRow.values?.[0]?.value
          if (pageJson !== undefined) rows[pageKey(stub.id)] = pageJson
        }
      } catch {
        /* keep the journal row; pages fall back to stubs */
      }
    }
    return assembleJournals(index, (key) => rows[key])
  }

  await writeBatch(db, fullBatch(fallback))
  return fallback
}

export async function loadOrCreateNativeJournals(fallback: Journal[]): Promise<Journal[]> {
  return initializeJournalDatabase(await openDatabase(), fallback)
}

export async function saveJournalEntries(batch: JournalSaveBatch): Promise<void> {
  if (!usesNativeSqlite()) {
    // Browser path: same row layout under localStorage keys.
    try {
      for (const j of batch.journals) localStorage.setItem(localKey(journalKey(j.id)), j.json)
      for (const p of batch.pages) localStorage.setItem(localKey(pageKey(p.id)), p.json)
      if (batch.order) {
        const index: JournalIndex = { v: 2, order: batch.order }
        localStorage.setItem(LOCAL_INDEX_KEY, JSON.stringify(index))
      }
      for (const id of batch.deleteJournals) localStorage.removeItem(localKey(journalKey(id)))
      for (const id of batch.deletePages) localStorage.removeItem(localKey(pageKey(id)))
    } catch {
      // Keep the current session usable if browser storage is full.
    }
    return
  }

  const db = await openDatabase()
  await writeBatch(db, batch)
}
