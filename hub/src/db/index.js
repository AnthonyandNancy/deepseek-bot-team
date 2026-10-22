// The database: one file, opened once, migrated on open.
//
// `node:sqlite` rather than better-sqlite3 keeps the Hub's only dependency to `ws`. It has
// been runtime-checked on the Node the Desktop actually runs (24.21.0), where it needs no
// flag and prints no experimental warning.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LATEST_VERSION, MIGRATIONS } from './migrations.js'

const now = () => new Date().toISOString()

// WAL lets a reader run while a writer holds the file; the foreign keys are what makes the
// ON DELETE CASCADE above real; busy_timeout turns a concurrent writer into a short wait
// instead of an immediate SQLITE_BUSY.
const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA synchronous = NORMAL',
]

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  for (const pragma of PRAGMAS) db.exec(pragma)
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  migrate(db)
  return db
}

export const openDatabaseIn = dir => openDatabase(join(dir, 'hub.db'))

function currentVersion(db) {
  const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get()
  return row?.version ?? 0
}

// Applies every migration newer than the stored version, each in its own transaction with
// its own version row. Re-running on an up-to-date database does nothing, which is what
// makes "start the Hub twice" safe.
export function migrate(db, migrations = MIGRATIONS) {
  const from = currentVersion(db)
  if (from > LATEST_VERSION) throw new Error(`database schema is version ${from}; this Hub knows ${LATEST_VERSION}`)
  const applied = []
  for (const migration of migrations) {
    if (migration.version <= from) continue
    db.exec('BEGIN')
    try {
      for (const statement of migration.statements) db.exec(statement)
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(migration.version, now())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${migration.version} failed: ${error.message}`)
    }
    applied.push(migration.version)
  }
  return applied
}

export const schemaVersion = db => currentVersion(db)

// A SQLite UNIQUE violation arrives as `errcode 1555` with the column in the message. The
// auth code turns that into the same 409 it would give a duplicate it checked for first,
// so a race between two registrations cannot become a 500.
const SQLITE_CONSTRAINT_UNIQUE = 1555
export function isUniqueViolation(error) {
  return error?.errcode === SQLITE_CONSTRAINT_UNIQUE || /UNIQUE constraint failed/.test(error?.message ?? '')
}
