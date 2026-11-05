import { Capacitor } from '@capacitor/core'
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite'
import type { Journal, Page } from './types'
import { logger } from './log'

const log = logger('persistence')

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
    if (!metaJson) {
      log.debug('journal row missing from index', id)
      continue
    }
    try {
      const meta = JSON.parse(metaJson) as Omit<Journal, 'pages'> & { pages: PageStub[] }
      const pages = (meta.pages ?? []).map((stub) => {
        const row = readRow(pageKey(stub.id))
        if (row) {
          try {
            return JSON.parse(row) as Page
          } catch {
            /* fall through to the stub */
            log.warn('page row unreadable, falling back to stub', stub.id)
          }
        }
        return { ...stub, strokes: [], createdAt: stub.createdAt ?? 0 } as Page
      })
      out.push({ ...meta, pages })
    } catch {
      /* a broken journal row shouldn't take down the whole shelf */
      log.warn('journal row unreadable, skipped', id)
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
  log.info('sqlite database open', { reused: !!(consistency.result && exists.result) })
  // Small per-row writes make WAL even cheaper; checkpointing + VACUUM on
  // open still reclaim space left by superseded values (and the old blob).
  try {
    await database.query('PRAGMA journal_mode=WAL')
    await database.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    await database.execute('VACUUM')
  } catch (e) {
    // PRAGMA support varies across SQLite bindings — non-fatal.
    log.debug('WAL/VACUUM pragmas unsupported', e)
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

// Apply a batch to SQLite: page rows first, then the journal rows whose stubs
// reference them, then the index, then deletes — a crash mid-write can only
// leave orphaned rows, never a stub or index entry pointing at missing data.
async function writeBatch(db: JournalDatabase, batch: JournalSaveBatch) {
  log.debug('writing batch', {
    order: !!batch.order,
    journals: batch.journals.length,
    pages: batch.pages.length,
    deleteJournals: batch.deleteJournals.length,
    deletePages: batch.deletePages.length,
  })
  const upsert =
    'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  for (const p of batch.pages) await db.run(upsert, [pageKey(p.id), p.json], true)
  for (const j of batch.journals) await db.run(upsert, [journalKey(j.id), j.json], true)
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
      log.info('migrating v1 blob into per-row storage', journals.length)
      await writeBatch(db, fullBatch(journals))
      return journals
    }
    const index = parsed as JournalIndex
    if (index?.v !== 2 || !Array.isArray(index.order)) {
      log.error('invalid journals index in sqlite')
      throw new Error('Invalid journals data in SQLite')
    }
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

  log.info('no stored index, seeding rows from fallback', fallback.length)
  await writeBatch(db, fullBatch(fallback))
  return fallback
}

export async function loadOrCreateNativeJournals(fallback: Journal[]): Promise<Journal[]> {
  return initializeJournalDatabase(await openDatabase(), fallback)
}

// --- IndexedDB (browser) ------------------------------------------------------
// Same v2 row layout inside an `app_state` object store. Writes commit per
// batch inside transactions, and the store is effectively unbounded compared
// to the ~5 MB localStorage quota that photo dataURLs overflow.
const IDB_NAME = 'vihko'
const IDB_STORE = 'app_state'

let browserDb: Promise<IDBDatabase> | null = null
let idbFailed = false

// Lazily opens (and shares) the browser database; null where IndexedDB is
// missing (jsdom tests, locked-down browsers) or refused to open — callers
// then stay on the localStorage path.
function browserDatabase(): Promise<IDBDatabase> | null {
  if (idbFailed) {
    log.debug('indexeddb already failed this session, skipping')
    return null
  }
  if (typeof indexedDB === 'undefined') {
    log.debug('indexeddb api missing, skipping')
    return null
  }
  browserDb ??= new Promise<IDBDatabase>((resolve, reject) => {
    log.debug('opening indexeddb database', { name: IDB_NAME, version: 1 })
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      log.info('creating app_state object store')
      req.result.createObjectStore(IDB_STORE)
    }
    req.onsuccess = () => {
      log.info('indexeddb database open')
      resolve(req.result)
    }
    req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'))
    // Another tab holding a different-version connection can stall open.
    req.onblocked = () => log.warn('indexeddb open blocked by another tab')
  }).catch((e: unknown) => {
    idbFailed = true
    browserDb = null
    log.warn('indexeddb open failed, falling back to localStorage', e)
    throw e
  })
  return browserDb
}

function idbTx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode)
    const req = run(tx.objectStore(IDB_STORE))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => {
      log.debug('indexeddb tx error', mode, tx.error)
      reject(tx.error)
    }
    tx.onabort = () => {
      log.debug('indexeddb tx aborted', mode, tx.error)
      reject(tx.error)
    }
  })
}

// The KV object store behind the JournalDatabase interface, so
// initializeJournalDatabase and writeBatch run unchanged against IndexedDB.
function idbAdapter(db: IDBDatabase): JournalDatabase {
  return {
    // The object store is created in onupgradeneeded, not by a statement.
    execute: () => Promise.resolve(undefined),
    query: (_sql, vals) =>
      idbTx(db, 'readonly', (s) => s.get(vals![0] as IDBValidKey)).then((value) => ({
        values: value === undefined ? [] : [{ value: value as string }],
      })),
    run: (sql, vals) => {
      const key = vals![0] as IDBValidKey
      const put = () => idbTx(db, 'readwrite', (s) => s.put(vals![1] as string, key))
      const del = () => idbTx(db, 'readwrite', (s) => s.delete(key))
      return (sql.startsWith('DELETE') ? del() : put()).then(() => undefined)
    },
  }
}

// Removes the localStorage rows after their contents have been replicated
// into IndexedDB — the migration is done and the tight localStorage quota is
// freed for flags and other small state.
function removeBrowserLocalRows() {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (key === LOCAL_INDEX_KEY || key.startsWith(`${LOCAL_INDEX_KEY}:`))) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
    if (keys.length) log.info('migrated localStorage rows into indexeddb', keys.length)
  } catch (e) {
    log.debug('localStorage cleanup failed', e)
  }
}

// Hydrates journals from IndexedDB; null where the API is missing or refused
// to open, so the caller keeps the localStorage path. On an empty database
// the fallback (the synchronously loaded localStorage/seed data) is written
// in — that completes the localStorage → IDB migration.
export async function loadOrCreateBrowserJournals(fallback: Journal[]): Promise<Journal[] | null> {
  const dbp = browserDatabase()
  if (!dbp) {
    log.debug('no indexeddb handle, browser persistence stays on localStorage')
    return null
  }
  log.debug('hydrating journals from indexeddb', { fallback: fallback.length })
  const journals = await initializeJournalDatabase(idbAdapter(await dbp), fallback)
  // Best-effort: ask the browser not to evict this origin under disk pressure.
  void Promise.resolve(navigator.storage?.persist?.())
    .then((granted) => log.debug('persistent storage bucket', { granted: !!granted }))
    .catch(() => {})
  removeBrowserLocalRows()
  log.info('indexeddb hydrate done', journals.length)
  return journals
}

// localStorage write failures (quota full, storage blocked) are reported once
// per streak — a debounced save would otherwise spam the warning every 400 ms.
let localSaveFailed = false

export async function saveJournalEntries(batch: JournalSaveBatch): Promise<void> {
  if (!usesNativeSqlite()) {
    const dbp = browserDatabase()
    if (dbp) {
      try {
        await writeBatch(idbAdapter(await dbp), batch)
        log.debug('indexeddb batch written', {
          journals: batch.journals.length,
          pages: batch.pages.length,
          deletes: batch.deleteJournals.length + batch.deletePages.length,
        })
      } catch (e) {
        // Keep the current session usable; the in-memory store is untouched.
        log.warn('indexeddb save failed', e, {
          journals: batch.journals.length,
          pages: batch.pages.length,
          bytes:
            batch.journals.reduce((n, r) => n + r.json.length, 0) +
            batch.pages.reduce((n, r) => n + r.json.length, 0),
        })
      }
      return
    }
    // Fallback without IndexedDB: same row layout under localStorage keys.
    // Page rows go before the journal rows referencing them (see writeBatch).
    let failedKey = ''
    let failedBytes = 0
    const put = (key: string, value: string) => {
      failedKey = key
      failedBytes = value.length
      localStorage.setItem(key, value)
    }
    try {
      for (const p of batch.pages) put(localKey(pageKey(p.id)), p.json)
      for (const j of batch.journals) put(localKey(journalKey(j.id)), j.json)
      if (batch.order) {
        const index: JournalIndex = { v: 2, order: batch.order }
        put(LOCAL_INDEX_KEY, JSON.stringify(index))
      }
      for (const id of batch.deleteJournals) localStorage.removeItem(localKey(journalKey(id)))
      for (const id of batch.deletePages) localStorage.removeItem(localKey(pageKey(id)))
      if (localSaveFailed) {
        localSaveFailed = false
        log.info('localStorage save recovered')
      }
    } catch (e) {
      // Keep the current session usable if browser storage is full.
      const detail = { key: failedKey, bytes: failedBytes }
      if (localSaveFailed) log.debug('localStorage save still failing', e, detail)
      else log.warn('localStorage save failed (quota?)', e, detail)
      localSaveFailed = true
    }
    return
  }

  const db = await openDatabase()
  await writeBatch(db, batch)
}
