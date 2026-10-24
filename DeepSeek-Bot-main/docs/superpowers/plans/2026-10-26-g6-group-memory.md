# G6 Group Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship V1 group memory: Hub-authoritative `group_memories` with ACL, versioning, correction and
deletion; one Bot per group can search it from inside that group only; the existing local memory panel
reads and edits it; membership loss and group deletion remove access immediately; and the G6 gates
(restart/replay safety, isolation from private memory, T18) have automated evidence.

**Architecture:** The Hub stays the only authoritative store for shared group knowledge. A new
migration v8 adds `group_memories` (entries) and `group_memory_events` (audit trail of every created /
corrected / deleted version). Entries carry `workgroupId`, `type`, `content`, `sourceRefs`, `acl`,
`version`, `createdBy`, `expiresAt`, `deletedAt`. The plugin keeps its existing local Markdown memory
as a *projection cache* for prompt freezing; it never becomes the authority once a room is a
workgroup. Reads go through `POST /api/workgroup` (`memory-list`, `memory-search`) and writes through
`memory-propose` / `memory-correct` / `memory-delete`, all of which call the Hub. The four
`memory.*` event types join `EVENT_TYPES`, so a change fans out on the existing WSS seq stream and
every machine re-reads rather than merging client-side state. Search is SQLite FTS5 with an ACL join,
never a client-side filter.

**Tech Stack:** Node.js ESM, `node:test`, `node:sqlite` (`DatabaseSync`, FTS5 confirmed available),
`ws`, React sources compiled by `scripts/build-client.mjs`.

## Global Constraints

- Do not modify `ds-bot/src/host/{groups,turns,delivery,resume,constants}.js`; the G4/G1 isolation
  rule requires them byte-identical. If a change is unavoidable, stop and write "Plan deviation" — the
  correct fix is to copy the needed fragment into `src/workgroup/host/`.
- `ds-bot/src/host/feed.js` already has the one approved host change (`workgroupStateSaved`). Any new
  `src/host/` change is a scope violation and needs the maintainer.
- Do not patch DSH or depend on files inside a DSH install. The DSH credentials provider
  (`@deepseek-ai/dsh-credentials-local`) documents that an OS-keychain provider is **deferred**; do not
  claim keychain storage in G6. See Task 9.
- One workgroup domain install per runtime; a second install must throw.
- A workgroup remains a copied original group chat, not a new agent framework. No role router, no
  model-based speaker selection replacing `@Name`.
- Hub is authoritative for membership, settings, the message log **and now group memory**. Local state
  is a projection.
- Tests use temp dirs only; never `~/.dsh` or the user's DSH data.
- Every user-facing plugin string is English. No AI-authored commit attribution.
- Do not claim a G6 gate PASS from a source-level assertion alone; a product-path assertion must
  exercise `apiHandle` or the real socket.
- Manual-only gate items stay BLOCKED until the maintainer supplies evidence.
- Do not modify `Workgroup-AI`; it is a frozen source, not this implementation.

---

## Scope audit (from the review on `main` @ e71119b)

| ID | Gap | Why it blocks T18 | Current evidence |
|---|---|---|---|
| M1 | `group_memories` does not exist; migration v7 is latest | No shared store at all | `hub/test/db-migrate.test.js` asserts it is absent |
| M2 | `EVENT_TYPES` has 18 types and none of the four `memory.*` | A memory change cannot fan out; adding a type without this set is refused | `hub/src/workgroups/service.js:34-56` |
| M3 | Workgroup memory is a local Markdown folder only (`bot/memory/groups/<roomId>`) | Nothing crosses machines; no ACL, version or source refs | `ds-bot/src/host/memory.js:462-464, 705-720` |
| M4 | The memory review never fires for workgroup member Sessions | Group memory only grows from an explicit `remember` | `memory.js:1476` filters on `rt.isBotSession`, which is false for workgroup Sessions |
| M5 | `deleteWorkgroup` does not call `archiveGroupMemory` | A deleted group's local memory survives and can be re-adopted | `groups.js:1229-1282` vs `src/host/roster.js:484` |
| M6 | The local memory panel resolves a workgroup by id but has no Hub path | Panel can show the local files of one machine only | `memory.js:1078-1087`, `ownership.js:71-81` |
| M7 | No ACL enforcement on memory reads | T18's core negative case is untestable | no memory routes exist |
| M8 | Docs are stale: `README.md` says the water level is G3; several docs quote historical test counts as current; `progress-and-gaps.md` still says the panel polls every 1.2 s; `HANDOFF-NEXT-SESSION.md` says the work is uncommitted | A G6 reader cannot tell current truth from history | review of `docs/workgroup/**` on 2026-10-26 |
| M9 | OS keychain not available in DSH 0.2.1-rc.2 | Known accepted gap, not a G6 deliverable | `dsh-credentials-local/README.md` "Known Limitations" |

Out of scope for G6: mobile apps, OTP, P2P, multi-Hub federation, WeChat/WeClaw, a release/version
bump, and any change to the original group semantics.

---

## File structure

| File | Responsibility |
|---|---|
| `hub/src/db/migrations.js` | migration v8: `group_memories`, `group_memories_fts`, `group_memory_events` |
| `hub/src/memories/service.js` (new) | create / correct / delete / list / search, ACL and versioning, event emission |
| `hub/src/server.js` | five memory routes, all behind `workgroups.isMember` |
| `hub/src/workgroups/service.js` | add the four `memory.*` types to `EVENT_TYPES` |
| `hub/src/server.js` (`createHub`) | construct the memory service beside the task/event services |
| `hub/test/db-g6-schema.test.js` (new) | table, index and FTS5 shape; cascade on group delete |
| `hub/test/group-memory.test.js` (new) | ACL matrix, version conflicts, correction/deletion, search relevance |
| `hub/test/db-migrate.test.js` | move the "group_memories must not exist" assertion to "must exist" |
| `ds-bot/src/workgroup/host/memories.js` (new) | plugin bridge: read/write Hub memory, project into local cache, expose `wg.memory*` |
| `ds-bot/src/workgroup/host/groups.js` | archive group memory on delete; skip writes for a non-member |
| `ds-bot/src/workgroup/host/channel.js` | `memory-*` endpoints (read-only ones in `READS`) |
| `ds-bot/src/workgroup/host/bridge.js` | forward `memory.*` events to `wg.onMemoryEvent` |
| `ds-bot/src/workgroup/host/ownership.js` | expose `roomIdOf(sessionId)` for the memory review |
| `ds-bot/src/workgroup/client/group-settings.js` | memory section: list, search, add, correct, delete |
| `ds-bot/src/workgroup/client/panel.js` | re-read memory on `memory.*` feed events |
| `ds-bot/test-realtime/workgroup-memory.test.js` (new) | two runtimes, real Hub, ACL and live propagation |
| `ds-bot/test/workgroup-memory.test.js` (new) | local projection, deletion archival, no private-memory leak |
| `ds-bot/test/workgroup-round.test.js` | keep and extend the "memory panel opens" test |
| `docs/workgroup/g6/*` | evidence matrix, round log, design note |
| `docs/workgroup/{gates,progress-and-gaps,manual-checklist}.md` | G6 sections |
| `docs/workgroup/README.md` | fix the stale water level and index |

---

## Task 1: Add the memory tables and FTS index

**Files:**
- Modify: `hub/src/db/migrations.js` (append migration v8 after v7)
- Modify: `hub/test/db-migrate.test.js:84-97`
- Create: `hub/test/db-g6-schema.test.js`

**Interfaces:**
- Produces tables `group_memories`, `group_memory_events`, virtual table `group_memories_fts`.
- `group_memories` columns: `id TEXT PRIMARY KEY`, `workgroup_id TEXT NOT NULL REFERENCES workgroups(id)
  ON DELETE CASCADE`, `type TEXT NOT NULL CHECK (type IN ('canon','decision','faq','fact','artifact'))`,
  `content TEXT NOT NULL`, `source_refs TEXT NOT NULL`, `acl TEXT NOT NULL`, `version INTEGER NOT NULL
  DEFAULT 1`, `created_by TEXT NOT NULL`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`,
  `expires_at TEXT`, `deleted_at TEXT`.
- `group_memory_events` columns: `id`, `memory_id`, `workgroup_id`, `action CHECK (action IN
  ('created','corrected','deleted'))`, `version`, `before TEXT`, `after TEXT`, `actor_id`, `at`.
- `group_memories_fts` is `fts5(content, source_refs, content='group_memories',
  content_rowid='rowid', tokenize='trigram')` plus three triggers keeping it in sync, including soft
  deletes.

- [ ] **Step 1: Write the failing schema test**

```js
// hub/test/db-g6-schema.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db/index.js'

// The same helper shape as `db-g4-schema.test.js`: a real file database in a temp dir, removed on
// teardown. `:memory:` cannot exercise WAL, and the FTS5 external-content table needs a real rowid.
const withDatabase = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-g6-db-'))
  const db = openDatabase(join(dir, 'hub.db'))
  t.after(() => {
    try { db.close() } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true })
  })
  return { db, dir }
}

test('migration v8 creates the group memory tables and their FTS index', (t) => {
  const { db } = withDatabase(t)
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all().map(row => row.name)
  for (const name of ['group_memories', 'group_memory_events', 'group_memories_fts']) {
    assert.ok(names.includes(name), `${name} must exist`)
  }
  const columns = db.prepare('PRAGMA table_info(group_memories)').all().map(row => row.name)
  for (const column of ['id', 'workgroup_id', 'type', 'content', 'source_refs', 'acl', 'version',
    'created_by', 'created_at', 'updated_at', 'expires_at', 'deleted_at']) {
    assert.ok(columns.includes(column), `group_memories.${column} must exist`)
  }
})

test('deleting a workgroup removes its memory rows', (t) => {
  const { db } = withDatabase(t)
  db.prepare('INSERT INTO users (id, phone_e164, password_phc, password_version, created_at) VALUES (?, ?, ?, ?, ?)').run('u1', '+8613800138000', 'x', 1, 't')
  db.prepare("INSERT INTO workgroups (id, owner_user_id, name, config_version, last_seq, created_at) VALUES ('wg1','u1','G',1,0,'t')").run()
  db.prepare(`INSERT INTO group_memories (id, workgroup_id, type, content, source_refs, acl, created_by, created_at, updated_at)
    VALUES ('m1','wg1','fact','A fact','[]','[]','u1','t','t')`).run()
  db.prepare("DELETE FROM workgroups WHERE id = 'wg1'").run()
  assert.equal(db.prepare("SELECT count(*) AS c FROM group_memories WHERE workgroup_id = 'wg1'").get().c, 0)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd hub && node --test test/db-g6-schema.test.js`
Expected: FAIL — `group_memories` does not exist and the INSERT fails.

- [ ] **Step 3: Append migration v8**

```js
  {
    // G6: the shared memory of a workgroup. It is the Hub's, not a machine's: two colleagues must
    // read the same approved knowledge, and a member who left must stop reading it on the next call.
    // `acl` is a JSON array of user ids, checked on every read; `version` is the compare-and-apply
    // token for corrections. A soft delete keeps the audit trail without keeping the content
    // readable, which is why the FTS triggers below also remove deleted rows from the index.
    version: 8,
    statements: [
      `CREATE TABLE group_memories (
        id           TEXT PRIMARY KEY,
        workgroup_id TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
        type         TEXT NOT NULL CHECK (type IN ('canon','decision','faq','fact','artifact')),
        content      TEXT NOT NULL,
        source_refs  TEXT NOT NULL,
        acl          TEXT NOT NULL,
        version      INTEGER NOT NULL DEFAULT 1,
        created_by   TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        expires_at   TEXT,
        deleted_at   TEXT
      )`,
      'CREATE INDEX group_memories_group ON group_memories(workgroup_id, deleted_at)',
      `CREATE TABLE group_memory_events (
        id         TEXT PRIMARY KEY,
        memory_id  TEXT NOT NULL,
        workgroup_id TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
        action     TEXT NOT NULL CHECK (action IN ('created','corrected','deleted')),
        version    INTEGER NOT NULL,
        before     TEXT,
        after      TEXT,
        actor_id   TEXT NOT NULL,
        at         TEXT NOT NULL
      )`,
      'CREATE INDEX group_memory_events_memory ON group_memory_events(memory_id, at)',
      `CREATE VIRTUAL TABLE group_memories_fts USING fts5(
        content, source_refs, content='group_memories', content_rowid='rowid', tokenize='trigram'
      )`,
      `CREATE TRIGGER group_memories_ai AFTER INSERT ON group_memories BEGIN
        INSERT INTO group_memories_fts(rowid, content, source_refs)
        SELECT rowid, new.content, new.source_refs FROM group_memories
        WHERE rowid = new.rowid AND new.deleted_at IS NULL;
      END`,
      `CREATE TRIGGER group_memories_au AFTER UPDATE ON group_memories BEGIN
        INSERT INTO group_memories_fts(group_memories_fts, rowid, content, source_refs)
        SELECT 'delete', old.rowid, old.content, old.source_refs WHERE old.deleted_at IS NULL;
        INSERT INTO group_memories_fts(rowid, content, source_refs)
        SELECT new.rowid, new.content, new.source_refs WHERE new.deleted_at IS NULL;
      END`,
      `CREATE TRIGGER group_memories_ad AFTER DELETE ON group_memories BEGIN
        INSERT INTO group_memories_fts(group_memories_fts, rowid, content, source_refs)
        SELECT 'delete', old.rowid, old.content, old.source_refs WHERE old.deleted_at IS NULL;
      END`,
    ],
  },
```

Update `hub/test/db-migrate.test.js`: remove `group_memories` from the "must not exist" assertion and
add it to the list of tables that must exist, with a comment that G6 landed.

- [ ] **Step 4: Run the schema tests**

Run: `cd hub && node --test test/db-g6-schema.test.js test/db-migrate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/db/migrations.js hub/test/db-g6-schema.test.js hub/test/db-migrate.test.js
git commit -m "feat(hub): add the group memory tables and full-text index"
```

---

## Task 2: Memory service with ACL and compare-and-apply

**Files:**
- Create: `hub/src/memories/service.js`
- Create: `hub/test/group-memory.test.js`
- Modify: `hub/src/server.js` (construct the service in `createHub`, next to `createTaskService`)

**Interfaces:**
- `createMemoryService({ db, audit, now, events })` returns:
  - `create({ userId, workgroupId, type, content, sourceRefs, acl, expiresAt })` →
    `{ memory, event }`; throws `workgroup/not-found` if the caller is not an active member.
  - `correct({ userId, workgroupId, memoryId, content, sourceRefs, acl, expectedVersion })` →
    `{ memory, event }`; throws `memory/version-conflict` when `expectedVersion !== row.version`.
  - `remove({ userId, workgroupId, memoryId, expectedVersion })` → `{ memory, event }` (soft delete).
  - `list({ userId, workgroupId })` → `{ memories }`, only rows whose `acl` includes `userId`.
  - `search({ userId, workgroupId, query, limit })` → `{ memories }`, FTS5 + the same ACL filter.
- Every method first checks `membershipOf(workgroupId, userId)`; a non-member gets
  `workgroup/not-found` (the same answer as a missing group, so ids cannot be probed).
- `acl` always includes the creator; requested ids must be active members of the group.
- A deleted entry is invisible to `list` and `search`, but its `group_memory_events` row remains.

- [ ] **Step 1: Write the failing ACL and version tests**

```js
// Top of `hub/test/group-memory.test.js`: the same public HTTP surface `task-approval.test.js` uses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { startHub, PHONE_A, PHONE_B, PASSWORD } from './helpers.js'
import { person, groupWith } from './g4-helpers.js'

// Shared scene helpers for `group-memory.test.js`. They use the same public HTTP surface as
// `hub/test/task-approval.test.js`: register two accounts, create a group, invite the other, accept.
const memoryScene = async (t) => {
  const hub = await startHub()
  t.after(async () => { await hub.close() })
  const alice = await person(hub, { phone: PHONE_A, name: 'Alice' })
  const bob = await person(hub, { phone: PHONE_B, name: 'Bob' })
  const carol = await person(hub, { phone: '+8613700137000', name: 'Carol' })
  const { workgroupId } = await groupWith(hub, { owner: alice, others: [bob] })
  return { hub, alice, bob, carol, workgroupId }
}

const createdMemory = async (t, overrides = {}) => {
  const scene = await memoryScene(t)
  const created = await scene.hub.post(`/v1/workgroups/${scene.workgroupId}/memories`, {
    type: overrides.type ?? 'fact',
    content: overrides.content ?? 'The budget closes on the 25th.',
    sourceRefs: overrides.sourceRefs ?? [],
    acl: overrides.acl ?? [],
  }, { token: scene.alice.token })
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`)
  return { ...scene, memoryId: created.body.memory.memoryId }
}

const createdMemorySharedWithBob = async (t) => {
  const scene = await memoryScene(t)
  const bobMembership = await membershipOf(scene.hub, scene.bob, scene.workgroupId)
  const created = await scene.hub.post(`/v1/workgroups/${scene.workgroupId}/memories`, {
    type: 'fact',
    content: 'The budget closes on the 25th.',
    sourceRefs: [],
    acl: [scene.bob.userId],
  }, { token: scene.alice.token })
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`)
  return { ...scene, memoryId: created.body.memory.memoryId, bobMembershipId: bobMembership.membershipId }
}

const membershipOf = async (hub, person, workgroupId) => {
  const answer = await hub.get(`/v1/workgroups/${workgroupId}`, { token: person.token })
  return (answer.body.members ?? []).find(member => member.userId === person.userId)
}

test('a non-member cannot read a group memory, and a member cannot read another group\'s', async (t) => {
  const { hub, alice, bob, carol, workgroupId } = await memoryScene(t)
  const created = await hub.post(`/v1/workgroups/${workgroupId}/memories`, {
    type: 'fact', content: 'The budget closes on the 25th.', sourceRefs: [], acl: [],
  }, { token: alice.token })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const memoryId = created.body.memory.memoryId

  const mine = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: bob.token })
  assert.equal(mine.status, 200)
  assert.equal(mine.body.memories.some(entry => entry.memoryId === memoryId), true)

  const outsider = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: carol.token })
  assert.equal(outsider.status, 404)
  assert.equal(outsider.body.error.code, 'workgroup/not-found')
})

test('a correction based on an old version is refused and changes nothing', async (t) => {
  const { hub, alice, workgroupId, memoryId } = await createdMemory(t)
  const first = await hub.post(`/v1/workgroups/${workgroupId}/memories/${memoryId}/correct`, {
    content: 'The budget closes on the 26th.', expectedVersion: 1,
  }, { token: alice.token })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.memory.version, 2)

  const stale = await hub.post(`/v1/workgroups/${workgroupId}/memories/${memoryId}/correct`, {
    content: 'old overwrite', expectedVersion: 1,
  }, { token: alice.token })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.code, 'memory/version-conflict')

  const listed = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: alice.token })
  assert.equal(listed.body.memories.find(entry => entry.memoryId === memoryId).content,
    'The budget closes on the 26th.')
})

test('a deleted memory disappears from search but its audit row remains', async (t) => {
  const { hub, alice, workgroupId, memoryId } = await createdMemory(t, {
    content: 'Deploy uses the blue green switch', type: 'decision',
  })
  const gone = await hub.post(`/v1/workgroups/${workgroupId}/memories/${memoryId}/delete`, {
    expectedVersion: 1,
  }, { token: alice.token })
  assert.equal(gone.status, 200, JSON.stringify(gone.body))
  const found = await hub.get(`/v1/workgroups/${workgroupId}/memories/search?q=blue%20green`, { token: alice.token })
  assert.deepEqual(found.body.memories, [])
  const db = hub.hub.db
  assert.equal(db.prepare('SELECT count(*) AS c FROM group_memory_events WHERE memory_id = ?').get(memoryId).c >= 1, true)
})
```

- [ ] **Step 2: Run and watch fail**

Run: `cd hub && node --test test/group-memory.test.js`
Expected: FAIL — routes and service do not exist (404 or module-not-found).

- [ ] **Step 3: Implement the service**

Implementation rules, all in `hub/src/memories/service.js`:
- validate `type` against the same five values as the schema;
- `content` trimmed, 1..4000 characters; reject a line that looks like a credential
  (`/(?:api[_-]?key|password|secret|token)\s*[:=]/i`) with `memory/credential-like`;
- `sourceRefs` is an array of `{ kind: 'message'|'task'|'artifact'|'manual', id }`; `kind: 'message'`
  ids must exist in `events` for the same `workgroupId`, otherwise `memory/source-not-in-group`;
- `acl` is an array of Hub user ids; every id must be an active member; the creator is always added;
- `create` writes the row and the `group_memory_events` row in one transaction, then emits
  `memory.created` through the passed `events.append` with
  `payload: { memoryId, type, version, content, sourceRefs, acl }`;
- `correct` and `remove` do the same with `memory.corrected` / `memory.deleted`, and
  `version = version + 1` inside the same transaction, guarded by
  `UPDATE ... WHERE id = ? AND workgroupId = ? AND version = ? AND deleted_at IS NULL`, so a SQL
  no-op means `memory/version-conflict`;
- `list` and `search` join `memberships` and filter `json_each(group_memories.acl)` for `userId`;
  `search` uses `group_memories_fts MATCH ?` ordered by `bm25(group_memories_fts)`, limited to 50.

- [ ] **Step 4: Wire the routes**

Add to `hub/src/server.js`, all behind a `memberOr404` helper that reuses
`workgroups.isMember`:

```js
  router.get('/v1/workgroups/:id/memories', ({ params, headers }) => {
    const session = caller(headers)
    return memories.list({ userId: session.user_id, workgroupId: params.id })
  })
  router.get('/v1/workgroups/:id/memories/search', ({ params, headers, req }) => {
    const session = caller(headers)
    return memories.search({ userId: session.user_id, workgroupId: params.id, query: queryOf(req).get('q') ?? '', limit: 50 })
  })
  router.post('/v1/workgroups/:id/memories', async ({ params, body, headers }) => {
    const session = caller(headers)
    return created(await memories.create({ userId: session.user_id, workgroupId: params.id, ...body }))
  })
  router.post('/v1/workgroups/:id/memories/:memoryId/correct', async ({ params, body, headers }) => {
    const session = caller(headers)
    return memories.correct({ userId: session.user_id, workgroupId: params.id, memoryId: params.memoryId, ...body })
  })
  router.post('/v1/workgroups/:id/memories/:memoryId/delete', async ({ params, body, headers }) => {
    const session = caller(headers)
    return memories.remove({ userId: session.user_id, workgroupId: params.id, memoryId: params.memoryId, ...body })
  })
```

- [ ] **Step 5: Run the service tests**

Run: `cd hub && node --test test/group-memory.test.js test/db-g6-schema.test.js`
Expected: PASS, including the ACL, stale-version and delete cases.

- [ ] **Step 6: Commit**

```bash
git add hub/src/memories/service.js hub/src/server.js hub/test/group-memory.test.js
git commit -m "feat(hub): add ACL-scoped group memory with versioned corrections"
```

---

## Task 3: Add the four memory event types

**Files:**
- Modify: `hub/src/workgroups/service.js:34-56`
- Modify: `hub/test/ws-events.test.js` (add a case)
- Modify: `hub/test/db-g4-schema.test.js` only if it enumerates the set

**Interfaces:**
- `EVENT_TYPES` gains `memory.proposed`, `memory.created`, `memory.corrected`, `memory.deleted`.
- `READABLE_EVENT_TYPE` stays `chat.message`; memory events must not change unread counts.

- [ ] **Step 1: Write the failing test**

```js
test('a memory event is a fan-out event but never an unread message', async (t) => {
  const { hub, alice, bob, workgroupId } = await memoryScene(t)
  const socket = connect(hub, bob)
  await socket.hello()
  const before = await hub.get(`/v1/workgroups/${workgroupId}`, { token: bob.token })
  const created = await hub.post(`/v1/workgroups/${workgroupId}/memories`, {
    type: 'canon', content: 'Every invoice needs a PO number.', sourceRefs: [], acl: [],
  }, { token: alice.token })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const frame = await socket.next(message => message.type === 'event' && message.event.type === 'memory.created')
  assert.equal(frame.event.payload.memoryId, created.body.memory.memoryId)
  const after = await hub.get(`/v1/workgroups/${workgroupId}`, { token: bob.token })
  assert.equal(after.body.unreadCount, before.body.unreadCount, 'memory is not an unread chat message')
  await socket.close()
})
```

- [ ] **Step 2: Run and watch fail**

Run: `cd hub && node --test test/ws-events.test.js`
Expected: FAIL — the Hub refuses `memory.created` as an unknown event type, or no frame arrives.

- [ ] **Step 3: Extend the set**

```js
  // ── group memory (§11) ────────────────────────────────
  'memory.proposed',
  'memory.created',
  'memory.corrected',
  'memory.deleted',
```

- [ ] **Step 4: Run the socket tests**

Run: `cd hub && node --test test/ws-events.test.js test/group-memory.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/workgroups/service.js hub/test/ws-events.test.js
git commit -m "feat(hub): fan out group memory changes on the existing event stream"
```

---

## Task 4: Plugin client for Hub memory

**Files:**
- Modify: `ds-bot/src/workgroup/host/hub.js` (five methods)
- Create: `ds-bot/src/workgroup/host/memories.js` (projection + `wg.memory*`)
- Modify: `ds-bot/src/workgroup/index.js` (install order: after `hub`, before `bridge`)
- Modify: `ds-bot/src/workgroup/host/state.js` (persisted `memories` projection)
- Create: `ds-bot/test/workgroup-memory.test.js`
- Create: `ds-bot/test-realtime/helpers-pair.js` (the `invitedPair` fixture, extracted from
  `workgroup-realtime.test.js` so a second test file can reuse it without a copy)

**Interfaces:**
- `wg.hub.memories({ workgroupId })`, `wg.hub.searchMemories({ workgroupId, query })`,
  `wg.hub.createMemory({ ... })`, `wg.hub.correctMemory({ ... })`, `wg.hub.deleteMemory({ ... })`.
- `wg.memoryCache(workgroupId)` → the last projection; `wg.refreshMemories(workgroupId)` → re-read and
  store; `wg.onMemoryEvent({ workgroupId, event })` → refresh and notify the feed.
- State key `memories: { [workgroupId]: { version, entries, fetchedAt } }` in `emptyState()` and the
  adopt whitelist. This is a cache; it is never consulted instead of the Hub by the panel.

- [ ] **Step 1: Write the failing product-level test**

```js
// `helpers-pair.js` exports `withHub`, `machine`, `openMachine`, `until`, `invitedPair` and `roomOf`,
// moved verbatim from `workgroup-realtime.test.js`. Both files import them; this task does not change
// the assertions in the realtime suite.
import { invitedPair, until } from './helpers-pair.js'

test('a memory created on the Hub is projected into every member's cache', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const created = await alice.wg.hub.createMemory({
    workgroupId, type: 'fact', content: 'Shipping address is the Hangzhou warehouse.',
    sourceRefs: [], acl: [],
  })
  await alice.wg.refreshMemories(workgroupId)
  await bob.wg.onMemoryEvent({ workgroupId })
  for (const machine of [alice, bob]) {
    const cached = (machine.wg.state.memories?.[workgroupId]?.entries ?? [])
    assert.equal(cached.some(entry => entry.memoryId === created.memory.memoryId), true,
      `${machine === alice ? 'Alice' : 'Bob'} must have the entry in the projection`)
  }
})
```

- [ ] **Step 2: Run and watch fail**

Run: `cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test-realtime/workgroup-memory.test.js`
Expected: FAIL — `memory-create`/`memory-list` are unknown endpoints.

- [ ] **Step 2b: Extract the shared fixture**

Move `withHub`, `machine`, `openMachine`, `until`, `reader`, `invitedPair`, `roomOf` and `lineByText`
from `test-realtime/workgroup-realtime.test.js` into `test-realtime/helpers-pair.js` and import them
back. Run the realtime suite before touching product code; it must stay 10/10 green at this commit.

- [ ] **Step 3: Implement the Hub client and projection**

In `hub.js`, follow the existing `call(address(), path, { token })` pattern. In `memories.js`:

```js
export function install(wg) {
  const cache = () => {
    wg.state.memories ??= {}
    return wg.state.memories
  }
  async function refreshMemories(workgroupId) {
    const answer = await wg.hub.memories({ workgroupId })
    const entries = Array.isArray(answer?.memories) ? answer.memories : []
    cache()[workgroupId] = { entries, fetchedAt: Date.now() }
    await wg.save({ workgroupId, kind: 'memory' })
    return entries
  }
  async function onMemoryEvent({ workgroupId }) {
    await refreshMemories(workgroupId).catch(() => {})
    wg.rt.workgroupStateSaved?.({ workgroupId, kind: 'memory' })
  }
  Object.assign(wg, { refreshMemories, onMemoryEvent })
}
```

Install `memories` after `hub` so `wg.hub` exists, and before `bridge` so the event hook can be
attached. Do not make `refreshMemories` throw into a socket handler; `bridge.apply` must stay
best-effort.

- [ ] **Step 4: Run the test**

Run: `cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test-realtime/workgroup-memory.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ds-bot/src/workgroup/host/hub.js ds-bot/src/workgroup/host/memories.js \
  ds-bot/src/workgroup/index.js ds-bot/src/workgroup/host/state.js \
  ds-bot/test-realtime/workgroup-memory.test.js
git commit -m "feat(workgroup): read and cache Hub group memory"
```

---

## Task 5: Channel endpoints for memory

**Files:**
- Modify: `ds-bot/src/workgroup/host/channel.js`
- Modify: `ds-bot/test/workgroup-g4-api.test.js` (read-only list)

**Interfaces:**
- These are the product-path endpoints the panel and the client use. Task 4 talks to the Hub client
  directly; this task is the only place that proves `apiHandle` reaches memory.
- `memory-list { workgroupId }` → `{ memories }` (read-only)
- `memory-search { workgroupId, query }` → `{ memories }` (read-only)
- `memory-create { workgroupId, type, content, sourceRefs, acl }` → `{ memory }`
- `memory-correct { workgroupId, memoryId, content, expectedVersion }` → `{ memory }`
- `memory-delete { workgroupId, memoryId, expectedVersion }` → `{ memory }`
- Add both read endpoints to the channel's `READS` set so a read-only host serves them.

- [ ] **Step 1: Write the failing endpoint tests**

```js
test('the memory endpoints are routed through the one workgroup API', async (t) => {
  const { alice, workgroupId } = await invitedPair(t)
  const created = await alice.call('memory-create', {
    workgroupId, type: 'faq', content: 'Where do invoices go?', sourceRefs: [], acl: [],
  })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const listed = await alice.call('memory-list', { workgroupId })
  assert.equal(listed.ok, true)
  assert.equal(listed.value.memories.length >= 1, true)
  const found = await alice.call('memory-search', { workgroupId, query: 'invoices' })
  assert.equal(found.ok, true)
  assert.equal(found.value.memories.length >= 1, true)
})
```

- [ ] **Step 2: Run and watch fail**

Run: `cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit --test-name-pattern="memory endpoints" test-realtime/workgroup-memory.test.js`
Expected: FAIL — unknown endpoint.

- [ ] **Step 3: Add the five cases**

Each case validates its arguments the way the surrounding cases do (`String(body.… ?? '')`, non-empty
checks) and calls the matching `wg` method. `memory-correct` and `memory-delete` require a finite
`expectedVersion`, else `memory/version-required`.

- [ ] **Step 4: Run the endpoint and read-only tests**

Run: `cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test-realtime/workgroup-memory.test.js test/workgroup-g4-api.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ds-bot/src/workgroup/host/channel.js ds-bot/test/workgroup-g4-api.test.js
git commit -m "feat(workgroup): expose group memory through the workgroup API"
```

---

## Task 6: Make the memory review fire for workgroup members

**Files:**
- Modify: `ds-bot/src/host/memory.js:462-470, 1474-1486`
- Modify: `ds-bot/src/workgroup/host/ownership.js` (expose `roomIdOf`)
- Create: `ds-bot/test/workgroup-memory-review.test.js`
- Reuse: the `start()` fixture in `ds-bot/test/workgroup-round.test.js` must be exported rather than
  copied. Rename it `export function startRoundFixture()` in that file and import it here.

**Interfaces:**
- New `rt.memoryRoomOf(sessionId)` seam in `ownership.js`, returning the workgroup id only for a
  member Session (never the group's own relay Session).
- `memory.js` uses `roomOf`/`memoryRoomOf` instead of `rt.groupOwners`/`rt.pastOwners` for room
  resolution in `roomIdOf`.
- The `agent/status` gate becomes
  `if (id === undefined || (!rt.isBotSession(id) && !rt.memoryRoomOf?.(id) && !turnOwners.has(id))) return`
  so a workgroup member's turn is reviewed, while the original domain's filtering stays intact.

- [ ] **Step 1: Write the failing test**

```js
import { startRoundFixture } from './workgroup-round.test.js'

test('a workgroup member Session is eligible for a memory review', async (t) => {
  const { wg, rt, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'ReviewProbe', members: twoMembers() })
  const memberSession = await wg.sessionFor(room, room.members[0])
  assert.equal(typeof rt.memoryRoomOf, 'function', 'the memory module needs a workgroup-aware room lookup')
  assert.equal(rt.memoryRoomOf(memberSession.id), room.id, 'a member Session resolves to its group')
  assert.equal(rt.memoryRoomOf(room.id), undefined, 'the group relay is not a member and has no room scope')
  // The original filter must stay untouched: a workgroup member is not `rt.isBotSession`, and the
  // fix is the extra seam, not a change to that predicate.
  assert.equal(rt.isBotSession(memberSession.id), false)
})
```

- [ ] **Step 2: Run and watch fail**

Run: `cd ds-bot && node --test test/workgroup-memory-review.test.js`
Expected: FAIL — `rt.memoryRoomOf` is undefined.

- [ ] **Step 3: Implement the seam and the gate**

`ownership.js`:

```js
  // The group a Session speaks in, for modules such as memory that need the ROOM rather than the
  // owner. The group's own relay Session is not a member and answers undefined, so a review can
  // never treat the relay as a participant.
  function memoryRoomOf(sessionId) {
    const owner = sessionOwners.get(sessionId)
    return owner?.botId === undefined ? undefined : owner.workgroupId
  }
  rt.memoryRoomOf = memoryRoomOf
```

`memory.js`: replace `roomIdOf` with

```js
  const roomIdOf = sessionId =>
    rt.groupOwners.get(sessionId)?.roomId ?? rt.pastOwners.get(sessionId)?.roomId ?? rt.memoryRoomOf?.(sessionId)
```

and relax the `agent/status` filter exactly as specified above.

- [ ] **Step 4: Run the review tests plus the existing memory suite**

Run: `cd ds-bot && node --test test/workgroup-memory-review.test.js test/memory.test.js`
Expected: PASS, and the original memory tests must remain green.

- [ ] **Step 5: Commit**

```bash
git add ds-bot/src/host/memory.js ds-bot/src/workgroup/host/ownership.js ds-bot/test/workgroup-memory-review.test.js
git commit -m "feat(workgroup): let the memory review see workgroup member sessions"
```

---

## Task 7: Archive memory when a workgroup is deleted

**Files:**
- Modify: `ds-bot/src/workgroup/host/groups.js:1229-1282`
- Modify: `ds-bot/test/workgroup-memory.test.js`

**Interfaces:**
- `deleteWorkgroup` calls `rt.archiveGroupMemory?.(room)` after the Hub delete succeeds and before the
  local record is removed.
- The Hub side already cascades `group_memories` on group delete (Task 1); add a test that proves the
  Hub rows are gone.

- [ ] **Step 1: Write the failing test**

```js
test('deleting a workgroup archives its local memory and removes the Hub entries', async (t) => {
  const { alice, wg, room, workgroupId } = await memoryFixture(t)
  await alice.call('memory-create', {
    workgroupId, type: 'fact', content: 'Archived with the group.', sourceRefs: [], acl: [],
  })
  const archived = []
  alice.rt.archiveGroupMemory = (value) => { archived.push(value.id); return Promise.resolve() }
  await wg.deleteWorkgroup(room.id)
  assert.deepEqual(archived, [room.id])
  const hubMemory = await alice.wg.hub.memories({ workgroupId }).then(() => 'present', error => error)
  assert.ok(hubMemory === 'present' || hubMemory?.status === 404, 'the Hub answers 404 after the group is gone')
})
```

- [ ] **Step 2: Run and watch fail**

Expected: FAIL — `archiveGroupMemory` is never called.

- [ ] **Step 3: Call the archive**

Insert after the Hub delete and before `dropLines(roomId)`:

```js
    // A deleted group's knowledge must not survive as a folder that a later room with the same id
    // could read. The original `deleteRoom` archives the group memory for the same reason; this copy
    // was missing that call.
    await Promise.resolve(rt.archiveGroupMemory?.(room)).catch(error => rt.warn('ds-bot: memory of workgroup %s not archived: %s', room.name, error))
```

- [ ] **Step 4: Run the tests**

Run: `cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-memory.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ds-bot/src/workgroup/host/groups.js ds-bot/test/workgroup-memory.test.js
git commit -m "fix(workgroup): archive group memory when a workgroup is deleted"
```

---

## Task 8: Memory section in the workgroup settings UI

**Files:**
- Modify: `ds-bot/src/workgroup/client/group-settings.js`
- Modify: `ds-bot/src/workgroup/client/panel.js`
- Modify: `ds-bot/test/workgroup-ux.test.js`
- Modify: `ds-bot/test-realtime/workgroup-memory.test.js`

**Interfaces:**
- A `MemoryCard` component below the members card: list of entries with type, content, source count,
  version, and Correct/Delete buttons; a search box; an Add form.
- All actions call `callWorkgroup('memory-*')`; after a successful write the card re-reads
  `memory-list`, so the UI never merges locally.
- A `memory` `workgroup` feed event triggers a re-read, same as the room/member listeners.

- [ ] **Step 1: Write the failing UI tests**

```js
test('the workgroup settings form lists, searches, adds and corrects group memory', () => {
  const source = readFileSync(new URL('../src/workgroup/client/group-settings.js', import.meta.url), 'utf8')
  assert.match(source, /callWorkgroup\('memory-list'/)
  assert.match(source, /callWorkgroup\('memory-search'/)
  assert.match(source, /callWorkgroup\('memory-create'/)
  assert.match(source, /callWorkgroup\('memory-correct'/)
  assert.match(source, /callWorkgroup\('memory-delete'/)
  assert.match(source, /expectedVersion/, 'a correction sends the version it read')
})
```

- [ ] **Step 2: Run and watch fail**

Run: `cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit --test-name-pattern="group memory" test/workgroup-ux.test.js`
Expected: FAIL — no memory calls in the settings form.

- [ ] **Step 3: Build the card**

Follow the existing `Card`/`Row`/`InlineText` primitives. Keep every string inside `t('…')` and add
the Chinese translations in `src/client/i18n.js`. Do not add a second fetch path: use
`callWorkgroup`.

- [ ] **Step 4: Rebuild the client and run the UI tests**

Run: `cd ds-bot && npm run build && node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-ux.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ds-bot/src/workgroup/client/group-settings.js ds-bot/src/workgroup/client/panel.js \
  ds-bot/src/client/i18n.js ds-bot/client.js ds-bot/test/workgroup-ux.test.js \
  ds-bot/test-realtime/workgroup-memory.test.js
git commit -m "feat(workgroup): edit shared group memory from the settings form"
```

---

## Task 9: Prove T18's negative cases and restart safety

**Files:**
- Modify: `hub/test/group-memory.test.js`
- Modify: `ds-bot/test-realtime/workgroup-memory.test.js`
- Modify: `hub/test/recovery.test.js` only if it asserts table counts

**Interfaces:**
- None new; this task is the T18 gate.

- [ ] **Step 1: Write the failing negative-case tests**

```js
test('a member who left stops reading the group memory immediately', async (t) => {
  const { hub, alice, bob, workgroupId, memoryId } = await createdMemorySharedWithBob(t)
  const bobMembership = await membershipOf(hub, bob, workgroupId)
  await hub.post(`/v1/workgroups/${workgroupId}/members/${bobMembership.membershipId}/leave`, {}, { token: bob.token })
  const after = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: bob.token })
  assert.equal(after.status, 404)
  const search = await hub.get(`/v1/workgroups/${workgroupId}/memories/search?q=budget`, { token: bob.token })
  assert.equal(search.status, 404)
})

test('memory survives a Hub restart for the same members and no others', async (t) => {
  // A real close and reopen of the same database file, not a clock change: the rows must be on disk,
  // and the FTS index must still answer after the process that built it is gone.
  // No `t.after` on this first Hub: the test closes it deliberately before reopening the same file.
  const hub = await startHub()
  const alice = await person(hub, { phone: PHONE_A, name: 'Alice' })
  const bob = await person(hub, { phone: PHONE_B, name: 'Bob' })
  const { workgroupId } = await groupWith(hub, { owner: alice, others: [bob] })
  const created = await hub.post(`/v1/workgroups/${workgroupId}/memories`, {
    type: 'fact', content: 'The budget closes on the 25th.', sourceRefs: [], acl: [bob.userId],
  }, { token: alice.token })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const memoryId = created.body.memory.memoryId
  const dataDir = hub.config.dataDir
  await hub.close()
  // `startHub` removes its temp data dir on close, so recreate the same path before reopening it.
  mkdirSync(dataDir, { recursive: true })

  const second = await startHub({ dataDir })
  t.after(async () => { await second.close() })
  const reopened = await second.post(`/v1/auth/login`, { phone: PHONE_A, password: PASSWORD })
  const again = await second.get(`/v1/workgroups/${workgroupId}/memories`, { token: reopened.body.accessToken })
  assert.equal(again.body.memories.some(entry => entry.memoryId === memoryId), true)
  const found = await second.get(`/v1/workgroups/${workgroupId}/memories/search?q=budget`, { token: reopened.body.accessToken })
  assert.equal(found.body.memories.some(entry => entry.memoryId === memoryId), true)
})
```

- [ ] **Step 2: Run and watch fail or pass for the wrong reason**

Run: `cd hub && node --test test/group-memory.test.js`
Expected: the first test fails until the route's membership check covers search as well as list.

- [ ] **Step 3: Tighten both read paths**

Make `list` and `search` share one `requireMember` call, so a future route cannot forget it.

- [ ] **Step 4: Add the two-runtime propagation test**

```js
test('a memory change reaches the other machine without a manual refresh', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const created = await alice.call('memory-create', {
    workgroupId, type: 'canon', content: 'All invoices are due on the 25th.', sourceRefs: [], acl: [],
  })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  await until(() => (bob.wg.state.memories?.[workgroupId]?.entries ?? [])
    .some(entry => entry.memoryId === created.value.memory.memoryId),
  { label: "Bob's cache to receive the memory event" })
})
```

- [ ] **Step 5: Run the T18 suite**

Run:
```bash
cd hub && node --test test/group-memory.test.js
cd ../DeepSeek-Bot-main/ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test-realtime/workgroup-memory.test.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hub/test/group-memory.test.js ds-bot/test-realtime/workgroup-memory.test.js ds-bot/src/workgroup/host/memories.js
git commit -m "test(workgroup): prove group memory ACL, deletion and restart safety"
```

---

## Task 10: Record the keychain decision and fix stale documentation

**Files:**
- Modify: `docs/workgroup/KNOWN-GAPS.md`
- Modify: `docs/workgroup/README.md`
- Modify: `docs/workgroup/gates.md`
- Modify: `docs/workgroup/progress-and-gaps.md`
- Modify: `docs/workgroup/manual-checklist.md`
- Create: `docs/workgroup/g6/EVIDENCE-MATRIX.md`
- Create: `docs/workgroup/g6/ROUND-LOG.md`
- Create: `docs/workgroup/g6/DESIGN-GROUP-MEMORY.md`

**Interfaces:**
- None.

- [ ] **Step 1: Re-verify the keychain fact before writing it down**

Run:
```bash
cd ds-bot && grep -rn "OS-keychain provider" dev/harness/node_modules/@deepseek-ai/dsh-credentials-local/README.md
```
Expected: the "deferred" sentence. If DSH has since shipped a keychain provider, record that and open
a follow-up; do not silently keep the old text.

- [ ] **Step 2: Update `KNOWN-GAPS.md`**

State the current fact: DSH 0.2.1-rc.2 ships `dsh-credentials-local` with a documented same-UID read
limitation and no OS-keychain provider. Keep the item open, do not mark it fixed.

- [ ] **Step 3: Fix the stale documentation found in the review**

- `docs/workgroup/README.md`: water level G3 → "G6 in progress; G5 automated complete, manual
  gates BLOCKED"; add `g6/` to the index.
- `docs/workgroup/gates.md`: keep historical numbers but label each as the run it came from; add the
  current baseline `ds-bot 1132 / 1131 pass / 1 skip / 0 fail`, `hub 268 / 268` at commit `e71119b`.
- `docs/workgroup/progress-and-gaps.md`: replace the 1.2 s polling claim with the current feed push +
  5 s fallback; update the status line to "G6 in progress".
- `docs/workgroup/HANDOFF-NEXT-SESSION.md`: mark the old "uncommitted" section as historical and point
  to the commit range `22c2767..e71119b`.
- `docs/workgroup/manual-checklist.md`: add the G6 memory manual check.

- [ ] **Step 4: Record the G6 evidence**

Fill `g6/EVIDENCE-MATRIX.md` with one row per T18 sub-claim: role-based read, member-left, deleted
entry, correction version, source refs, restart, cross-machine propagation. Every row names the test
file and the assertion. Leave the two-machine manual check BLOCKED.

- [ ] **Step 5: Commit**

```bash
git add docs/workgroup/KNOWN-GAPS.md docs/workgroup/README.md docs/workgroup/gates.md \
  docs/workgroup/progress-and-gaps.md docs/workgroup/manual-checklist.md \
  docs/workgroup/HANDOFF-NEXT-SESSION.md docs/workgroup/g6
git commit -m "docs(workgroup): record the G6 group memory design and evidence"
```

---

## Verification matrix

| Requirement | Task | Test |
|---|---|---|
| `group_memories` exists with FTS and cascade | 1 | `hub/test/db-g6-schema.test.js` |
| Non-member cannot read or search | 2, 9 | `hub/test/group-memory.test.js` |
| Correction with an old version is refused | 2 | `group-memory.test.js` stale-version case |
| Deleted entry leaves search but keeps audit | 2, 9 | `group-memory.test.js` delete case |
| `memory.*` fans out and is not unread | 3 | `hub/test/ws-events.test.js` |
| Another machine reads a new entry | 4, 9 | `ds-bot/test-realtime/workgroup-memory.test.js` |
| Panel lists, searches, adds, corrects | 8 | `ds-bot/test/workgroup-ux.test.js` |
| Workgroup review fires | 6 | `ds-bot/test/workgroup-memory-review.test.js` |
| Deleting a group archives memory | 7 | `ds-bot/test/workgroup-memory.test.js` |
| Private memory never leaks into group memory | 2, 6, 9 | ACL + `memory.test.js` |
| Docs state the keychain fact truthfully | 10 | review of `KNOWN-GAPS.md` |

## Manual gates (remain BLOCKED)

- G5-T12: execution really happens on B's machine.
- G5-N3: approval card visual comparison.
- G5-T14: a real symlink on a real filesystem.
- G4-1, G4-5, G4-6, G4-T20 as listed in `manual-checklist.md`.
- G6-M1: two real machines, each with a different account, read the same group memory and cannot read
  it after one leaves. Steps go into `manual-checklist.md` in Task 10.

## Explicit non-goals

- Do not add a vector database; FTS5 only.
- Do not move the local Markdown memory format; it stays the projection for prompt freezing.
- Do not import local group history into group memory.
- Do not add a second browser transport; memory refresh uses the existing feed plus `apiHandle`.
- Do not change `src/host/{groups,turns,delivery,resume,constants}.js`.
- Do not bump the version, pack, or release.
