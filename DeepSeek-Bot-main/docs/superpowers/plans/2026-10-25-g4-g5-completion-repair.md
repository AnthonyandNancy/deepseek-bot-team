# G4/G5 Completion Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every G4/G5 gap that is still open in the implementation and evidence, while preserving
the copied original group-chat architecture and the Hub's role as the only ordered event source.

**Architecture:** The Hub remains the authoritative ordered log (`events.seq`, `event_id` dedup,
`deliveries`, `read_cursors`). The plugin's bridge remains a durable outbox/inbox. The local group
round remains copied from the original (`openingSpeakers` → `callMembers` → `runRound`); remote
members are reached only through `chat.message{call}` and answered through ordinary mirrored lines.
This plan adds durability and version fences around those existing seams; it does not add a second
orchestrator, an agent framework, or a new browser transport.

**Tech Stack:** Node.js ESM, `node:test`, SQLite WAL in `hub/`, `ws`, React client sources compiled
by `scripts/build-client.mjs`.

## Global Constraints

- Do not modify `ds-bot/src/host/{groups,turns,delivery,resume,constants}.js`; the G4/G1 isolation
  rule requires them byte-identical. If a change is unavoidable, stop and ask.
- Do not patch DSH or depend on files inside a DSH install.
- One workgroup domain install per runtime; a second install must throw.
- A workgroup must remain a copied original group chat, not a new agent framework. No new role
  router, no model-based speaker selection replacing `@Name`.
- Hub is authoritative for membership, settings and the message log. Local state is a projection.
- `src/host/` may only change the already-approved feed signal in `feed.js`. Any other change is a
  scope violation.
- Tests use temp dirs only; never `~/.dsh` or the user's DSH data.
- Every user-facing plugin string is English. No AI-authored commit attribution.
- Do not claim a G4/G5 gate PASS from a source-level assertion alone; a product-path assertion must
  exercise `apiHandle` or the real socket.
- Manual-only gate items stay BLOCKED until the maintainer supplies two-machine evidence.

---

## Scope audit

The current ledger says G4 and G5 are "automatically partial". The remaining gaps that this plan
must close are:

| ID | Gap | Why it matters | Current evidence |
|---|---|---|---|
| R1 | `remoteWaiters` is process-local | Coordinator restart loses a remote slot; the answer becomes an unrelated opener or is lost | `workgroup-realtime` same-round test passes only while both processes stay alive |
| R2 | Settings have no client-side compare-and-apply | Two machines can overwrite each other with an older snapshot; `config_version` exists but is not checked by the plugin | `workgroup-membership` convergence tests are single-writer |
| R3 | T17 proves request dedup, not side-effect dedup after a *started* task | A started task whose ACK was lost has no durable "this run already began" marker | `task-envelope` resends `task.request`; it does not restart a RUNNING task |
| R4 | Remote-call and local-call cancellation do not share a durable state | After a restart, a cancelled remote slot can be replayed as missed or answered | `stopRound` cancels in-memory waiters only |
| R5 | No persisted round/slot projection | `roundId`/`slotIndex` are on the wire but not in local state | `groups.js` round objects are memory only |
| R6 | Full suite has a cross-file handle hang/report | `npm test` once ended 1117 pass / 1 fail / 1 skip, and once hung; `feed.test.js` passes alone 5/5 | grouped runs are green; one-process full gate is not proven |
| R7 | Manual gates remain BLOCKED | G4 gates 1/6, T19/T20; G5 T12 real-machine and N3 | No two-machine evidence |

Out of scope: G6 group memory, mobile, OTP, P2P, multi-Hub, OS keychain, WeChat/WeClaw integration.

---

## File structure

| File | Responsibility |
|---|---|
| `ds-bot/src/workgroup/host/round-state.js` (new) | Persisted round/slot projection: `roundId`, `roomId`, `slots[]`, `exchangeId`, `state`, `updatedAt` |
| `ds-bot/src/workgroup/host/groups.js` | Round creation, remote slot, `stopRound`, restore/reconcile hooks |
| `ds-bot/src/workgroup/host/bridge.js` | `chat.message` send/ack path; no round semantics |
| `ds-bot/src/workgroup/host/channel.js` | Read/resume endpoints if a UI needs round state |
| `ds-bot/src/workgroup/host/state.js` | `rounds: {}` in the persisted whitelist |
| `hub/src/workgroups/service.js` | `publicGroup.configVersion`; settings compare-and-apply |
| `ds-bot/src/workgroup/host/hub.js` | Send `configVersion` on settings writes |
| `ds-bot/src/workgroup/host/groups.js` | Reject an older `configVersion` snapshot |
| `ds-bot/src/workgroup/host/task-runner.js` | Durable `runStartedAt`/`runId` fence; reject a second start after restart |
| `ds-bot/src/workgroup/host/tasks.js` | Persist the run fence in the task record |
| `hub/src/tasks/service.js` | Reject a second `RUNNING` report for the same task after restart? (see Task 4) |
| `ds-bot/test-realtime/*.test.js` | Two-runtime/restart tests |
| `ds-bot/test/workgroup-*.test.js` | Product-path unit/integration tests |

---

## Task 1: Persist the round/slot projection

**Files:**
- Create: `ds-bot/src/workgroup/host/round-state.js`
- Modify: `ds-bot/src/workgroup/host/state.js`
- Modify: `ds-bot/src/workgroup/host/groups.js`
- Test: `ds-bot/test-realtime/workgroup-realtime.test.js`

**Interfaces:**
- Produces: `wg.rounds` map and `wg.persistRound(round)`, `wg.dropRound(roundId)`,
  `wg.roundOf(roundId)`.
- Test helper: `open(home, phone)` in `workgroup-realtime.test.js` returns a fresh runtime on an
  existing `home`; `reopenMachine` is `open(alice.home, ALICE)` with the same Hub URL.
- Persisted shape: `{ roundId, roomId, startSeq, slots: [{ id, name, status, exchangeId?, by?, note? }], turns, replies: [], passed: [], failed: [], state }`.
- `state` is `open`, `closed`, `stopped`.

- [ ] **Step 1: Write the failing test**

```js
test('a remote slot survives a coordinator restart as an open obligation', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const room = roomOf(alice, workgroupId)
  const remote = room.members.find(member => member.name === 'BobChief')
  const roundId = 'round-restart-1'
  const exchangeId = 'exchange-restart-1'
  // Start a real round that names the remote Bot.
  const running = alice.rt.ctx.registeredTools.get('workgroup_relay').execute(
    {}, { agent: { id: room.id }, callId: 'call-restart', signal: new AbortController().signal },
  )
  await until(() => [...alice.wg.roomWaiters.values()].some(w => w.memberId === remote.id), { label: 'remote waiter' })
  assert.equal(alice.wg.roundOf(roundId)?.slots.length > 0, true)
  // Simulate a coordinator process replacement without deleting its home.
  await alice.wg.bridge.stop()
  const restarted = await open(alice.home, ALICE)
  await until(() => restarted.wg.roundOf(roundId)?.state === 'open', { label: 'recovered round' })
  assert.equal(restarted.wg.roundOf(roundId).slots[0].exchangeId, exchangeId)
  await running.catch(() => {})
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import ./test/harness-resolve.mjs --test --test-force-exit test-realtime/workgroup-realtime.test.js`
Expected: FAIL because `wg.roundOf` is undefined and no round is persisted.

- [ ] **Step 3: Implement the minimal projection**

```js
// round-state.js
export function install(wg) {
  const rounds = () => {
    wg.state.rounds ??= {}
    return wg.state.rounds
  }
  const roundOf = roundId => (roundId === undefined ? undefined : rounds()[roundId])
  const persistRound = (round) => {
    const record = {
      roundId: round.id,
      roomId: round.roomId,
      startSeq: round.startSeq,
      slots: (round.slots ?? []).map(slot => ({
        id: slot.id, name: slot.name, status: slot.status,
        ...(slot.exchangeId === undefined ? {} : { exchangeId: slot.exchangeId }),
        ...(slot.by === undefined ? {} : { by: slot.by }),
        ...(slot.note === undefined ? {} : { note: slot.note }),
      })),
      turns: round.turns ?? 0,
      replies: round.replies ?? [],
      passed: round.passed ?? [],
      failed: round.failed ?? [],
      state: round.state ?? 'open',
      updatedAt: Date.now(),
    }
    rounds()[round.id] = record
    void wg.save().catch(() => {})
    return record
  }
  const dropRound = (roundId) => {
    if (rounds()[roundId] === undefined) return false
    delete rounds()[roundId]
    void wg.save().catch(() => {})
    return true
  }
  Object.assign(wg, { roundOf, persistRound, dropRound })
}
```

Add `rounds: {}` to `emptyState()` and to the `adopt` whitelist in `state.js`. Install
`round-state.js` before `groups.js` in `WG_MODULES`.

In `groups.js`:
- Give every round an `id` (`randomUUID()`) when it is constructed in the relay tool.
- Set each slot's `exchangeId` when a remote call is sent.
- Call `wg.persistRound(round)` after each slot status change and in `receiveRemote` after a reply.
- Call `wg.dropRound(round.id)` in `stopRound` and when the round ends normally.
- `stopRound` calls `round.abort?.()` and each `round.remoteWaiters` cancel, then persists `state: 'stopped'`.

- [ ] **Step 4: Run the test and the round suite**

Run:
```bash
node --import ./test/harness-resolve.mjs --test --test-force-exit test-realtime/workgroup-realtime.test.js test/workgroup-round.test.js
```
Expected: PASS, including the existing "a remote answer is handled by the calling round" test.

- [ ] **Step 5: Commit**

```bash
git add ds-bot/src/workgroup/host/round-state.js ds-bot/src/workgroup/host/state.js ds-bot/src/workgroup/host/groups.js ds-bot/test-realtime/workgroup-realtime.test.js
git commit -m "feat(workgroup): persist round slots across coordinator restart"
```

---

## Task 2: Reconcile recovered rounds on reconnect

**Files:**
- Modify: `ds-bot/src/workgroup/host/groups.js`
- Modify: `ds-bot/src/workgroup/host/bridge.js`
- Test: `ds-bot/test-realtime/workgroup-realtime.test.js`

**Interfaces:**
- Consumes: `wg.roundOf`, `wg.persistRound`, `wg.dropRound`, `bridge.on('event')`.
- Produces: `wg.reconcileRounds(roomId?)`, called after `hello`, `sync.batch`, and `receiveRemote`.

- [ ] **Step 1: Write the failing test**

```js
test('a recovered waiting slot is continued by the matching Hub answer, once', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  // Leave a persisted open round with exchange exchange-recover-1.
  // Restart Alice, let Bob answer under that exchange, and assert:
  //   - the answer appears once;
  //   - the round's slot is posted;
  //   - no second relay was opened.
})
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL because no reconciler consumes the persisted round after restart.

- [ ] **Step 3: Implement the reconciler**

```js
// groups.js
async function reconcileRounds(roomId) {
  await wg.load()
  for (const record of Object.values(wg.state.rounds ?? {})) {
    if (roomId !== undefined && record.roomId !== roomId) continue
    if (record.state !== 'open') continue
    const room = wg.workgroupOf(record.roomId)
    if (room === undefined) continue
    for (const slot of record.slots) {
      if (slot.status !== 'remote' || slot.exchangeId === undefined) continue
      const line = (room.log ?? []).find(entry => entry.exchangeId === slot.exchangeId)
      if (line !== undefined) {
        slot.status = 'posted'
        record.replies.push({ botId: line.memberId, name: line.who, text: line.text, time: Date.now() })
        continue
      }
      // The Hub log is the authority: a replay may not have reached the local log yet.
      const page = await wg.hub.events({ workgroupId: room.hubWorkgroupId, afterSeq: record.startSeq - 1 })
      const event = (page.events ?? []).find(entry => entry.payload?.exchangeId === slot.exchangeId)
      if (event !== undefined) await wg.receiveRemote({ workgroupId: room.hubWorkgroupId, event })
    }
    await wg.persistRound(record)
  }
}
wg.reconcileRounds = reconcileRounds
```

Call it:
- in `bridge.js` after the `hello` frame and each `sync.batch`;
- in `receiveRemote` after appending a line with an exchange;
- in `channel.js`'s `room` read only if a test needs it (prefer the event path).

- [ ] **Step 4: Run the tests**

```bash
node --import ./test/harness-resolve.mjs --test --test-force-exit test-realtime/workgroup-realtime.test.js test/workgroup-membership.test.js
```
Expected: PASS; the new restart test proves one continuation and no duplicate line.

- [ ] **Step 5: Commit**

```bash
git add ds-bot/src/workgroup/host/groups.js ds-bot/src/workgroup/host/bridge.js ds-bot/test-realtime/workgroup-realtime.test.js
git commit -m "feat(workgroup): reconcile persisted round slots from the Hub log"
```

---

## Task 3: Compare-and-apply group settings by config version

**Files:**
- Modify: `hub/src/workgroups/service.js`
- Modify: `ds-bot/src/workgroup/host/hub.js`
- Modify: `ds-bot/src/workgroup/host/groups.js`
- Test: `hub/test/workgroup-settings.test.js` (new if absent), `ds-bot/test-realtime/workgroup-realtime.test.js`

**Interfaces:**
- Hub `publicGroup` returns `configVersion: row.config_version`.
- `POST /v1/workgroups/:id/settings` accepts optional `configVersion`; if present and not equal to
  the current row, return 409 `workgroup/settings-stale` with the current version.
- `SETTINGS_FIELDS` must include `configVersion`, or the allow-list rejects the new field before the
  comparison runs.
- The plugin keeps `room.hubConfigVersion`, initialized from the first group response in
  `ensureLinkedGroup`/`applyRoster`, and only applies a roster/settings snapshot whose
  `configVersion >= room.hubConfigVersion`.

- [ ] **Step 1: Write the failing tests**

Hub:
```js
test('a settings write from an old config version is refused', async (t) => {
  const { group } = await scene(t)
  const first = await postSettings(group, { name: 'v2', configVersion: 1 })
  assert.equal(first.status, 200)
  assert.equal(first.body.workgroup.configVersion, 2)
  const stale = await postSettings(group, { name: 'v1-overwrite', configVersion: 1 })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.code, 'workgroup/settings-stale')
})
```
Plugin: two concurrent writes from two runtimes; the later-version answer wins, and an older
response cannot overwrite the newer room.

- [ ] **Step 2: Run and watch fail**

```bash
cd hub && node --test test/workgroup-settings.test.js
cd ../DeepSeek-Bot-main/ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test-realtime/workgroup-realtime.test.js
```
Expected: first fails because `configVersion` is absent; second because no compare happens.

- [ ] **Step 3: Implement**

Hub:
```js
const publicGroup = row => ({
  ...,
  configVersion: row.config_version,
})
```
In `updateSettings`, before writing:
```js
if (body.configVersion !== undefined) {
  const version = Number(body.configVersion)
  if (!Number.isFinite(version) || version !== group.config_version) {
    throw conflict('workgroup/settings-stale',
      `This group's settings changed (version ${group.config_version}); re-read and try again.`)
  }
}
```
`conflict` is already imported in the service.

Plugin:
```js
const version = answer.configVersion
if (version !== undefined && room.hubConfigVersion !== undefined && version < room.hubConfigVersion) {
  return room
}
if (version !== undefined) room.hubConfigVersion = version
```
Pass `configVersion: room.hubConfigVersion` on `updateGroupSettings` and include it in the room
signature so the UI re-renders when it moves.

- [ ] **Step 4: Run the tests**

```bash
cd hub && node --test test/workgroup-settings.test.js
cd ../DeepSeek-Bot-main/ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test-realtime/workgroup-realtime.test.js test/workgroup-membership.test.js
```
Expected: PASS; stale writes are refused with 409, and the newer room survives.

- [ ] **Step 5: Commit**

```bash
git add hub/src/workgroups/service.js hub/test/workgroup-settings.test.js ds-bot/src/workgroup/host/hub.js ds-bot/src/workgroup/host/groups.js ds-bot/test-realtime/workgroup-realtime.test.js
git commit -m "feat(workgroup): refuse stale group settings by config version"
```

---

## Task 4: Make a started task's run idempotent across reconnect

**Files:**
- Modify: `ds-bot/src/workgroup/host/tasks.js`
- Modify: `ds-bot/src/workgroup/host/task-runner.js`
- Test: `ds-bot/test/workgroup-task.test.js`, `hub/test/task-approval.test.js`

**Interfaces:**
- Task record gains `runId` and `runStartedAt`.
- A persisted `taskRuns` map records `{ deliveredAt }` per `runId`; it must be added to the state
  `adopt` whitelist.
- `runTask({ taskId })` returns the existing run when `record.runId` is already set and the task is
  `RUNNING`; it must not deliver a second prompt.
- A restart of the same task home, with the record in `RUNNING`, marks it `INTERRUPTED` in
  `indexTasks()` and never auto-replays; `startTask` may resume only through an explicit new `runId`
  approved by the user.

- [ ] **Step 1: Write the failing test**

```js
test('a started task is not delivered twice when the start request is replayed', async (t) => {
  const { wg, rt } = await approvedTaskFixture(t)
  const first = await wg.runTask({ taskId: 'task_fixed' })
  assert.ok(first.runId)
  const delivered = deliveredCount('task_fixed')
  const again = await wg.runTask({ taskId: 'task_fixed' })
  assert.equal(again.runId, first.runId)
  assert.equal(deliveredCount('task_fixed'), delivered, 'no second prompt')
})
```

Also:
```js
test('a restart while RUNNING marks the task INTERRUPTED, not replayable', async (t) => {
  // write a record with state RUNNING, runId set, reopen, assert INTERRUPTED and runTask throws
})
```

And the T17 shape the plan actually asks for: a side-effecting tool has already run, the ack is
lost, the socket reconnects, and the same task must not run that side effect again.
```js
test('a task whose side effect ran before disconnect is not replayed on reconnect', async (t) => {
  const effects = []
  // The task Session's tool call appends to `effects`.
  // Deliver once, mark `taskRuns[runId].deliveredAt`, then drop the socket before ack.
  // Reconnect; assert effects.length === 1 and the task is still RUNNING (not re-delivered).
})
```

- [ ] **Step 2: Run and watch fail**

```bash
node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-task.test.js
```
Expected: FAIL because a second `runTask` hits `startTask`'s `not approved` or, worse, a second
delivery.

- [ ] **Step 3: Implement the fence**

In `tasks.js`:
```js
record.runId ??= randomUUID()
record.runStartedAt ??= Date.now()
```
In `startTask`, before `advanceTask`:
```js
if (record.state === 'RUNNING' && record.runId !== undefined) return record
```
In `runTask`, before `wg.deliver`:
```js
if (record.runId !== undefined && record.state === 'RUNNING') {
  const earlier = wg.state.taskRuns?.[record.runId]
  if (earlier?.deliveredAt !== undefined) return record
  wg.state.taskRuns ??= {}
  wg.state.taskRuns[record.runId] = { deliveredAt: Date.now() }
  await wg.save()
}
```
In `indexTasks()` in `tasks.js`, any record in `RUNNING` becomes `INTERRUPTED` with
`interruptedAt` and `runId` preserved, and `wg.save()` is called once after the pass; there is no
automatic replay.

- [ ] **Step 4: Run the tests**

```bash
node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-task.test.js test/workgroup-task-envelope.test.js
```
Expected: PASS, including the existing "starting a task delivers the approved request into its
Session" once-only assertion.

- [ ] **Step 5: Commit**

```bash
git add ds-bot/src/workgroup/host/tasks.js ds-bot/src/workgroup/host/task-runner.js ds-bot/test/workgroup-task.test.js ds-bot/src/workgroup/host/state.js
git commit -m "fix(workgroup): make a started task run idempotent across replay"
```

---

## Task 5: Make remote-call cancellation durable

**Files:**
- Modify: `ds-bot/src/workgroup/host/groups.js`
- Modify: `ds-bot/src/workgroup/host/round-state.js`
- Test: `ds-bot/test-realtime/workgroup-realtime.test.js`

**Interfaces:**
- `stopRound` writes `slots[].status = 'stopped'` and `state = 'stopped'` into the persisted round,
  then cancels local and remote waiters.
- `reconcileRounds` treats a persisted `stopped` round as terminal and never calls a member again.

- [ ] **Step 1: Write the failing test**

```js
test('a stopped round stays stopped after a coordinator restart', async (t) => {
  // create an open round with a remote slot; stop it; restart; assert
  //   round.state === 'stopped'
  //   no waiter was recreated
  //   a late answer with the old exchange is ignored
})
```

- [ ] **Step 2: Run and watch fail**

Expected: FAIL because only the in-memory waiter is cancelled; the persisted round remains `open`.

- [ ] **Step 3: Implement**

In `stopRound`:
```js
for (const round of rounds) {
  round.state = 'stopped'
  round.abort?.()
  for (const waiter of round.remoteWaiters?.values() ?? []) waiter.cancel?.()
  round.remoteWaiters?.clear()
  wg.persistRound(round)
}
```
In `reconcileRounds`, skip records whose `state` is `stopped`, and if a line arrives with an exchange
for a stopped round, append it to the log but do not continue the round.

- [ ] **Step 4: Run the tests**

```bash
node --import ./test/harness-resolve.mjs --test --test-force-exit test-realtime/workgroup-realtime.test.js test/workgroup-round.test.js
```
Expected: PASS; a late answer after stop is logged but never calls another member.

- [ ] **Step 5: Commit**

```bash
git add ds-bot/src/workgroup/host/groups.js ds-bot/src/workgroup/host/round-state.js ds-bot/test-realtime/workgroup-realtime.test.js
git commit -m "fix(workgroup): keep a stopped round stopped across restart"
```

---

## Task 6: Make the full-suite gate deterministic

**Files:**
- Modify: `ds-bot/test/feed.test.js`
- Modify: `ds-bot/package.json` only if the script needs the new directory
- Test: `ds-bot/test/feed.test.js`

**Interfaces:**
- No production behavior change; this is test isolation.

- [ ] **Step 1: Reproduce**

```bash
cd ds-bot
npm test > /tmp/dsbot-full.log 2>&1; echo $?
```
Current recorded behavior: one run ended 1117 pass / 1 fail / 1 skip with `test/feed.test.js`
timing out as a file; one run hung with no output. `node --test test/feed.test.js` alone is 5/5.

- [ ] **Step 2: Fix the SSE reader teardown**

In each feed test, keep the reader and cancel it:
```js
const next = reader(response)
t.after(async () => {
  await next.cancel()
})
```
Add `cancel()` to the reader:
```js
function reader(response) {
  const source = response.body.getReader()
  ...
  const next = async function next() { ... }
  next.cancel = () => source.cancel()
  return next
}
```
Also abort the `EventSource`/request in `t.after` for every test that opens a stream.

- [ ] **Step 3: Run the file repeatedly**

```bash
for i in 1 2 3; do node --import ./test/harness-resolve.mjs --test --test-force-exit test/feed.test.js; done
```
Expected: 5/5 each time, exit 0.

- [ ] **Step 4: Run the full suite**

```bash
npm test
```
Expected: all pass, 1 skip, exit 0. If the hang persists, bisect by file group and record the
offending file; do not claim a clean full gate.

- [ ] **Step 5: Commit**

```bash
git add ds-bot/test/feed.test.js
git commit -m "test(feed): close SSE readers so the full suite cannot hang"
```

---

## Task 7: Close the evidence and manual gates

**Files:**
- Modify: `docs/workgroup/gates.md`
- Modify: `docs/workgroup/g4/EVIDENCE-MATRIX.md`
- Modify: `docs/workgroup/g5/EVIDENCE-MATRIX.md`
- Modify: `docs/workgroup/progress-and-gaps.md`
- Modify: `docs/workgroup/manual-checklist.md`

- [ ] **Step 1: Record automation results**

For each task above, append the exact command, exit code and new test names. Do not turn a
source-level assertion into a PASS.

- [ ] **Step 2: Run the grouped suites**

```bash
cd hub && npm test
cd ../DeepSeek-Bot-main/ds-bot && npm test
node scripts/build-client.mjs --check
npm run lint
```
Expected: Hub all pass; ds-bot all pass (1 skip allowed); build check 0; lint 0 errors.

- [ ] **Step 3: Leave the manual gates BLOCKED with exact steps**

- G4-1: two real machines, two accounts, live chat, disconnect/reconnect, attachment hash.
- G4-5: cold-start desktop, sidebar order.
- G4-6: eight-row side-by-side visual checklist with screenshots.
- G4-T20: `npm ci && npm run pack`, reinstall, cold start.
- G5-T12: task executes only on B's machine; A has no task Session and no model usage.
- G5-N3: approval card visual comparison with screenshots.

Do not write "PASS" for any of these without the maintainer's evidence.

- [ ] **Step 4: Commit**

```bash
git add docs/workgroup/gates.md docs/workgroup/g4/EVIDENCE-MATRIX.md docs/workgroup/g5/EVIDENCE-MATRIX.md docs/workgroup/progress-and-gaps.md docs/workgroup/manual-checklist.md
git commit -m "docs(workgroup): record the G4/G5 repair evidence and manual gates"
```

---

## Verification matrix

| Requirement | Task | Test |
|---|---|---|
| Remote slot survives restart | 1, 2 | `a remote slot survives a coordinator restart` |
| Recovered answer continues once | 2 | `a recovered waiting slot is continued ... once` |
| Settings converge, stale write refused | 3 | Hub settings 409 + two-runtime race |
| Started task is not delivered twice | 4 | replay `runTask` -> one deliver |
| Side effect once after ACK loss | 4 | disconnect after effect, reconnect, `effects.length === 1` |
| Restart while RUNNING -> INTERRUPTED | 4 | reopen task home |
| Stop survives restart | 5 | `a stopped round stays stopped` |
| Full suite exit 0 | 6 | `npm test` |
| Manual two-machine gates | 7 | BLOCKED until maintainer evidence |

## Explicit non-goals

- Do not add a role table or model-based speaker selection.
- Do not move Hub data into the original `state.json`.
- Do not make the Hub execute Bot turns.
- Do not add a second browser transport; the workgroup UI keeps using the existing host feed.
- Do not claim G4/G5 complete from grouped tests while `npm test` still hangs.
