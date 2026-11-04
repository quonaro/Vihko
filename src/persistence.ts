import { Capacitor } from '@capacitor/core'
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite'
import type { Journal } from './types'

const DATABASE_NAME = 'vihko'
const JOURNALS_KEY = 'journals'

interface JournalRow {
  value: string
}

export interface JournalDatabase {
  execute(statement: string): Promise<unknown>
  query(statement: string, values?: unknown[]): Promise<{ values?: JournalRow[] }>
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<unknown>
}

let connection: SQLiteConnection | null = null
let database: SQLiteDBConnection | null = null

export function usesNativeSqlite(): boolean {
  return Capacitor.isNativePlatform()
}

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
  // The whole journal model is one big app_state row rewritten on every
  // save: WAL mode keeps writes cheap, checkpointing + VACUUM on open
  // reclaim the file space left by superseded giant values.
  try {
    await database.query('PRAGMA journal_mode=WAL')
    await database.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    await database.execute('VACUUM')
  } catch {
    // PRAGMA support varies across SQLite bindings — non-fatal.
  }
  return database
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
    const journals: unknown = JSON.parse(value)
    if (!Array.isArray(journals)) throw new Error('Invalid journals data in SQLite')
    return journals as Journal[]
  }

  const serialized = JSON.stringify(fallback)
  await db.run('INSERT INTO app_state (key, value) VALUES (?, ?)', [JOURNALS_KEY, serialized], true)
  return fallback
}

export async function loadOrCreateNativeJournals(fallback: Journal[]): Promise<Journal[]> {
  return initializeJournalDatabase(await openDatabase(), fallback)
}

export async function saveJournalSnapshot(serialized: string): Promise<void> {
  if (!usesNativeSqlite()) {
    try {
      localStorage.setItem('vihko:v1', serialized)
    } catch {
      // Keep the current session usable if browser storage is full.
    }
    return
  }

  const db = await openDatabase()
  await db.run(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JOURNALS_KEY, serialized],
    true,
  )
}
