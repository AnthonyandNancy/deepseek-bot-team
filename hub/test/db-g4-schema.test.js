// The invariants the G4 tables exist to enforce, asserted against the database itself.
//
// These are checked at the schema level on purpose: `(workgroup_id, seq)` unique, `event_id`
// unique and `upgrade_id` unique are what make gate item 2 (no duplicate or reordered events)
// and gate item 4 (a retried upgrade makes one group) facts rather than conventions the service
// code happens to follow. If a future migration drops one of these constraints, the gate's
// evidence would silently stop meaning anything — so a test fails here instead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, isUniqueViolation } from '../src/db/index.js'

const withDatabase = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-g4-db-'))
  const db = openDatabase(join(dir, 'hub.db'))
  t.after(() => {
    try { db.close() } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true })
  })
  return { db, dir }
}

const at = () => new Date().toISOString()

// A minimal fixture: one user, one device, one group. Written with plain SQL so the test does not
// depend on the service layer it is meant to hold up.
function seed(db) {
  db.prepare('INSERT INTO users (id, phone_e164, password_phc, password_version, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('usr_1', '+8613800138000', '$scrypt$a$b$c', 1, at())
  db.prepare('INSERT INTO devices (id, user_id, public_key, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('dev_1', 'usr_1', 'PEM-1', 'Laptop', at())
  db.prepare('INSERT INTO workgroups (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('wg_1', 'usr_1', 'Group', at())
}

const insertEvent = (db, { eventId, seq, workgroupId = 'wg_1' }) =>
  db.prepare(`INSERT INTO events (event_id, workgroup_id, seq, type, sender_id, payload, created_at)
    VALUES (?, ?, ?, 'chat.message', 'usr_1', '{}', ?)`)
    .run(eventId, workgroupId, seq, at())

const catchError = (fn) => {
  try { fn() } catch (error) { return error }
  return undefined
}

test('a group cannot hold two events at the same seq', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  insertEvent(db, { eventId: 'evt_a', seq: 1 })

  const error = catchError(() => insertEvent(db, { eventId: 'evt_b', seq: 1 }))
  assert.ok(error !== undefined, 'a second event at seq 1 must be refused')
  assert.equal(isUniqueViolation(error), true)
})

test('the same event_id cannot be stored twice', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  insertEvent(db, { eventId: 'evt_a', seq: 1 })

  // A resent event — same id, and a seq the Hub would not have handed out twice — is still a
  // duplicate: the primary key refuses it before the seq constraint is even consulted.
  const error = catchError(() => insertEvent(db, { eventId: 'evt_a', seq: 2 }))
  assert.ok(error !== undefined, 'a resent event must be deduplicated')
  assert.equal(isUniqueViolation(error), true)
  assert.equal(db.prepare('SELECT count(*) AS c FROM events').get().c, 1)
})

test('two groups may each use seq 1, and the counter starts at 0', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  db.prepare('INSERT INTO workgroups (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('wg_2', 'usr_1', 'Other', at())

  // `seq` is per group, not global: two groups both begin at 1 and neither blocks the other.
  insertEvent(db, { eventId: 'evt_a', seq: 1 })
  insertEvent(db, { eventId: 'evt_b', seq: 1, workgroupId: 'wg_2' })
  assert.equal(db.prepare('SELECT last_seq FROM workgroups WHERE id = ?').get('wg_1').last_seq, 0)
})

test('an upgrade id is unique, so a replay cannot create a second group', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  db.prepare('UPDATE workgroups SET upgrade_id = ? WHERE id = ?').run('up_1', 'wg_1')

  const error = catchError(() => {
    db.prepare('INSERT INTO workgroups (id, owner_user_id, name, upgrade_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('wg_2', 'usr_1', 'Same upgrade', 'up_1', at())
  })
  assert.ok(error !== undefined, 'the same upgrade_id must not produce a second group')
  assert.equal(isUniqueViolation(error), true)
})

test('a group may exist without an upgrade id, and many may', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  // UNIQUE allows repeated NULLs, which is what lets every ordinary group skip the column.
  db.prepare('INSERT INTO workgroups (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('wg_2', 'usr_1', 'Plain', at())
  db.prepare('INSERT INTO workgroups (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('wg_3', 'usr_1', 'Plain too', at())
  assert.equal(db.prepare('SELECT count(*) AS c FROM workgroups').get().c, 3)
})

test('a person and a Bot endpoint may each join a group once, not twice', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  db.prepare(`INSERT INTO bot_endpoints (id, owner_id, device_id, local_bot_id, name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run('ep_1', 'usr_1', 'dev_1', 'chief', 'Chief', at())

  const addUser = db.prepare(`INSERT INTO memberships (id, workgroup_id, member_type, user_id, role, joined_at)
    VALUES (?, 'wg_1', 'user', ?, 'member', ?)`)
  addUser.run('mem_1', 'usr_1', at())
  const userError = catchError(() => addUser.run('mem_2', 'usr_1', at()))
  assert.equal(isUniqueViolation(userError), true, 'the same person must not join twice')

  const addBot = db.prepare(`INSERT INTO memberships (id, workgroup_id, member_type, endpoint_id, role, joined_at)
    VALUES (?, 'wg_1', 'botEndpoint', ?, 'member', ?)`)
  addBot.run('mem_3', 'ep_1', at())
  const botError = catchError(() => addBot.run('mem_4', 'ep_1', at()))
  assert.equal(isUniqueViolation(botError), true, 'the same Bot endpoint must not join twice')
})

test('a membership must name exactly one of a user or a Bot endpoint', (t) => {
  const { db } = withDatabase(t)
  seed(db)

  // Neither: a row that is a member of nothing.
  const neither = catchError(() => {
    db.prepare(`INSERT INTO memberships (id, workgroup_id, member_type, role, joined_at)
      VALUES ('mem_x', 'wg_1', 'user', 'member', ?)`).run(at())
  })
  assert.match(String(neither?.message), /CHECK constraint failed/)
})

test('deleting a group takes its events, members and deliveries with it', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  insertEvent(db, { eventId: 'evt_a', seq: 1 })
  db.prepare(`INSERT INTO memberships (id, workgroup_id, member_type, user_id, role, joined_at)
    VALUES ('mem_1', 'wg_1', 'user', 'usr_1', 'owner', ?)`).run(at())
  db.prepare('INSERT INTO deliveries (event_id, device_id, delivered_at) VALUES (?, ?, ?)').run('evt_a', 'dev_1', at())

  db.prepare('DELETE FROM workgroups WHERE id = ?').run('wg_1')
  assert.equal(db.prepare('SELECT count(*) AS c FROM events').get().c, 0)
  assert.equal(db.prepare('SELECT count(*) AS c FROM memberships').get().c, 0)
  // Deliveries cascade through the event they belong to.
  assert.equal(db.prepare('SELECT count(*) AS c FROM deliveries').get().c, 0)
})

test('only one pending invite may exist per person per group', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  db.prepare('INSERT INTO users (id, phone_e164, password_phc, password_version, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('usr_2', '+8613900139000', '$scrypt$a$b$c', 1, at())

  const insert = db.prepare(`INSERT INTO invites (id, workgroup_id, invited_by, invitee_id, status, created_at, expires_at)
    VALUES (?, 'wg_1', 'usr_1', 'usr_2', 'pending', ?, ?)`)
  insert.run('inv_1', at(), at())
  const error = catchError(() => insert.run('inv_2', at(), at()))
  assert.equal(isUniqueViolation(error), true, 'a double click must not queue two invites')

  // Once the first is answered the person may be invited again: the index is partial.
  db.prepare("UPDATE invites SET status = 'declined' WHERE id = 'inv_1'").run()
  insert.run('inv_3', at(), at())
  assert.equal(db.prepare('SELECT count(*) AS c FROM invites').get().c, 2)
})

test('a read cursor is one per person per group', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  const insert = db.prepare('INSERT INTO read_cursors (workgroup_id, user_id, last_read_seq, updated_at) VALUES (?, ?, ?, ?)')
  insert.run('wg_1', 'usr_1', 3, at())
  assert.equal(catchError(() => insert.run('wg_1', 'usr_1', 5, at())) !== undefined, true)
})

test('an attachment stores a storage key, and has no column for a local path', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  const columns = db.prepare('PRAGMA table_info(attachments)').all().map(row => row.name)
  // The gate's promise is "no absolute local path ever reaches the Hub". The strongest form of
  // that promise is a schema with nowhere to put one.
  for (const forbidden of ['path', 'local_path', 'file_path', 'absolute_path', 'cwd', 'work_dir']) {
    assert.equal(columns.includes(forbidden), false, `attachments must not have a ${forbidden} column`)
  }
  assert.ok(columns.includes('storage_key'))
  assert.ok(columns.includes('sha256'))
  assert.ok(columns.includes('expires_at'))
})
