// G6's storage contract, asserted against SQLite itself rather than against the service that will
// use it. The Hub is the only authority for group memory, so the schema must make the important
// promises real: a group's deletion takes its entries and audit rows with it, and a soft-deleted
// entry leaves the full-text index while its audit row remains.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db/index.js'

const withDatabase = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-g6-db-'))
  const db = openDatabase(join(dir, 'hub.db'))
  t.after(() => {
    try { db.close() } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true })
  })
  return { db, dir }
}

const seedGroup = (db) => {
  db.prepare('INSERT INTO users (id, phone_e164, password_phc, password_version, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('u1', '+8613800138000', 'x', 1, 't')
  db.prepare("INSERT INTO workgroups (id, owner_user_id, name, config_version, last_seq, created_at) VALUES ('wg1','u1','G',1,0,'t')").run()
}

test('migration v8 creates the group memory tables, triggers and FTS index', (t) => {
  const { db } = withDatabase(t)
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all().map(row => row.name)
  for (const name of [
    'group_memories', 'group_memory_events', 'group_memories_fts',
    'group_memories_ai', 'group_memories_au', 'group_memories_ad',
  ]) {
    assert.ok(names.includes(name), `${name} must exist`)
  }

  const columns = db.prepare('PRAGMA table_info(group_memories)').all().map(row => row.name)
  for (const column of [
    'id', 'workgroup_id', 'type', 'content', 'source_refs', 'acl', 'version',
    'created_by', 'created_at', 'updated_at', 'expires_at', 'deleted_at',
  ]) {
    assert.ok(columns.includes(column), `group_memories.${column} must exist`)
  }
  const eventColumns = db.prepare('PRAGMA table_info(group_memory_events)').all().map(row => row.name)
  for (const column of ['id', 'memory_id', 'workgroup_id', 'action', 'version', 'before', 'after', 'actor_id', 'at']) {
    assert.ok(eventColumns.includes(column), `group_memory_events.${column} must exist`)
  }
})

test('the FTS index follows inserts, corrections and soft deletes', (t) => {
  const { db } = withDatabase(t)
  seedGroup(db)
  const insert = db.prepare(`INSERT INTO group_memories
    (id, workgroup_id, type, content, source_refs, acl, created_by, created_at, updated_at)
    VALUES (?, 'wg1', 'fact', ?, '[]', '["u1"]', 'u1', 't', 't')`)
  insert.run('m1', 'Deploy uses the blue green switch')
  assert.equal(db.prepare('SELECT count(*) AS c FROM group_memories_fts WHERE group_memories_fts MATCH ?').get('blue green').c, 1)

  db.prepare("UPDATE group_memories SET content = 'Deploy uses a canary switch', updated_at = 't2' WHERE id = 'm1'").run()
  assert.equal(db.prepare('SELECT count(*) AS c FROM group_memories_fts WHERE group_memories_fts MATCH ?').get('blue green').c, 0)
  assert.equal(db.prepare('SELECT count(*) AS c FROM group_memories_fts WHERE group_memories_fts MATCH ?').get('canary').c, 1)

  db.prepare("UPDATE group_memories SET deleted_at = 't3' WHERE id = 'm1'").run()
  assert.equal(db.prepare('SELECT count(*) AS c FROM group_memories_fts WHERE group_memories_fts MATCH ?').get('canary').c, 0)
})

test('deleting a workgroup removes its memory rows and audit rows', (t) => {
  const { db } = withDatabase(t)
  seedGroup(db)
  db.prepare(`INSERT INTO group_memories
    (id, workgroup_id, type, content, source_refs, acl, created_by, created_at, updated_at)
    VALUES ('m1','wg1','fact','A fact','[]','["u1"]','u1','t','t')`).run()
  db.prepare(`INSERT INTO group_memory_events
    (id, memory_id, workgroup_id, action, version, before, after, actor_id, at)
    VALUES ('me1','m1','wg1','created',1,NULL,'{}','u1','t')`).run()

  db.prepare("DELETE FROM workgroups WHERE id = 'wg1'").run()
  assert.equal(db.prepare("SELECT count(*) AS c FROM group_memories WHERE workgroup_id = 'wg1'").get().c, 0)
  assert.equal(db.prepare("SELECT count(*) AS c FROM group_memory_events WHERE workgroup_id = 'wg1'").get().c, 0)
  assert.equal(db.prepare('SELECT count(*) AS c FROM group_memories_fts WHERE group_memories_fts MATCH ?').get('fact').c, 0)
})
