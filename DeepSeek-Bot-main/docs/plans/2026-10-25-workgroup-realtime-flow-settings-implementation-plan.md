# Implementation Plan

**Feature:** Workgroup realtime messages, Bot hand-off, and settings convergence

**Goal:** Make a Hub workgroup behave like the original group chat across two machines: a message
typed in the real composer reaches the Hub and the other machine, a remote person's line is visible
in the conversation, a remote Bot's answer closes the exact slot that called it instead of opening a
second round, and a settings change refreshes the surfaces the user actually has open.

**Architecture:** The workgroup remains the copied original group subsystem
(`openingSpeakers` → `callMembers` → `runRound`). No second orchestrator, role router, store, or
browser transport is added. The Hub remains the only ordered event source (`events.seq`, `event_id`
deduplication, `deliveries`, replay by cursor). The plugin's existing WSS bridge remains the only
cross-machine path. This plan fixes the two consumers that were missing: the real composer's user
line is mirrored to the Hub, and a line that crossed the Hub is written into the group Session as
display-only when it must not open another round.

**Tech Stack:** Node.js ESM, `node:test`, `node:sqlite` (`DatabaseSync`) in `hub/`, `ws`, React
sources compiled by `scripts/build-client.mjs`.

## Global Constraints

1. Do not modify `ds-bot/src/host/{groups,turns,delivery,resume,constants}.js`. They must remain
   byte-identical; a change that seems unavoidable is a stop-and-ask event.
2. `ds-bot/src/host/` may change only `memory.js` in this branch's existing G6R baseline. This plan
   adds no change there.
3. Do not patch DSH or depend on files inside a DSH install.
4. Do not add a Hub table, migration, FTS index, memory store, or new browser transport.
   `LATEST_VERSION` stays 7.
5. Do not add a second orchestrator, a model-based speaker picker, or per-Bot group roles. Speaker
   selection stays the copied `openingSpeakers` / `callMembers`.
6. One workgroup install per runtime; a second install throws. A workgroup failure must never take
   the local Bot team down.
7. Tests use temporary directories only; never `~/.dsh`, the desktop app's data, or the user's DSH
   data.
8. Every user-facing plugin string is English. `client.js` is generated: edit `src/client/` then run
   `npm run build`.
9. No release, version bump, packaging, or `Workgroup-AI` reference.
10. Manual-only gates stay **BLOCKED** until a maintainer runs them on real machines. Do not mark
    them PASS from an automated test.
11. If the impact grows beyond this plan, stop and write a **Plan Adjustment** with the original
    plan, the new finding, why the change is needed, the added scope, and wait for approval.

---

## 1. Goal

### What this change achieves

1. A message typed in a workgroup's real composer is on the Hub before the round consumes it, so a
   colleague's machine receives the same line.
2. A remote person's line appears in the workgroup conversation the user actually opens, not only in
   a private local log.
3. A remote Bot's answer closes the exact `exchangeId` slot that called it and continues the same
   round; the same words do not also open a second relay round.
4. A settings change made on one machine refreshes the other machine's open conversation header,
   member list and settings drawer through the store the original components read.
5. The WSS path remains one authenticated socket, one ordered event stream and one consumer table;
   `chat.message`, `memory.change`, `task.*`/`approval.*`/`artifact.*` and the lease frames keep
   their own consumers.

### Not included

- Any new Hub table, migration, FTS index, or memory projection.
- A redesign of the workgroup UI or a new workgroup panel with its own navigation entry.
- A new role router or a model-based replacement for `@Name`.
- Backfilling a user line that was typed while the socket was down. `mirrorLine` still returns
  without sending when the bridge is offline; that is a known limitation, not silently "fixed" by a
  second queue.
- Replaying an interrupted round automatically.
- Changes to the original local-group behaviour.
- Release, version bump, packaging, or manual acceptance.

### Success criteria

- A line typed through `postToSession`/the real composer is present in the sender's Hub group log
  and in the other machine's `room.log`, exactly once.
- The other machine's group Session receives that person's line with `source.role === 'remote'`, so
  the conversation view draws it without starting a round.
- A remote Bot's answer to a live waiter is posted to the caller's group Session with
  `source.role === 'remote'`; an ordinary remote Bot post with no waiter keeps
  `source.role === 'post'` and `member: true`.
- After machine A changes a workgroup's name/notice/mode, machine B's `room` read reflects it and
  B's `workgroupStore` is refreshed from the existing `/api/bot/feed` `workgroup` event.
- Hub remains the only ordered source; no new table; `LATEST_VERSION` stays 7.
- `src/host/{groups,turns,delivery,resume,constants}.js` byte-identical; `git diff --name-only main
  -- ds-bot/src/host` lists only `memory.js`.
- `hub` tests, `ds-bot` tests, `--check` and `lint` pass; no manual gate is marked PASS.

---

## 2. Current Understanding

### 2.1 Current implementation

The workgroup domain lives in `ds-bot/src/workgroup/`. It installs once into the single runtime
(`ds-bot/src/workgroup/index.js`) and copies the original group chat's round machinery.

Five flows matter.

1. **Open.** A workgroup is a normal Session (`createWorkgroup` calls `rt.createSession`). The
   sidebar's `WorkgroupRow` calls `actions.openWorkgroup(id)`, which is
   `setSurface('bot')` + `openSession(id)`, so the user lands in the original conversation view and
   the original settings drawer. The domain's own `BotPanel` is registered under
   `WG_PANEL_KEY = 'workgroup-room'`; nothing selects that key in product code, so the panel is a
   diagnostic/test surface, not the path the user opens.
2. **Compose.** The real composer is the shell's. Its submit path calls the session controller's
   `session.prompt(...)` on the current Session (verified in the vendored DSH client), not the
   plugin's `actions.send`. `actions.send` is used by `new-chat.js` and `voice.js`, which both end at
   the original `/api/bot` `send` endpoint. That endpoint prompts the group's Session with a plain
   user message. The workgroup `send` endpoint does the same through `wg.postToSession`. `send-hub`
   sends to the Hub first and relies on `ack.ok` → `receiveRemote(mine)` → `postToSession` to start
   the round; it is called only by the unreachable `BotPanel`'s `Composer`.
3. **Round.** The group's own Session never consults the model. The `llm/stream` relay hook
   synthesizes `workgroup_relay`, whose tool reads `wg.roomInbox`, builds a round and runs
   `runRound`. The relay tool appends each queued user line to the local `room.log`, but it never
   calls `mirrorLine` for a user line. `mirrorLine` is called only by `postInRound` (a local Bot's
   answer) and `postToGroupSession` (a post into the group Session). A user's typed line therefore
   stays local.
4. **Cross-machine.** The Hub's `events.append` assigns `seq` in the same transaction and stores the
   `eventId`; `fanOut` writes `deliveries` and pushes to every live socket of every current member
   except the sending device. The receiving bridge applies events through `bridge.apply`, which calls
   `wg.receiveRemote`. A `call` becomes `receiveCall` → `runCall`; a Bot's line is appended to the
   local `room.log` and also posted into the group Session. A person's line is appended to
   `room.log` but **not** posted into the group Session: the existing comment assumes a person's
   chat is drawn from `user/message`, which is true only on the machine that typed it. On the
   colleague's machine there is no local `user/message`, so the line is invisible in the
   conversation view. This is the "colleague's messages are not live" symptom.
5. **Settings.** `updateWorkgroup` writes the local record, then calls
   `bridge.updateGroupSettings`, which calls `POST /v1/workgroups/:id/settings` with the room's
   `hubConfigVersion`. The Hub validates the version, bumps `config_version`, calls
   `membershipChanged({ workgroupId, kind: 'settings' })`, and returns
   `{ workgroupId, changed, workgroup }`. `bridge.onFrame` handles `member.changed` by calling
   `syncRoster`, which re-reads the whole group and passes name, notice, reply mode, permission and
   lead into `applyRoster`. `applyRoster` applies those before its "same roster" early return and
   saves with `kind: 'settings'`. The save publishes a `workgroup` feed event through
   `rt.workgroupStateSaved`, which `/api/bot/feed` forwards. The missing consumer is the original
   client: only `workgroup/client/panel.js` listens to that feed, and the panel is unreachable. The
   sidebar and settings drawer read `roster.roomsById`, which is rebuilt from `workgroupStore` only
   when `refreshWorkgroups()` runs. Nothing calls it on a remote settings event.

### 2.2 Modules involved

| Concern | Module |
|---|---|
| Sending one message | shell composer → `session.prompt`; `/api/bot` `send`; workgroup `send`; `send-hub` |
| User line mirroring | `ds-bot/src/workgroup/host/groups.js` (`workgroup_relay`, `postToSession`, `session/event`, `receiveRemote`, `mirrorLine`) |
| Round | `ds-bot/src/workgroup/host/groups.js` (`runRound`, `roomTurn`, `postInRound`, `postToGroupSession`, `receiveCall`, `runCall`) |
| Transport | `ds-bot/src/workgroup/host/bridge.js` (`send`, `flush`, `apply`, `onFrame`, `deliverRemote`, `member.changed`) |
| Hub storage | `hub/src/events/service.js` (append, pull, ack, unread), `hub/src/workgroups/service.js` (`EVENT_TYPES`, `READABLE_EVENT_TYPE`, settings CAS) |
| Hub socket | `hub/src/ws.js` (`handlers`, `fanOut`, `notifyMembership`, `sync.request`) |
| Workgroup route | `ds-bot/src/workgroup/host/channel.js` (`send`, `send-hub`, `room`, `update-room`, `state`) |
| Settings UI | `ds-bot/src/client/{details-drawer,settings}.js` choose the workgroup copy; `ds-bot/src/workgroup/client/group-settings.js` is that copy |
| Settings write routing | `ds-bot/src/client/index.js` (`updateRoom` split), `team-actions.js` (generic actions) |
| Live UI | `ds-bot/src/host/feed.js` (`workgroup` event), `ds-bot/src/workgroup/client/panel.js` (`listenLive`, EventSource + 5 s fallback), `ds-bot/src/client/sidebar.js` (product sidebar) |
| Roster projection | `ds-bot/src/client/sources.js` (`groupRooms`, `workgroupMembers`, `indexRoster`) |
| Session ownership | `ds-bot/src/workgroup/host/ownership.js` |

### 2.3 Call chains

**Real composer today**

```
shell composer submit
  -> session.prompt(sessionId = room id, content, mode)
  -> DSH Session event user/message (source kind "user")
  -> workgroup session/event listener queues into wg.roomInbox
  -> llm/stream relay hook synthesizes workgroup_relay
  -> workgroup_relay reads roomInbox, appends the user line to room.log
  -> runRound
```

The line is never mirrored to the Hub, so a colleague's machine sees nothing.

**Real composer after Step 1**

```
session.prompt -> user/message -> roomInbox -> workgroup_relay
  -> appendLine(room, user line)
  -> mirrorLine(room, line)          // bridge.send, one eventId, outbox
  -> Hub chat.message                 // seq, sender = this device's user
  -> fanOut to other devices
  -> sender ack.ok -> apply(mine:true) -> receiveRemote
  -> receiveRemote sees the room.log line with the same hubEventId
  -> returns false (already applied); no second prompt, no duplicate
```

**A line that crossed the Hub after Step 2**

```
bridge.apply -> wg.receiveRemote
  -> appendLine(room, line with via:"hub", hubEventId, hubSeq)
  -> person line:       postToGroupSession(role:"remote", no member flag)
  -> Bot line + waiter: postToGroupSession(role:"remote", no member flag)
  -> Bot line no waiter: postToGroupSession(role:"post", member:true)
  -> if exchangeId matches a remoteWaiter: resolve it; runRound calls callMembers
```

`role:"remote"` is the existing "draw it, never open a round" value in `cells.js` and in the relay
hook's `opens` predicate.

**The workgroup's existing Hub door (`send-hub`)**

```
callWorkgroup("send-hub") -> bridge.send -> Hub -> ack.ok
  -> apply(mine:true) -> receiveRemote
  -> appendLine(room, line) with hubEventId
  -> postToSession(room, text, { logged: room.seq })
  -> user/message -> roomInbox carries the logged seq
  -> relay skips appending the same line again; it uses the logged post as opener
```

This keeps the `send-hub` path and the real-composer path on one log line each.

**Settings**

```
settings form actions.updateRoom
  -> client index.js routes a workgroup id to callWorkgroup("update-room")
  -> wg.updateWorkgroup(roomId, patch)
  -> local room save
  -> bridge.updateGroupSettings({ configVersion, name, notice, mode, permission, lead })
  -> Hub updateSettings: version check, write, config_version + 1
  -> membershipChanged({ workgroupId, kind:"settings" })
  -> notifyMembership -> member.changed on every member socket
  -> bridge.syncRoster(hubWorkgroupId)
  -> wg.hub.workgroup() full read
  -> applyRoster(name, notice, replyMode, permission, lead, configVersion)
  -> wg.save({ kind:"settings" })
  -> rt.workgroupStateSaved -> /api/bot/feed event "workgroup" { kind:"settings" }
  -> sidebar's listenLive -> refreshWorkgroups()
  -> workgroupStore.set -> indexRoster -> roster.roomsById
  -> open conversation header/member list/settings drawer re-render
```

### 2.4 Confirmed impact

| Direction | Location | Why it matters |
|---|---|---|
| Direct | `ds-bot/src/workgroup/host/groups.js` | The real composer's user line is never mirrored; a remote person's line never enters the conversation; a matched Bot answer is also posted as an opener. |
| Direct | `ds-bot/src/workgroup/client/panel.js` | Owns the only existing feed subscriber; export it so the product sidebar can use the same one. |
| Direct | `ds-bot/src/client/sidebar.js` | Product surface that already reads `workgroups`; add the feed subscription that refreshes `workgroupStore`. |
| Associated | `ds-bot/src/client/index.js` | Already rebuilds `roster.roomsById` from `workgroupStore` on store changes; no new path needed once the store is refreshed. |
| Associated | `ds-bot/src/client/sources.js` | All original components read workgroup members through `byId`; the records already carry the right shape. |
| Associated | `ds-bot/src/client/details-drawer.js`, `settings.js` | Render the copied settings form for `room.workgroup === true`; they read `roster.roomsById`, so a store refresh is enough. |
| Associated | `ds-bot/src/workgroup/host/channel.js` | `send` and `send-hub` already exist; no new endpoint. |
| Associated | `ds-bot/src/workgroup/host/bridge.js` | `apply` is already the single ordered entry; `ack.ok` already has the `isChat` guard. No change. |
| Not changed | `ds-bot/src/host/{groups,turns,delivery,resume,constants}.js` | Frozen; local-group behaviour is the reference. |
| Not changed | `ds-bot/src/host/memory.js` | G6R work is already complete; this plan does not touch memory. |
| Not changed | `hub/src/**` | The Hub already has `seq`, dedup, deliveries, settings CAS and `member.changed`; the defect is the client consumer, not the server. |
| Not changed | `hub/src/db/migrations.js` | No new table; `LATEST_VERSION` stays 7. |
| Not changed | `ds-bot/src/workgroup/host/round-state.js` | The existing round projection is sufficient; no new slot field is needed for this plan. |

### 2.5 Contradictions found between requirement text and code

These are recorded so the plan does not silently broaden the requirement.

1. **"Real-time group chat does not work."** The Hub fan-out and the `/api/bot/feed` route work. The
   real gaps are (a) the real composer's user line is never mirrored, and (b) a remote person's line
   is appended to `room.log` but never written into the group Session, so the original conversation
   view cannot draw it. Both are in scope. "Nothing is live" is not accurate.
2. **"Only the admin Bot and the first member Bot ever work."** The copied round already has
   `openingSpeakers` / `callMembers`, and `runRound` already awaits a remote slot and continues from
   the answer's `@` mentions. The remaining defect is that a matched remote answer is also posted as
   a `role:"post"` opener, so the relay can start a second round. The hand-off algorithm is not
   missing; the duplicate opener is.
3. **"Group settings cannot update in real time, e.g. the nickname."** The Hub broadcast exists,
   `member.changed` re-reads the whole group, and `applyRoster` applies name/notice/mode/permission/
   lead. The missing piece is that the original client never refreshes `workgroupStore` from the
   `workgroup` feed event; only the unreachable `BotPanel` does. The host storage model is already
   correct.
4. **"Build a unified WSS mechanism."** A single authenticated WSS endpoint with one ordered event
   stream already exists: `bridge.apply` receives `event` and `sync.batch`; `ack.ok` has the chat
   guard; `memory.change` and task events have their own consumers. This plan adds no second socket
   and no second store. It only fixes the two consumers above the stream.
5. **The Mini Plan's Step 1 assumed `actions.send` is the real composer.** It is not. The shell
   composer calls `session.prompt` directly; `actions.send` is used by `new-chat.js` and `voice.js`.
   Routing `actions.send` would not fix the composer. This plan targets the
   `session/event`/`workgroup_relay` seam instead. The `send-hub` path is kept for the panel and for
   `createWorkgroup`'s first message, and is made duplicate-free with the `logged` marker.
6. **`docs/workgroup/progress-and-gaps.md` and `g5/ROUND-LOG.md` describe the composer as going
   through `send-hub`.** The real composer is the shell's `session.prompt`; `send-hub` is only used
   by the unreachable panel today. This plan records the discrepancy and fixes the actual path.

---

## 3. Implementation Steps

Each step is TDD: write the failing test, run it to see the failure, implement, re-run, then commit.
The snippets are the assertions to add; adapt fixture variable names (`machine`, `invitedPair`,
`roomOf`, `roomOfHubGroup`, `until`) to the surrounding file, but do not loosen an assertion.

### Step 1

#### Target

- File: `ds-bot/src/workgroup/host/groups.js`
- Functions:
  - `workgroup_relay` execute (the loop that appends queued posts to `room.log`)
  - `postToSession` (carry a `logged` marker on the user source)
  - the `session/event` `user/message` branch (carry `source.logged` into `roomInbox`)
  - `receiveRemote`'s `mine` branch (pass `logged: room.seq` to `postToSession`)
- Test: `ds-bot/test/workgroup-membership.test.js`

#### Current Behavior

The real composer's user message reaches the group's Session, the `session/event` listener queues it
in `wg.roomInbox`, and `workgroup_relay` appends it to `room.log`. The append site does not call
`mirrorLine`, so the Hub never receives the line; the colleague's machine has nothing to pull. The
`send-hub` path does append the line in `receiveRemote(mine)` and then calls `postToSession`, but the
subsequent relay appends the same text a second time because it has no marker saying "this line is
already logged".

#### Change

In the `workgroup_relay` execute loop that appends queued posts, capture the line and mirror a user
line after it is appended:

```js
const line = {
  ...(post.botId ? { who: post.name ?? 'Bot', memberId: post.botId } : { who: 'User' }),
  text,
  ...(post.files === undefined ? {} : { files: post.files }),
}
appendLine(room, line)
// A user's line is the one kind the relay appends but no later step mirrors. A member post
// is mirrored by `postInRound`/`postToGroupSession`; mirroring it again would duplicate it.
if (post.botId === undefined && post.hubEventId === undefined) {
  mirrorLine(room, room.log.at(-1))
}
```

`mirrorLine` sets `line.hubEventId` before it calls `bridge.send`, so the sender's later `ack.ok` →
`receiveRemote(mine)` finds the same `hubEventId` in `room.log` and returns false instead of drawing
the line twice.

In `postToSession`, carry the marker on the source:

```js
source: {
  kind: 'user',
  ...(extra.logged === undefined ? {} : { logged: extra.logged }),
},
```

In the `session/event` branch for `source?.kind === 'user'`, copy it into the queued item:

```js
queue({
  text: textOf(event.data?.content),
  ...(images.length > 0 ? { images } : {}),
  ...(files.length > 0 ? { files } : {}),
  ...(typeof source?.logged === 'number' ? { logged: source.logged } : {}),
})
```

In `receiveRemote`'s `mine` branch, pass the line's seq as the marker:

```js
await wg.postToSession?.(room, text, {
  ...(files.length === 0 ? {} : { files }),
  logged: room.seq,
})
```

The relay's existing `if (post.logged !== undefined) continue` then skips the duplicate append; the
post is still in the `posts` list, so it remains the round's opener. The relay's `startSeq` stays
`room.seq + 1`, which is after the line the sender already appended, so the line is not replayed as
part of the round's "this round so far" transcript on the sender's machine. Do not remove that skip
or change the opener selection.

#### Reason

The real composer's line is the only conversation line the Hub never receives. Mirroring it at the
one append site is the smallest change that makes the sender's line visible to every member. The
`logged` marker is the existing mechanism for a post that is already in the log; reusing it keeps the
`send-hub` path from producing a second copy.

#### Risk

- `mirrorLine` returns without sending when the bridge is offline. That is the existing documented
  limitation; this step does not add a second queue. A line typed offline remains local until a later
  outbox design, which is out of scope.
- `post.hubEventId` is a guard for a post that already carries Hub identity. The queued user item
  currently never has it, but the guard keeps a future replay from mirroring a remote user line.
- `post.logged` is a number (the room seq) or `true`. The relay's existing
  `if (post.logged !== undefined) continue` skips the duplicate append; `startSeq` remains
  `room.seq + 1`, so the already-logged line is not repeated in the new round's own transcript on
  the sender.
- The `session/event` listener is shared by local groups? No: it first checks
  `wg.sessionOwners.get(sessionId)`, so a local group Session is not touched.

#### Verification

- Failing product-path test in `ds-bot/test/workgroup-membership.test.js`:

```js
test('a line typed through the real group Session reaches the Hub and the colleague', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const room = alice.wg.roomOfHubGroup(workgroupId)
  const bobRoom = () => bob.wg.roomOfHubGroup(workgroupId)
  const text = '这条应该到同事那边'
  await alice.wg.postToSession(room, text)
  const emit = async (sessionId, event) => {
    for (const listener of alice.rt.ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  await emit(room.id, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
  const relay = alice.rt.ctx.registeredTools.get('workgroup_relay').execute(
    {}, { agent: { id: room.id }, callId: 'call-real-composer', signal: new AbortController().signal },
  )
  await until(() => (bobRoom()?.log ?? []).some(line => line.text === text), {
    label: 'the colleague to receive the real composer line',
  })
  assert.equal((alice.wg.workgroupOf(room.id).log ?? []).filter(line => line.text === text).length, 1,
    'the sender logs the line once')
  assert.equal((bobRoom()?.log ?? []).filter(line => line.text === text).length, 1,
    'the colleague logs the line once')
  await alice.wg.stopRound(room.id)
  await relay.catch(() => {})
})
```

- A second assertion in the same test or the next test must prove the line is also drawn in the
  colleague's group Session, not only in `room.log`:

```js
const shown = (bob.rt.ctx.followups ?? []).filter(entry => entry.sessionId === bobRoom().id
  && String(entry.message?.content?.[0]?.text ?? '').includes(text))
assert.equal(shown.length, 1, 'the colleague draws the line in the conversation once')
assert.equal(shown[0].message.source?.role, 'remote', 'and does not start a round for a person line')
```

This second assertion belongs to Step 2 and is expected to be RED after Step 1 only if the person
branch is still missing; keep it in the test so Step 2 makes it green.

- Run: `node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-membership.test.js`
- Expected: RED before the change (Bob's log has no line); GREEN after Step 1 for the log
  assertions, and the conversation assertion turns green in Step 2.

- [ ] Write the failing test.
- [ ] Run it; record the RED.
- [ ] Add the mirror call, the `logged` source field, the queue copy, and the `mine` marker.
- [ ] Re-run; the log assertions are GREEN.
- [ ] Commit: `fix(workgroup): mirror the real composer line to the Hub`.

### Step 2

#### Target

- File: `ds-bot/src/workgroup/host/groups.js`
- Function: `receiveRemote` (the display branch after `appendLine`)
- Test: `ds-bot/test/workgroup-membership.test.js`,
  `ds-bot/test-realtime/workgroup-realtime.test.js`

#### Current Behavior

`receiveRemote` appends a line to `room.log`, then:

- for `mine === true` (the sender's own `send-hub` line), calls `postToSession`;
- for a Bot line (`senderEndpointId !== undefined` or `member.kind === 'remoteBot'`), calls
  `postToGroupSession` with `role:"post"` and `member:true`;
- for a person's line, does nothing else.

Consequences:

- A remote person's line is invisible in the original conversation view: that view draws the group
  Session, and the line never entered it.
- A remote Bot's answer that matches a live `remoteWaiter` is posted as a `role:"post"` opener while
  `runRound` is already continuing the same slot. The relay can start a second round.

#### Change

Compute the displayed text once, so an attachment-only line is not dropped by
`postToGroupSession`'s `if (text === '') return`:

```js
const displayText = files.length === 0
  ? text
  : text === ''
    ? `[${files.map(file => file.name).join(', ')}]`
    : `${text}\n[${files.map(file => file.name).join(', ')}]`
```

Use `displayText` in the `appendLine` call instead of the inline expression.

Compute whether this Bot line closes a live slot:

```js
// A matched answer is the continuation the caller's round is already awaiting. The
// `remoteWaiters` entry is the proof: it was registered before the call went out and it is
// keyed by the same exchange the answer carries.
const closesSlot = fromBot
  && typeof payload.exchangeId === 'string' && payload.exchangeId !== ''
  && [...wg.roomProgress.values()].some(round => round.roomId === room.id
    && round.remoteWaiters?.has(payload.exchangeId))
```

Choose the display role:

```js
// A PERSON's line and a MATCHED Bot answer are display only. A person runs no turn, and a
// matched answer is already being continued by the caller's `runRound`; posting either as a
// `post` cue would ask the relay to open a second round for the same words. An ordinary Bot
// post with no waiter keeps `post` + `member: true`, which is the original member-opener rule.
const displayOnly = !fromBot || closesSlot
```

Replace the existing `else if` branch with:

```js
} else if (reconcile !== true) {
  await postToGroupSession(room, { id: memberId, name }, displayText, {
    remote: true,
    form: 'remote',
    role: displayOnly ? 'remote' : 'post',
    ...(displayOnly ? {} : { member: true }),
    ...(files.length === 0 ? {} : { files }),
  }).catch(error => rt.warn('ds-bot: line from %s not shown in %s: %s', name, room.name, error?.message ?? error))
}
```

Do not change the `mine` branch above it; it is the `send-hub` sender's own line and still calls
`postToSession` with the `logged` marker from Step 1. Do not change `runCall`; it is the called
machine's own turn and must still post its answer with the caller's exchange.

#### Reason

The original conversation view draws the group Session, not `room.log`. A remote person's line must
be written into that Session to be readable. A matched remote Bot answer is already the continuation
of the caller's round; posting it as a second opener is the duplicate-opener defect. `role:"remote"`
is the existing display-only role in both `cells.js` and the relay hook's `opens` predicate, so it
is not a new protocol value.

#### Risk

- An ordinary remote Bot post with no waiter must keep `role:"post"` and `member:true`; otherwise
  the next `@` hop stops. The `displayOnly` condition is false exactly in that case.
- A remote line can arrive before the caller re-registers `remoteWaiters` after a restart. That path
  goes through `reconcileRounds` with `reconcile: true`; `closesSlot` is only true while a live
  waiter exists, and the reconciler keeps its current behavior.
- `postToGroupSession` has `if (text === '') return`; passing `displayText` is what keeps an
  attachment-only line visible. Do not pass the raw `text`.
- The `memberId` for a person may be the Hub user id; `roster.byId` indexes the workgroup member
  records, so `cells.js` can resolve the name. If the roster has not arrived, the line falls back to
  `payload.senderName` or "A member"; that is existing behavior.

#### Verification

- Extend the Step 1 test with the `shown` assertions above. The first `shown` assertion is GREEN only
  after Step 2; before, it is RED because a person line is not posted into the group Session.
- Add a matched-Bot test in `ds-bot/test-realtime/workgroup-realtime.test.js` using the real
  cross-machine call path:

```js
test('a matched remote answer is displayed as remote, not as a second opener', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const room = roomOf(alice, workgroupId)
  const remote = room.members.find(member => member.name === 'BobChief')
  assert.ok(remote !== undefined)

  await alice.wg.postToSession(room, '@BobChief 你们那边接口定了吗？')
  const emit = async (sessionId, event) => {
    for (const listener of alice.rt.ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  await emit(room.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '@BobChief 你们那边接口定了吗？' }] } })
  const relay = alice.rt.ctx.registeredTools.get('workgroup_relay').execute(
    {}, { agent: { id: room.id }, callId: 'call-matched-answer', signal: new AbortController().signal },
  )
  const bobStart = async () => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const found = (bob.followups ?? []).find(entry => entry.message?.source?.role === 'room')
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error("Bob's Bot was not called")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const started = await bobStart()
  const answer = '定了，周四给第一版'
  const bobEmit = async (event) => {
    for (const listener of bob.rt.ctx.listeners.get('session/event') ?? []) await listener({ id: started.sessionId }, event)
  }
  await bobEmit({ type: 'turn/start', data: { turn: 1 } })
  await bobEmit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } })
  await bobEmit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })

  await until(() => alice.wg.workgroupOf(room.id).log.some(line => line.text === answer), {
    label: 'Alice to receive the answer',
  })
  const displayed = (alice.rt.ctx.followups ?? []).filter(entry => entry.sessionId === room.id
    && String(entry.message?.content?.[0]?.text ?? '').includes(answer))
  assert.equal(displayed.length, 1, 'the answer is displayed once')
  assert.equal(displayed[0].message.source?.role, 'remote', 'and does not open a second relay')
  await alice.wg.stopRound(room.id)
  await relay.catch(() => {})
})
```

- A regression test for the ordinary path in `ds-bot/test/workgroup-membership.test.js`:

```js
test('a remote member post with no matching slot stays an opener', async (t) => {
  const { alice, workgroupId } = await invitedPair(t)
  const room = alice.wg.roomOfHubGroup(workgroupId)
  const remote = room.members.find(member => member.name === 'BobChief')
  const before = (alice.rt.ctx.followups ?? []).length
  const shown = await alice.wg.receiveRemote({
    workgroupId,
    event: {
      eventId: 'evt_remote_opener_probe',
      seq: room.seq + 1,
      type: 'chat.message',
      sender: { userId: 'usr_bob', botEndpointId: remote.endpointId },
      payload: { text: '@Chief 麻烦看一下', senderName: remote.name, exchangeId: 'exchange-ordinary' },
    },
  })
  assert.equal(shown, true, 'the line is accepted')
  assert.equal((alice.rt.ctx.followups ?? []).length > before, true,
    'a member post that calls a member is still shown as a post in the group Session')
})
```

- Run: `node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-membership.test.js test-realtime/workgroup-realtime.test.js`
- Expected: the person line and matched-Bot tests are RED before Step 2 and GREEN after; the
  ordinary-path test is GREEN throughout.

- [ ] Write the tests.
- [ ] Run them; record the RED.
- [ ] Add `displayText`, `closesSlot`, `displayOnly`, and the `postToGroupSession` call.
- [ ] Re-run; PASS, including the existing `a Bot on the colleague's machine is called and its
      answer comes back`.
- [ ] Commit: `fix(workgroup): display a remote line without opening a second round`.

### Step 3

#### Target

- Files: `ds-bot/src/workgroup/client/panel.js`, `ds-bot/src/client/sidebar.js`
- Functions: `panel.js` `listenLive`; `sidebar.js` `TeamSidebar`
- Test: `ds-bot/test/workgroup-ux.test.js`,
  `ds-bot/test-realtime/workgroup-realtime.test.js`

#### Current Behavior

`panel.js` has a module-local `listenLive` that opens one `EventSource` on `/api/bot/feed` and
notifies its listeners on the `workgroup` event. Only `panel.js`'s `useLiveRoom` and
`useLiveMembers` use it, and that panel is unreachable. The product sidebar renders workgroup rows
from `workgroupStore` but only calls `refreshWorkgroups()` on mount and when
`workgroups.length` changes. The original conversation header, member list and settings drawer all
read `roster.roomsById`, which is rebuilt when `workgroupStore` changes. Nothing refreshes the store
on a remote `workgroup` feed event, so a rename/member change on another machine leaves those
surfaces stale.

#### Change

Export the existing subscriber rather than adding a second EventSource:

```js
// panel.js
export const listenLive = (fn) => {
  ...
}
```

In `sidebar.js`, import it with the existing `refreshWorkgroups` import:

```js
import { refreshWorkgroups, listenLive } from '../workgroup/client/panel.js'
```

Add an effect inside `TeamSidebar`, after the `workgroups` value is computed:

```js
const hasWorkgroups = workgroups.length > 0
useEffect(() => {
  if (!hasWorkgroups) return undefined
  return listenLive((payload) => {
    // The feed event is only a signal. `refreshWorkgroups` re-reads the list projection, and
    // the existing `workgroupStore` subscription in `src/client/index.js` rebuilds
    // `roster.roomsById`, which the open conversation and settings drawer already read.
    if (payload?.kind === 'settings' || payload?.kind === 'roster' || payload?.kind === 'message') {
      void refreshWorkgroups()
    }
  })
}, [hasWorkgroups])
```

Do not add a second `EventSource` and do not add a settings cache. Do not change
`workgroupStore`'s rebuild subscription in `src/client/index.js`; it already does the right thing
once the store value changes.

#### Reason

The Hub already broadcasts and the host already saves with `kind:"settings"`/`"roster"`/`"message"`.
The missing consumer is the product's own sidebar, which is mounted whenever the user is in Bot mode
and already owns the workgroup list. Reusing `listenLive` keeps one browser transport and one store.

#### Risk

- `TeamSidebar` is mounted in Bot mode; in Agent mode it is withdrawn, so no feed is opened there.
  The effect is gated on `hasWorkgroups`, so a team with no workgroups does not open an SSE.
- `refreshWorkgroups()` is a list read, not a room/log read; it is the same call the sidebar already
  makes on mount. A message event causes one extra list read; it does not fetch transcripts.
- The `workgroup` event is published from every workgroup save, including the sender's own. The
  refresh is idempotent and does not save anything, so it cannot loop.
- The panel's `useLiveRoom` remains for its own ChatPane; this step does not remove or duplicate it.

#### Verification

- Source assertions in `ds-bot/test/workgroup-ux.test.js` (`panelSrc`, `sidebarSrc` and
  `readFileSync` are already imported):

```js
test('the product sidebar consumes the workgroup feed and refreshes the shared store', () => {
  assert.match(panelSrc, /export const listenLive/, 'the existing subscriber is exported')
  assert.match(sidebarSrc, /listenLive/, 'the product sidebar subscribes to the same feed')
  assert.match(sidebarSrc, /refreshWorkgroups\(\)/, 'and re-reads the list projection')
  assert.match(sidebarSrc, /payload\?\.kind === 'settings'/, 'a settings signal is handled')
  assert.match(sidebarSrc, /hasWorkgroups/, 'a team with no workgroups opens no feed')
})
```

- Feed test in `ds-bot/test-realtime/workgroup-realtime.test.js` proving the host publishes a
  settings-kind event on the other machine:

```js
test('a settings save is published as a settings-kind workgroup feed event', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const abort = new AbortController()
  const response = await bob.routes['/api/bot/feed'].fetch(
    new Request('http://localhost/api/bot/feed', { signal: abort.signal }),
  )
  const next = reader(response)
  assert.equal((await next()).event, 'hello')
  const updated = await alice.call('update-room', {
    id: roomOf(alice, workgroupId).id,
    name: '实时设置',
  })
  assert.equal(updated.ok, true, JSON.stringify(updated.error))
  const deadline = Date.now() + 3000
  let changed
  while (Date.now() < deadline && changed === undefined) {
    const frame = await Promise.race([
      next(),
      new Promise(resolve => setTimeout(() => resolve(undefined), 150)),
    ])
    if (frame?.event === 'workgroup' && frame.data?.kind === 'settings') changed = frame
  }
  abort.abort()
  assert.ok(changed !== undefined, 'a settings save publishes a workgroup event')
  assert.equal(changed.data.workgroupId, workgroupId)
})
```

- The existing `a workgroup save is delivered by the existing live feed` must stay GREEN.
- Run: `node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-ux.test.js test-realtime/workgroup-realtime.test.js`
- Expected: the source test is RED before the export/subscription and GREEN after; the feed test is
  GREEN both before and after (the host already publishes it) and proves the signal the sidebar
  consumes.

- [ ] Write the source test and the feed test.
- [ ] Run them; record the RED for the source test.
- [ ] Export `listenLive` and add the sidebar effect.
- [ ] Re-run; PASS.
- [ ] Commit: `fix(workgroup): refresh the product sidebar from the workgroup feed`.

### Step 4

#### Target

- No production file changes.
- Tests: `ds-bot/test/workgroup-bridge.test.js`, `ds-bot/test/workgroup-memory-sync.test.js`,
  `ds-bot/test/workgroup-task.test.js`, `hub/test/ws-events.test.js`
- Module: WSS contract confirmation

#### Current Behavior

The WSS path is already one authenticated socket and one ordered event stream:

- `bridge.apply` is the single entry for `event` and `sync.batch`;
- `chat.message` goes to `receiveRemote`;
- `memory.change` goes to `onMemoryEvent`;
- `task.*`/`approval.*`/`artifact.*` go to `onTaskEvent`;
- `ack.ok` applies the sender's own chat line with `{ mine: true }` and leaves `memory.change`
  alone through the `isChat` guard;
- the Hub assigns `seq` and `eventId`, writes `deliveries`, and replays by cursor.

There is no second socket, store or protocol to build. This step exists to confirm that the two
consumers changed in Steps 1–2 do not disturb the other types.

#### Change

No production change. Run the existing suites and record their results. If a new regression is
needed, add it to `ds-bot/test/workgroup-bridge.test.js` only; do not refactor `bridge.js` for
style.

The contract to pin, using the existing `the ack for a memory change never draws an empty chat
line` test and the existing task/memory tests:

- a `memory.change` ack still never enters `receiveRemote`;
- a `chat.message` ack still applies exactly once on the sender;
- a `task.request` still travels through the outbox and reaches `onTaskEvent`;
- a duplicate Hub delivery still does not append a second line;
- `member.changed` still re-reads the roster.

#### Reason

The requirement's fourth point is a unified WSS mechanism. The mechanism exists; adding a
refactor would increase risk without changing a user-visible behavior. The correct deliverable is
evidence that the unified stream still routes each type to its existing consumer after the two
consumer fixes.

#### Risk

- If the Step 1/2 changes accidentally make `receiveRemote` consume a non-chat event, the memory and
  task tests catch it. Do not "fix" a failure by widening the chat branch.
- Do not add a new event type or a new Hub table to satisfy this step.

#### Verification

- `node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-bridge.test.js test/workgroup-memory-sync.test.js test/workgroup-task.test.js`
- `cd ../../hub && node --test "test/ws-events.test.js"`
- Expected: all PASS; the memory ack test, the task tests and the WSS fan-out/replay tests are
  unchanged and green.

- [ ] Run the three ds-bot files; record pass/fail.
- [ ] Run the Hub WSS file; record pass/fail.
- [ ] Do not change production code in this step.

### Step 5

#### Target

- Files: `ds-bot/client.js` (generated), `docs/workgroup/diff-manifest.md`
- Module: generated artifact and the fork's difference ledger

#### Current Behavior

`client.js` is generated from `src/client/`; a stale file fails `test/client-bundle.test.js`.
`docs/workgroup/diff-manifest.md` names every file this fork changed and already lists
`src/workgroup/host/groups.js`, `src/workgroup/client/panel.js`, `src/client/sidebar.js` and
`src/client/index.js`. The new behaviors must be described there.

#### Change

- Run `cd ds-bot && npm run build` after the client edits.
- Append one row per behavior to the manifest's existing differences table, following its current
  style:
  - the real composer's user line is mirrored to the Hub (`src/workgroup/host/groups.js`);
  - a remote person's line is written into the group Session as `role:"remote"`
    (`src/workgroup/host/groups.js`);
  - a matched remote Bot answer is display-only, not a second opener
    (`src/workgroup/host/groups.js`);
  - the product sidebar consumes the existing `workgroup` feed and refreshes `workgroupStore`
    (`src/workgroup/client/panel.js`, `src/client/sidebar.js`).
- Do not add a file row unless a file is actually created; this plan creates none.
- Do not add a Hub row; this plan does not change the Hub.

#### Reason

`client.js` is a checked-in build artifact. The diff manifest is part of the G1 gate and must stay
accurate; a behavior change without a manifest row is a gate failure.

#### Risk

- A different esbuild version can produce a byte-different bundle; use
  `node scripts/build-client.mjs --check` as the test, not a hand diff.
- Keep the manifest factual; do not claim a new original-file change or a Hub change.

#### Verification

- `cd ds-bot && npm run build && node scripts/build-client.mjs --check` → exit 0.
- `git diff --check` → exit 0.
- The manifest names each changed behavior.

- [ ] Run the build.
- [ ] Update the manifest.
- [ ] Re-run `--check`.
- [ ] Commit: `docs(workgroup): record realtime line and settings refresh fixes`.

---

## 4. Changed Files Tracking

| File | Action | Reason |
| ---- | ------ | ------ |
| `ds-bot/src/workgroup/host/groups.js` | Modify | Mirror a real-composer user line to the Hub; carry the `logged` marker through `postToSession`/`session/event`/`receiveRemote(mine)`; write a person line and a matched remote Bot answer into the group Session as display-only `remote`; keep an ordinary remote Bot post as `post` + `member` |
| `ds-bot/src/workgroup/client/panel.js` | Modify | Export the existing `listenLive` so the product sidebar reuses the one feed subscription |
| `ds-bot/src/client/sidebar.js` | Modify | Subscribe to the existing `workgroup` feed while workgroups exist and refresh `workgroupStore`; the existing store subscription rebuilds `roster.roomsById` |
| `ds-bot/client.js` | Modify | Regenerated from `src/client` by `npm run build` |
| `docs/workgroup/diff-manifest.md` | Modify | Record the mirrored user line, display-only remote lines, the sidebar feed consumer, and the `listenLive` export |
| `ds-bot/test/workgroup-membership.test.js` | Modify | New product-path tests: real-composer line reaches the Hub and colleague; person line is drawn as `remote`; ordinary remote Bot post stays an opener |
| `ds-bot/test-realtime/workgroup-realtime.test.js` | Modify | New settings-kind feed event test |
| `ds-bot/test/workgroup-ux.test.js` | Modify | New structural contract for the product sidebar consuming the workgroup feed |

Actual final diff of this round: 7 files (the plan document is untracked and is not counted).
No production file outside the table was touched. `ds-bot/src/workgroup/host/bridge.js`,
`ds-bot/src/workgroup/host/channel.js`, `ds-bot/src/client/index.js` and all `hub/src/**` files were
already modified by the earlier G6R baseline and were **not** touched by this plan.

Files that must **not** appear in this round's diff:

- `ds-bot/src/host/groups.js`
- `ds-bot/src/host/turns.js`
- `ds-bot/src/host/delivery.js`
- `ds-bot/src/host/resume.js`
- `ds-bot/src/host/constants.js`
- `ds-bot/src/host/memory.js`
- `hub/src/db/migrations.js`
- any new `hub/src/**` store
- a new first-level directory

## 5. Verification Checklist

### Main flow

- [ ] A line typed through `postToSession`/the real composer is in the sender's `room.log` once and
      on the Hub once; the colleague's `room.log` has it once.
- [ ] The colleague's group Session receives the person line exactly once with
      `source.role === "remote"`; the conversation view can draw it.
- [ ] A remote Bot's answer to a live `exchangeId` is shown with `source.role === "remote"` and
      closes the slot; the next named speaker is called in the same round.
- [ ] An ordinary remote Bot post with no waiter keeps `source.role === "post"` and
      `member: true`; its `@Name` still calls the next member.
- [ ] A settings change on machine A is visible on machine B's product `room` read (name, notice,
      mode, permission, admin/lead) without a manual sync.
- [ ] B's `workgroupStore` is refreshed by the `workgroup` feed event, and the open conversation
      header, member list and settings drawer re-render.

### Associated flows

- [ ] Original local groups: send, `@`, Stop, settings, delete are unchanged.
- [ ] `memory.change` still goes only to the memory adapter; the ack never becomes a chat line.
- [ ] `task.request` / `task.report` still go through the outbox and the task runner.
- [ ] `member.changed` still re-reads the roster; joining and leaving still work.
- [ ] A workgroup without a Hub identity still uses the local `send` path and does not mirror.
- [ ] A Bot renamed or republished still appears with its published name and owner tag.

### Edge cases

- [ ] Hub offline: a real-composer line is still local; `mirrorLine` returns without sending. This
      is the documented limitation; the plan does not claim a backfill.
- [ ] `send-hub` on a live socket: `receiveRemote(mine)` logs the line once, passes `logged`, and the
      relay does not append a second copy.
- [ ] A duplicate Hub delivery does not open a second round.
- [ ] A late answer for a stopped round is logged once and never reopens the round.
- [ ] A recovered slot with a matching Hub answer is closed by reconciliation, once, without a new
      relay.
- [ ] Deleting a workgroup archives its memory and sessions and removes its round records.
- [ ] A person line with only an attachment carries its file name into the display text and is not
      dropped by `postToGroupSession`'s empty-text guard.

### Test

- [ ] `cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-membership.test.js test-realtime/workgroup-realtime.test.js test/workgroup-ux.test.js test/workgroup-bridge.test.js test/workgroup-memory-sync.test.js test/workgroup-task.test.js test/workgroup-round.test.js`
- [ ] `cd ds-bot && npm test` → record total, pass, skip, fail; the existing Windows trailing-space
      skip is expected.
- [ ] `cd hub && npm test` → record total, pass, fail.

### Build

- [ ] `cd ds-bot && npm run build`
- [ ] `cd ds-bot && node scripts/build-client.mjs --check` → exit 0
- [ ] `git diff --check` → exit 0

### Lint

- [ ] `cd ds-bot && npm run lint` → 0 errors; record the warning count (13 at baseline).

### Typecheck

- [ ] The project has no `typecheck` script; state that explicitly rather than inventing one. Lint
      plus the test suites are the substitute, as recorded in the existing plan.

### Frozen files

- [ ] `git diff --name-only main -- ds-bot/src/host` → only `ds-bot/src/host/memory.js` (the
      pre-existing G6R baseline), never one of the five frozen files.
- [ ] `git diff --name-only main -- 'ds-bot/src/host/{groups,turns,delivery,resume,constants}.js'`
      → empty.
- [ ] `git diff --name-only main -- hub/src/db/migrations.js` → empty.
- [ ] `git diff --name-only main -- hub/src` → empty for this plan (the pre-existing G6R baseline
      files are already on the branch and are not part of these steps).

### Manual (remain BLOCKED)

- [ ] G4-1, G4-5, G4-6, G4-T20, G5-T12, G5-N3, G5-T14, G6-M1 stay **BLOCKED** until a maintainer
      runs them on real machines with screenshots/logs. Do not mark them PASS from a test.

---

## 6. Execution Log

### Step 1 Completed

Modified:

- `ds-bot/src/workgroup/host/groups.js`
- `ds-bot/test/workgroup-membership.test.js`

Changes:

- The relay's append site mirrors a user line with the existing `mirrorLine`.
- `postToSession` carries `logged`; the `session/event` listener copies it into `roomInbox`; the
  `send-hub` sender branch passes `receiveRemote`'s line seq, so a line is logged once.

Reason:

- The real composer is the shell's `session.prompt`, not `actions.send`. Its line reached
  `room.log` and never the Hub.

Verification:

- New test RED by 8.78s timeout, GREEN at 851ms after the change.
- `test/workgroup-membership.test.js`: 29/29 pass.

### Step 2 Completed

Modified:

- `ds-bot/src/workgroup/host/groups.js`
- `ds-bot/test/workgroup-membership.test.js`

Changes:

- A person line and a matched remote Bot answer are posted into the group Session as
  `role: "remote"` and start no round.
- An ordinary remote Bot post keeps `role: "post"` + `member: true`, so its `@Name` still calls the
  next speaker.
- Display text is computed once so an attachment-only line is not dropped.

Reason:

- The conversation view draws the group Session, not `room.log`. A person line was never written
  there; a matched answer was also posted as a second opener.

Verification:

- New person-display test, new ordinary-opener test, and the existing cross-machine call test all
  pass.
- `test/workgroup-membership.test.js`: 31/31 pass; `test-realtime/workgroup-realtime.test.js`:
  15/15 pass at that point.

### Step 3 Completed

Modified:

- `ds-bot/src/workgroup/client/panel.js`
- `ds-bot/src/client/sidebar.js`
- `ds-bot/test/workgroup-ux.test.js`
- `ds-bot/test-realtime/workgroup-realtime.test.js`

Changes:

- The existing `listenLive` is exported, not duplicated.
- `TeamSidebar` subscribes while workgroups exist and refreshes `workgroupStore` on
  `settings`/`roster`/`message` signals.

Reason:

- The host already publishes `workgroup` feed events. Only the unreachable panel consumed them;
  the product sidebar and the open settings surfaces did not.

Verification:

- `test/workgroup-ux.test.js` 23/23 pass.
- `test/workgroup-sidebar.test.js` and the realtime feed tests pass.
- `test-realtime/workgroup-realtime.test.js`: 16/16 pass, including the new settings-kind event.

### Step 4 Completed

Modified:

- No production file.

Changes:

- No production change. Confirmed the unified WSS consumer table already exists and the Step 1/2
  changes did not disturb it.

Reason:

- The requirement asks for a unified WSS mechanism; the Hub and bridge already provide one ordered
  stream with per-type consumers. Refactoring it would add risk without a behavior change.

Verification:

- `workgroup-bridge.test.js` + `workgroup-memory-sync.test.js` + `workgroup-task.test.js`:
  84/84 pass.
- Hub `test/ws-events.test.js`: 25/25 pass.

### Step 5 Completed

Modified:

- `ds-bot/client.js`
- `docs/workgroup/diff-manifest.md`

Changes:

- Regenerated the bundle from `src/client`.
- Recorded the mirrored user line, display-only remote lines, and the sidebar feed consumer in the
  fork's difference ledger.

Reason:

- `client.js` is a checked-in build artifact; the manifest is part of the G1 gate.

Verification:

- `npm run build` and `node scripts/build-client.mjs --check` exit 0.
- `git diff --check` exit 0.

## 7. Plan Adjustment

No adjustment was needed. The code investigation correction (the real composer prompts the Session
directly; it does not call `actions.send`) was made in the plan itself before Coding started.

### Finding during verification (no scope change)

`ds-bot/test/files.test.js` has a timing budget (`Date.now() - started < 40`). It failed once in a
parallel full run under load and passed alone and in the final full run. This is the pre-existing
timing-sensitive test, not a product failure from these steps; it is recorded here rather than
"fixed" by widening the budget, which would be an unrelated change.

## 8. Final Result

- Changed 7 tracked files (plus this untracked plan document).
- `ds-bot` full suite: **1233 tests / 1232 pass / 1 skip / 0 fail**.
- `hub` full suite: **270 tests / 270 pass / 0 fail**.
- `--check` exit 0; `npm run lint` **0 errors / 13 warnings**; `git diff --check` exit 0.
- Frozen `src/host/{groups,turns,delivery,resume,constants}.js`: no diff.
- Manual gates remain **BLOCKED**.
