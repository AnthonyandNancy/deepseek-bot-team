// The database: pragmas that make the invariants real, and a migration that can run twice.
//
// "Migrations are idempotent" is not a style preference here. The Hub is started by a person
// who may well start it twice, and a second start that tries to re-create a table would crash
// the service that is supposed to be running.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, isUniqueViolation, schemaVersion } from '../src/db/index.js'
import { LATEST_VERSION } from '../src/db/migrations.js'

// Opens a database in its own directory and tears both down in one hook.
//
// One hook, in this order, because Windows refuses to delete a file that is still open: two
// separate `t.after` calls run in registration order, so removing the directory first would
// fail with EPERM while the handle is live.
const withDatabase = (t, file = 'hub.db') => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-db-'))
  const db = openDatabase(join(dir, file))
  t.after(() => {
    try { db.close() } catch { /* already closed by the test */ }
    rmSync(dir, { recursive: true, force: true })
  })
  return { db, dir }
}

test('the file is in WAL mode with foreign keys on and a busy timeout', (t) => {
  const { db } = withDatabase(t)

  // WAL: a reader does not block a writer. Without it a long read would stall login.
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  // Foreign keys default to OFF in SQLite; without this the ON DELETE CASCADE is decorative.
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
})

test('a foreign key violation is actually refused', (t) => {
  const { db } = withDatabase(t)

  // The pragma is only worth asserting if it does something; this proves the orphan insert
  // fails rather than being silently accepted.
  assert.throws(() => {
    db.prepare('INSERT INTO devices (id, user_id, public_key, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('dev_1', 'usr_missing', 'key', 'x', new Date().toISOString())
  }, /FOREIGN KEY constraint failed/)
})

test('reopening an up-to-date database changes nothing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-db-'))
  const first = openDatabase(join(dir, 'hub.db'))
  assert.equal(schemaVersion(first), LATEST_VERSION)
  // A row written before the restart must survive it.
  first.prepare('INSERT INTO users (id, phone_e164, password_phc, password_version, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('usr_keep', '+8613800138000', '$scrypt$x$y$z', 1, new Date().toISOString())
  first.close()

  const second = openDatabase(join(dir, 'hub.db'))
  t.after(() => {
    try { second.close() } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true })
  })
  assert.equal(schemaVersion(second), LATEST_VERSION)
  assert.equal(second.prepare('SELECT count(*) AS c FROM users').get().c, 1)
})

test('the G3 tables exist and the deliberately absent one does not', (t) => {
  const { db } = withDatabase(t)
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name)

  for (const table of ['users', 'auth_sessions', 'devices', 'audit_events', 'schema_version']) {
    assert.ok(names.includes(table), `${table} should exist`)
  }
  // No SMS in V1 means no OTP table. Creating one would invite a future implementer to build
  // the flow without the gateway the gate requires.
  assert.equal(names.includes('otp_challenges'), false, 'otp_challenges must not exist')
})

test('the G4 and G5 tables exist and group memory has no Hub table', (t) => {
  const { db } = withDatabase(t)
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name)

  for (const table of [
    'bot_endpoints', 'workgroups', 'memberships', 'invites', 'events',
    'deliveries', 'read_cursors', 'attachments', 'attachment_tickets',
    // G5 (migration 4). This list moved when G5 landed: the schema test for a phase asserts what
    // that phase added, and the previous phase's "must not exist yet" line is replaced rather than
    // left behind to fail.
    'tasks', 'approvals', 'round_leases', 'artifacts',
  ]) {
    assert.ok(names.includes(table), `${table} should exist`)
  }
  // Group memory belongs to the original engine on each machine. The Hub carries only its
  // `memory.change` events in the existing events table; a memory table here would be the parallel
  // store G6R removed.
  for (const table of ['group_memories', 'group_memory_events', 'group_memories_fts']) {
    assert.equal(names.includes(table), false, `${table} must not exist`)
  }
})

test('a phone number and a device key are each unique where they must be', (t) => {
  const { db } = withDatabase(t)
  const now = new Date().toISOString()
  const insertUser = db.prepare('INSERT INTO users (id, phone_e164, password_phc, password_version, created_at) VALUES (?, ?, ?, ?, ?)')
  insertUser.run('usr_1', '+8613800138000', '$scrypt$a$b$c', 1, now)

  // Two accounts may not share a login name.
  let error
  try { insertUser.run('usr_2', '+8613800138000', '$scrypt$a$b$c', 1, now) } catch (caught) { error = caught }
  assert.ok(error !== undefined)
  assert.equal(isUniqueViolation(error), true)

  // One key may not be claimed by two accounts.
  const insertDevice = db.prepare('INSERT INTO devices (id, user_id, public_key, name, created_at) VALUES (?, ?, ?, ?, ?)')
  insertDevice.run('dev_1', 'usr_1', 'PEM', 'Laptop', now)
  let deviceError
  try { insertDevice.run('dev_2', 'usr_1', 'PEM', 'Laptop again', now) } catch (caught) { deviceError = caught }
  assert.equal(isUniqueViolation(deviceError), true, 'the same key must not create a second device row')
})

test('deleting a user takes its sessions and devices with it', (t) => {
  const { db } = withDatabase(t)
  const now = new Date().toISOString()
  db.prepare('INSERT INTO users (id, phone_e164, password_phc, password_version, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('usr_1', '+8613800138000', '$scrypt$a$b$c', 1, now)
  db.prepare('INSERT INTO devices (id, user_id, public_key, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('dev_1', 'usr_1', 'PEM', 'Laptop', now)

  db.prepare('DELETE FROM users WHERE id = ?').run('usr_1')
  assert.equal(db.prepare('SELECT count(*) AS c FROM devices').get().c, 0)
})

test('an in-memory database works, which is what the quick tests use', (t) => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  assert.equal(schemaVersion(db), LATEST_VERSION)
})
