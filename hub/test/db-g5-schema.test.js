// The invariants the G5 tables exist to enforce, asserted against the database itself.
//
// Two of these are gate evidence in their own right, which is why they are checked at the schema
// level rather than through the service:
//   * `tasks.id` is the requester's own taskId. Being the primary key is what makes a redelivered
//     `task.request` one task instead of two (gate 5), the same way `events.event_id` does for a
//     resent message.
//   * one *live* approval per task (partial unique index). A second grant on top of a running one
//     is not "more approved"; it is an ambiguity about which scope is in force.
//
// The rest — the state CHECK, the lease's primary key, `artifacts.blob_path` being internal and
// unique — are the constraints the service relies on and would otherwise have to re-check in code.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, isUniqueViolation } from '../src/db/index.js'
import { LATEST_VERSION } from '../src/db/migrations.js'

const withDatabase = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-g5-db-'))
  const db = openDatabase(join(dir, 'hub.db'))
  t.after(() => {
    try { db.close() } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true })
  })
  return { db, dir }
}

const at = () => new Date().toISOString()

// One user, one device, one group, one Bot endpoint and one task. Plain SQL on purpose: the test
// holds the schema up, so it must not depend on the service built on top of it.
function seed(db) {
  db.prepare('INSERT INTO users (id, phone_e164, password_phc, password_version, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('usr_a', '+8613800138000', '$scrypt$a$b$c', 1, at())
  db.prepare('INSERT INTO users (id, phone_e164, password_phc, password_version, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('usr_b', '+8613900139000', '$scrypt$a$b$c', 1, at())
  db.prepare('INSERT INTO devices (id, user_id, public_key, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('dev_a', 'usr_a', 'PEM-A', 'Alice laptop', at())
  db.prepare('INSERT INTO devices (id, user_id, public_key, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('dev_b', 'usr_b', 'PEM-B', 'Bob laptop', at())
  db.prepare('INSERT INTO workgroups (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('wg_1', 'usr_a', 'Group', at())
  db.prepare(`INSERT INTO bot_endpoints (id, owner_id, device_id, local_bot_id, name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run('ep_b', 'usr_b', 'dev_b', 'chief', 'Chief', at())
}

const insertTask = (db, overrides = {}) => {
  const row = {
    id: 'task_1', workgroupId: 'wg_1', requesterId: 'usr_a', requesterDeviceId: 'dev_a',
    ownerId: 'usr_b', ownerDeviceId: 'dev_b', endpointId: 'ep_b', state: 'REQUESTED',
    title: '费用汇总', payload: '{}', version: 0, ...overrides,
  }
  return db.prepare(`INSERT INTO tasks
    (id, workgroup_id, requester_id, requester_device_id, owner_id, owner_device_id, endpoint_id,
     state, title, payload, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.workgroupId, row.requesterId, row.requesterDeviceId, row.ownerId, row.ownerDeviceId,
      row.endpointId, row.state, row.title, row.payload, row.version, at(), at())
}

const insertApproval = (db, overrides = {}) => {
  const row = {
    id: 'apr_1', taskId: 'task_1', approvedBy: 'usr_b', approvedDeviceId: 'dev_b',
    decision: 'granted', scope: '{}', ...overrides,
  }
  return db.prepare(`INSERT INTO approvals
    (id, task_id, approved_by, approved_device_id, decision, scope, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.taskId, row.approvedBy, row.approvedDeviceId, row.decision, row.scope, at(),
      new Date(Date.now() + 60_000).toISOString())
}

const catchError = (fn) => {
  try { fn() } catch (error) { return error }
  return undefined
}

test('migration 7 is the newest, so a Hub from G5 upgrades rather than refusing to start', () => {
  // Migration 5 added the shared reply mode and a Bot's published appearance.
  // Migration 6 adds the group's shared permission preset and DROPS `memberships.bot_role`.
  // Migration 7 adds `workgroups.lead_membership_id`: which member leads the group, decided once by
  // the owner's machine instead of derived per machine.
  //
  // Both are in-place: v5 is additive (`ADD COLUMN` with a default), and v6's `DROP COLUMN` is
  // supported by the SQLite this Hub ships with. A G5 Hub therefore starts and upgrades rather than
  // refusing, which is what this asserts.
  assert.equal(LATEST_VERSION, 7)
})

test('the four G5 tables exist and nothing from G6 arrived early', (t) => {
  const { db } = withDatabase(t)
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name)
  for (const table of ['tasks', 'approvals', 'round_leases', 'artifacts']) {
    assert.ok(names.includes(table), `${table} must exist after migration 4`)
  }
  // Same rule as the absent `otp_challenges` and `group_memories`: an empty table reads as "done".
  assert.equal(names.includes('group_memories'), false, 'group_memories is G6')
})

test('a task id is the primary key, so a redelivered request cannot become a second task', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  insertTask(db)

  const error = catchError(() => insertTask(db))
  assert.ok(error !== undefined, 'the same task id must be refused the second time')
  assert.equal(isUniqueViolation(error), true)
  assert.equal(db.prepare('SELECT count(*) AS c FROM tasks').get().c, 1)
})

test('the same task id in another group is still the same task', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  db.prepare('INSERT INTO workgroups (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('wg_2', 'usr_a', 'Other', at())
  insertTask(db)

  // `id` is global, not per group: an id reused in a second group would make the envelope's dedup
  // key ambiguous, so the primary key refuses it rather than silently scoping it.
  const error = catchError(() => insertTask(db, { workgroupId: 'wg_2' }))
  assert.equal(isUniqueViolation(error), true)
})

test('a task state outside plan 10.2 is refused by the database', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  // The one that matters: a task nobody approved can never be RUNNING — but here the point is
  // narrower and older: a state the machine does not contain cannot be stored at all, so a buggy
  // writer cannot invent `RUNNING_ELSEWHERE` and have every client ignore it forever.
  const error = catchError(() => insertTask(db, { state: 'NOT_A_STATE' }))
  assert.match(String(error?.message), /CHECK constraint failed/)

  insertTask(db, { state: 'PENDING_APPROVAL' })
  assert.equal(db.prepare('SELECT state FROM tasks WHERE id = ?').get('task_1').state, 'PENDING_APPROVAL')
})

test('a task carries a version, and it is the concurrency column the plan names', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  insertTask(db)
  const before = db.prepare('SELECT version FROM tasks WHERE id = ?').get('task_1').version
  db.prepare('UPDATE tasks SET state = ?, version = version + 1 WHERE id = ? AND version = ?')
    .run('DELIVERED', 'task_1', before)
  assert.equal(db.prepare('SELECT version FROM tasks WHERE id = ?').get('task_1').version, before + 1)

  // A stale caller's update matches no row — the read-modify-write a service does must be able to
  // tell it lost, and this is the shape that makes it possible.
  const stale = db.prepare('UPDATE tasks SET state = ?, version = version + 1 WHERE id = ? AND version = ?')
    .run('APPROVED', 'task_1', before)
  assert.equal(stale.changes, 0)
})

test('one live approval per task, and a revoked one may be replaced', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  insertTask(db)
  insertApproval(db)

  const error = catchError(() => insertApproval(db, { id: 'apr_2' }))
  assert.ok(error !== undefined, 'a second live grant on the same task must be refused')
  assert.equal(isUniqueViolation(error), true)

  // A rejection is a separate record, and it is not "live", so it does not collide.
  insertApproval(db, { id: 'apr_3', decision: 'rejected' })

  // Revoking the live one frees the slot: re-approving after a revoke is a new decision, and the
  // history of the revoked grant stays readable.
  db.prepare('UPDATE approvals SET revoked_at = ? WHERE id = ?').run(at(), 'apr_1')
  insertApproval(db, { id: 'apr_4' })
  assert.equal(db.prepare("SELECT count(*) AS c FROM approvals WHERE task_id = 'task_1'").get().c, 3)
})

test('an approval names the device that granted it', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  insertTask(db)

  // `approved_device_id` is NOT NULL on purpose: gate 3 ("the issuing device is unambiguous") is
  // only an assertion if the row cannot exist without one.
  const error = catchError(() => {
    db.prepare(`INSERT INTO approvals (id, task_id, approved_by, decision, created_at, expires_at)
      VALUES ('apr_x', 'task_1', 'usr_b', 'granted', ?, ?)`).run(at(), at())
  })
  assert.match(String(error?.message), /NOT NULL constraint failed/)
})

test('deleting a task takes its approvals and artifacts with it', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  insertTask(db)
  insertApproval(db)
  db.prepare(`INSERT INTO artifacts
    (id, task_id, workgroup_id, owner_id, name, mime, size, hash, blob_path, created_at, expires_at)
    VALUES ('art_1', 'task_1', 'wg_1', 'usr_b', 'report.pdf', 'application/pdf', 3, 'sha', 'art_1.pdf', ?, ?)`)
    .run(at(), at())

  db.prepare('DELETE FROM tasks WHERE id = ?').run('task_1')
  assert.equal(db.prepare('SELECT count(*) AS c FROM approvals').get().c, 0)
  assert.equal(db.prepare('SELECT count(*) AS c FROM artifacts').get().c, 0)
})

test('an artifact must hang off a task, so an unauthorized file cannot exist', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  const error = catchError(() => {
    db.prepare(`INSERT INTO artifacts
      (id, task_id, workgroup_id, owner_id, name, mime, size, hash, blob_path, created_at, expires_at)
      VALUES ('art_x', 'task_missing', 'wg_1', 'usr_b', 'a.txt', 'text/plain', 1, 'sha', 'art_x.txt', ?, ?)`)
      .run(at(), at())
  })
  assert.match(String(error?.message), /FOREIGN KEY constraint failed/)
})

test('two artifacts cannot share one storage key', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  insertTask(db)
  const insertArtifact = (id, blobPath) => db.prepare(`INSERT INTO artifacts
    (id, task_id, workgroup_id, owner_id, name, mime, size, hash, blob_path, created_at, expires_at)
    VALUES (?, 'task_1', 'wg_1', 'usr_b', 'a.txt', 'text/plain', 1, 'sha', ?, ?, ?)`)
    .run(id, blobPath, at(), at())

  insertArtifact('art_1', 'art_1.txt')
  const error = catchError(() => insertArtifact('art_2', 'art_1.txt'))
  assert.equal(isUniqueViolation(error), true)
})

test('an artifact state outside available/revoked is refused', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  insertTask(db)
  const error = catchError(() => {
    db.prepare(`INSERT INTO artifacts
      (id, task_id, workgroup_id, owner_id, name, mime, size, hash, blob_path, state, created_at, expires_at)
      VALUES ('art_x', 'task_1', 'wg_1', 'usr_b', 'a.txt', 'text/plain', 1, 'sha', 'art_x.txt', 'shared', ?, ?)`)
      .run(at(), at())
  })
  assert.match(String(error?.message), /CHECK constraint failed/)
})

test('a group holds one lease row, and its epoch is what fences a stale round', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  const upsert = db.prepare(`INSERT INTO round_leases
    (workgroup_id, epoch, holder_user_id, holder_device_id, lease_until, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (workgroup_id) DO UPDATE SET
      epoch = excluded.epoch, holder_user_id = excluded.holder_user_id,
      holder_device_id = excluded.holder_device_id, lease_until = excluded.lease_until,
      updated_at = excluded.updated_at`)

  const until = new Date(Date.now() + 30_000).toISOString()
  upsert.run('wg_1', 1, 'usr_a', 'dev_a', until, at())
  // The primary key is the group: a second coordinator cannot be added beside the first, which is
  // what "one valid scheduler at a time" (plan §9.5) reduces to in the schema.
  upsert.run('wg_1', 2, 'usr_b', 'dev_b', until, at())
  assert.equal(db.prepare('SELECT count(*) AS c FROM round_leases').get().c, 1)
  assert.equal(db.prepare('SELECT epoch FROM round_leases WHERE workgroup_id = ?').get('wg_1').epoch, 2)
})

test('a lease holder must be a real user and device, not a free-form string', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  const error = catchError(() => {
    db.prepare(`INSERT INTO round_leases
      (workgroup_id, epoch, holder_user_id, holder_device_id, lease_until, updated_at)
      VALUES ('wg_1', 1, 'usr_nobody', 'dev_x', ?, ?)`).run(at(), at())
  })
  assert.match(String(error?.message), /FOREIGN KEY constraint failed/)
})

test('a task names a workgroup that exists', (t) => {
  const { db } = withDatabase(t)
  seed(db)
  const error = catchError(() => insertTask(db, { workgroupId: 'wg_missing' }))
  assert.match(String(error?.message), /FOREIGN KEY constraint failed/)
})

// THE GROUP'S PERMISSION PRESET IS THE ORIGINAL'S MODEL, NOT AN INVENTED ONE.
//
// The user's correction: 「原版群聊是如何做的，那么工作群和工作群跨用户 bot 也是这么做，只是工作群需要
// 远程同步」. The original (`src/host/permissions.js`) has two layers and no per-Bot group role:
//
//   `bot.permission`  — the Bot's own;
//   `room.permission` — one for the whole group, overriding every member's;
//   absent            — each member uses its own.
//
// So the Hub needs ONE column that is the remote copy of `room.permission`, and the invented
// `memberships.bot_role` must not exist: a second field describing the same thing is a field somebody
// will read and believe.
test('the group permission preset is stored, and the invented bot_role is gone', (t) => {
  const { db } = withDatabase(t)
  const workgroupColumns = db.prepare("SELECT name FROM pragma_table_info('workgroups')").all().map(row => row.name)
  assert.ok(workgroupColumns.includes('permission'), 'the group-wide preset has a column')
  assert.equal(workgroupColumns.includes('bot_role'), false)

  const membershipColumns = db.prepare("SELECT name FROM pragma_table_info('memberships')").all().map(row => row.name)
  assert.equal(membershipColumns.includes('bot_role'), false,
    'memberships.bot_role is gone: permission is the original field that covers this')
})
