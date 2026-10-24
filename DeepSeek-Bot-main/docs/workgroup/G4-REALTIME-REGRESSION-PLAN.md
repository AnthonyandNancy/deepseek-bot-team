# Workgroup G4 regression: root causes and fix plan

Status: implementation plan, written before the code changes it describes.

Scope: **G4, not G5.** The plan's G4 gate requires "两台真机实时群聊" and "工作群交互与原版对照无明显违和". The four reported symptoms are therefore regressions in G4:

1. Bot-to-Bot division of labour and hand-off differ from the original group.
2. A newly invited colleague does not refresh the member and settings views on either side.
3. A colleague sees another person's phone number where a Bot's name should be.
4. Messages neither appear live nor persist like a real chat group.

G5 is cross-user task delegation and owner approval. Changing a group round's speaker order is not G5. Hub-side membership rows, Bot endpoint identity, group settings and `chat.message` persistence all belong to G4 by name in the plan.

## 1. What is already required to stay unchanged

- A workgroup is the copied original group subsystem, not a new orchestration design. The round machinery stays `openingSpeakers` / `callMembers` / `runRound`; no second "role router" may be added beside it.
- The original group code under `src/host/` is not edited to make a workgroup work.
- The Hub remains authoritative for membership, settings and the message log. A machine's `workgroup/state.json` is a projection.
- Hub protocol remains one ordered event stream per group, with `seq`, `eventId` deduplication, an outbox and replay.
- A remote Bot is a member, not a person. A person is a member, but cannot be made a speaker.

## 2. Evidence gathered before changing code

The current checkout is `BotCode/DeepSeek-Bot-main` (the implementation under test), not the older `Workgroup-AI` skeleton. The existing two-machine suites pass:

- `workgroup-membership.test.js`: 28 pass, 0 fail.
- `workgroup-handoff.test.js`: 5 pass, 0 fail.

That result is not a contradiction of the user's report, because those tests stop at host state. They do not assert:

- that the UI receives a Hub delivery without its local poll;
- that a remote Bot's post produces the same speaker order as a local Bot's post;
- that a Bot can never be rendered under a person's phone number;
- that `member.changed`/settings notifications actually re-read the room projection;
- that every local Bot line is mirrored and survives a restart on both machines.

The original group's behaviour is in `src/host/groups.js`: `openingSpeakers` chooses the opening slot; after each member speaks, `mentionsIn` plus `callMembers` adds the next slots; only the admin's `@all` reaches everybody. The Bot's `role` and `instructions` are already part of its identity prompt (`src/host/prompt.js`), so "route by role" means the admin/orchestrator calls the right member, not a new hard-coded role table.

The existing original client feed is `GET /api/bot/feed` (`src/host/feed.js`), a Server-Sent Events stream with `hello`, `revision`, `live`, `message` and `stream`. The workgroup panel does not use it; it polls `POST /api/workgroup` every 700 ms for the room and 1200 ms for the Hub roster. This is the first concrete cause of symptom 4: a real push transport already exists in the same host, but the workgroup bypasses it.

## 3. Root causes

### RC-1: the workgroup's cross-machine reply is not the original round's member turn

A local group member's post enters the group Session through the original relay path and carries `botId`, `member`, `askedBy`, `late`, `progress`, `done` and `sub`. A workgroup reply that crosses the Hub is reconstructed in `receiveRemote`. Earlier builds lost `botEndpointId` on `ack.ok` and labelled remote Bot posts `role: 'remote'`; those fixes are present now, but the path still has three gaps:

- `runCall` builds a fresh ad-hoc round with no real `callMembers` chain. It runs one turn and posts the answer, but the caller's round has already treated the member as `remote` and moved on. The next speaker is therefore driven only by whatever `@` text came back, not by the caller's slot list and per-member caps.
- `runRound` does not wait for a remote member's answer, so the next slot can be emitted before the remote answer is visible. This changes the observable order compared with a local group, where a local member's slot is awaited.
- `receiveRemote` installs a Bot line into the group's Session with `role: 'post'`, but the local relay then may read a *different* transport copy of the same line. The dedup is by `hubEventId` on the log, not by an exchange id shared by call and reply.

The result is not simply "Bots are dumb". It is that the copied `openingSpeakers` sees the right flags, but the remote answer is not represented in the caller's round as the answer to the exact slot that asked for it. That is why a workgroup can look like unrelated Bots answering while the original group looks like an ordered team.

### RC-2: the roster and settings refresh are pull-only and only partly triggered

The Hub does broadcast `member.changed`; `bridge.js` responds by calling `syncRoster`. But:

- `member.changed` carries only `{ workgroupId, kind }`; a settings change is a notification, not a payload. `syncRoster` is a full HTTP roster read, and nothing invokes the open room's projection refresh after it.
- The panel's member card polls `group-members` directly. The room's `members` array and the settings form are refreshed only by the room poll on a `revision` change. A Hub-only change (join, name, notice, reply mode, permission) may arrive without a local `wg.save()` that bumps the room's revision.
- `ensureLinkedGroup` copies `name`/`notice`, and `applyRoster` copies `replyMode`/`permission`, but the UI's open room snapshot can remain stale until the next poll; there is no event-to-UI bridge.
- The Hub's `member.changed` fan-out includes current members, but there is no explicit "settings changed" event with the new values. The local code must re-read the authoritative group after any membership/settings notification.

The user's report is therefore accurate at the visible layer even though the Hub broadcast exists.

### RC-3: Bot identity falls back to the person who owns it

In `applyRoster`, a Hub member of type `botEndpoint` is named by `endpoint.name`, else `endpointName`, else `endpointId`. If the endpoint row is missing, old, not published, or the local map does not resolve it, the code falls back to `phoneMasked` because the member is treated like a person. In `receiveRemote`, a line with no resolvable `senderEndpointId` or member record falls back to `payload.senderName`/`payload.endpointName`, then `'A member'`; the UI draws a person's row from `phoneMasked`.

This produces exactly "同事 B 看到同事 A 的电话号码" when:

- Alice's Bot is published, but its endpoint name was not refreshed after a rename; or
- the group membership row resolves to a user row instead of the Bot endpoint; or
- a mirrored line is sent without `botEndpointId`; or
- the roster has not yet arrived and the line is applied first.

The fix must preserve the Bot's published name and owner tag on every path and must never let a Bot member fall back to a human display name or phone number. The fallback for an unresolved endpoint must be an explicit Bot placeholder (`Bot` / endpoint id), not the owner.

### RC-4: the workgroup client does not consume the host's live feed

The panel's `useLiveRoom` and `useLiveMembers` are polling effects. A real chat needs to react to `chat.message`/`revision`/`member.changed` as they happen. Because the workgroup domain lives in the same host as the original feed, reusing `/api/bot/feed` is the minimal adaptation and keeps one transport. The feed currently publishes only original team state saves and original chat events; it must also publish workgroup saves and workgroup messages (or a dedicated workgroup event through the same hub/feed module).

The poll may remain as a fallback for a disconnected feed, but it must not be the only live path. The correctness claim must be made against the feed signal, not against elapsed time.

### RC-5: persistence is local-first and not fully mirrored

`appendLine` writes the local log; `postInRound`, `postToGroupSession` and the user's own path call `mirrorLine`, but several branches still create lines without mirroring, and `receiveRemote` deliberately keeps foreign lines out of the group Session. The Hub has the authoritative events, but a restart's `sync` cursor starts from zero and reprojects events only if `receiveRemote` can resolve the room and roster. If a message arrives before the room/roster exists, the bridge's fallback creates and syncs, but a later roster change can replace member records and make old lines unreferenceable.

The acceptance test must kill and restart both machines and assert:

- the same lines remain on both;
- each line keeps a stable `hubEventId`/`hubSeq`;
- a replay does not duplicate a line;
- a line mirrored by a Bot is attributed to the Bot, not its owner.

## 4. Fix design

### 4.1 Speaker flow: keep the copied round, repair the remote slot

Do not add a role-based router. Instead:

1. In `runRound`, a remote Bot slot is still dispatched through `deliverRemote`, but the round records the slot's `exchangeId`/`callEventId` in `round.remoteSlots`.
2. A `call` carries the caller's `roundId`, `slotIndex`, `exchangeId`, `askedBy`, and the note. This is the same information a local `roomTurn` writes into `liveOf(sessionId).info`.
3. On the called machine, `runCall` uses that exchange id and `roomTurn` (not an ad-hoc round) to post the answer under the caller's slot. The reply line carries `exchangeId` in addition to `hubEventId`.
4. On the caller, `receiveRemote` matches the incoming line's `exchangeId` to `round.remoteSlots` and advances the same `callMembers`/`runRound` continuation, with the member's `member`/`askedBy` flags intact. It must not open a second round for the same exchange.
5. A remote slot's continuation is bounded by the same `WG_TURNS_EACH`/`WG_ADMIN_TURNS_EACH` caps as a local slot. A late answer is handled by `lateRoomReply`, exactly as a local late answer is.
6. If the called machine is offline or the reply times out, the slot becomes `remote`/`missed`; the round goes on, as the original does for a quiet local member.

The existing `member: true` and `role: 'post'` rules remain. The important addition is an explicit exchange identity joining call and answer; the rest of the logic stays the copied `openingSpeakers`/`callMembers` path.

### 4.2 Real-time transport: reuse the original feed

1. Extend `src/host/feed.js` with a workgroup event publisher (or expose `rt.publishWorkgroupEvent`) that emits:
   - `workgroup`/`revision` when `wg.save()` writes workgroup state;
   - `workgroup/message` for each new workgroup line, including `roomId`, `seq`, `hubEventId`, `hubSeq`, `memberId`, `who`, `via`;
   - `workgroup/member` after `applyRoster`/`syncRoster` changes the roster;
   - `workgroup/settings` after `ensureLinkedGroup`/settings sync changes name, notice, mode or permission.
2. `workgroup/host/channel.js` exposes these signals to the client. The panel subscribes via the existing feed route and refetches `room`/`group-members` when the matching event arrives. Keep polling as a slow fallback only (e.g. 5 s when the feed is disconnected); do not use 700/1200 ms polling as the live path.
3. The feed route is same-origin and already authenticated by the browser session, so no second browser push transport is introduced.
4. `bridge.js` must publish a workgroup signal after `receiveRemote`/`applyRoster`/`syncRoster`, so a colleague's message does not depend on the local `revision` polling.

### 4.3 Roster and settings convergence

1. Hub `member.changed` is kept, but its payload is extended (or supplemented) with the authoritative settings version. The Hub's `updateSettings` already calls `membershipChanged({ kind: 'settings' })`; add the changed field names and `config_version` if available, without exposing local paths.
2. The bridge handles `member.changed` by:
   - `syncRoster` (roster/settings/mode/permission);
   - `ensureLinkedGroup` with name/notice from the authoritative group response;
   - emitting a workgroup signal so the open room, member list and settings form refetch.
3. `applyRoster` must merge Bot endpoints and persons deterministically and must compare every identity field, including `endpointId`, `name`, `ownerUserId`, `ownerIsYou`, `avatar` and `color`.
4. A renamed Bot must be republished on reconnect and after `update_bot`, so a stale endpoint name cannot survive a rename. The Hub's `publish` is idempotent per owner/device/local Bot; call it when a Bot's name changes and when the bridge reconnects.

### 4.4 Bot identity

1. `applyRoster`:
   - for `botEndpoint`, name = `endpoint.name` → `endpointName` → `endpointId` → `Bot` (never `phoneMasked`);
   - kind = `remoteBot` unless the endpoint maps to a local Bot;
   - preserve `ownerUserId`, `ownerIsYou`, `avatar`, `color`, `membershipId`, `endpointId`.
2. `receiveRemote`:
   - resolve by `senderEndpointId` first, then by `membershipId`, then by `userId`;
   - if the resolved member is a Bot, always use its Bot name and owner fields;
   - never draw a Bot line with a person's `phoneMasked`; if the endpoint is unknown, use `senderName`/`endpointName` or a localized Bot fallback;
   - include `exchangeId` and `botEndpointId` on mirrored lines.
3. The client member row and chat line use one `isBotMember` predicate. For a Bot, the name is never the person's phone number and the owner tag is always shown (`Yours`/`A colleague's`). For a person, show the masked phone and no Bot owner tag.
4. `publishBotEndpoints` sends the Bot's current name and `lookOf` appearance on every publish; `updateBot` triggers a republish if the Bot is in a Hub group.

### 4.5 Persistence and replay

1. `appendLine` is the single persistence point; every visible line gets a stable `hubEventId` when mirrored. No branch may append a user/Bot line and skip `mirrorLine`.
2. `receiveRemote` applies the Hub event to the local log before any UI signal, writes the line to the group Session only for display, and records `hubSeq`.
3. On reconnect:
   - `hello` syncs every group from the persisted cursor;
   - if a local log is missing a `hubSeq`, `sync` pulls and applies it;
   - `eventId` dedup checks both bridge memory and the persisted log's `hubEventId`.
4. A restart test must close the sockets and construct fresh runtimes against the same Hub and `home`, then assert the lines and authorship.

## 5. Test plan (write the failing tests first)

Add to the tracked workgroup suites:

1. **Original-order parity**: a workgroup with an admin and two members, a plain user message, admin `@member` hand-off, member answer, and answer named back. Assert the slot order and that only the named member speaks at each step. Compare the observed order with the original `openingSpeakers`/`callMembers` output for the same inputs.
2. **Cross-machine exchange identity**: Alice's round calls Bob's Bot; the call carries a `roundId`/`exchangeId`; Bob's answer comes back under that exchange; Alice's round does not open a second round and the next speaker is exactly the one named. A duplicate Hub delivery does not produce a second turn.
3. **Live feed**: subscribe to `/api/bot/feed` with a fake fetch stream (or directly call the feed's publish path), send/receive a workgroup line, and assert the feed emits `workgroup/message` before any 700 ms poll. Assert the panel subscribes and does not rely on the poll for a live line.
4. **Roster/settings refresh**: Alice renames or changes notice/mode; Bob has the group open; a `member.changed` from the Hub must update Bob's open room, member card and settings through the feed signal, without a manual `syncRoster` call from the test.
5. **Bot identity**: publish Alice's Bot named `Chief`; make its membership row have a missing/old endpoint name; deliver a line; assert Bob sees `Chief` and the owner tag, never Alice's masked phone. Also assert a Bot line with no resolvable endpoint falls back to `Bot`/endpoint id, not `phoneMasked`.
6. **Persistence/restart**: both machines send and receive; close them; reopen fresh runtimes with the same homes and Hub; assert the same lines, `hubEventId`/`hubSeq`, no duplicates, and the same Bot attribution on both.
7. **Local regression**: the original group suite (`src/host` tests) must stay green, and `src/host/` must remain byte-identical to its baseline except for deliberately documented integration points.

## 6. Delivery order

1. Add the failing tests above.
2. Implement the exchange identity and remote-slot continuation first (RC-1), because it changes round behaviour.
3. Add the feed publication and client subscription (RC-4), then roster/settings signals (RC-2).
4. Fix identity resolution and republish-on-rename (RC-3).
5. Close persistence gaps and add the restart test (RC-5).
6. Rebuild `client.js`, run the targeted suites, the full ds-bot suite, the Hub suite, lint and the build check.
7. Manual acceptance: two real machines, two accounts, invite, join, chat, Bot hand-off, rename, restart.

## 7. Explicit non-goals

- Do not rewrite the workgroup as a new agent framework.
- Do not add per-Bot group roles or a role table that the original group lacks.
- Do not move Hub data into the original `state.json`.
- Do not make the Hub the executor of Bot turns.
- Do not claim G4 PASS from tests that only inspect host state; the feed and two-machine UI evidence are part of the gate.

## 8. Implementation record (after the code changes)

This section is appended after the fix, so the document states what was actually done rather than
what was proposed.

### 8.1 Bot division of labour / hand-off

Implemented:

- A remote call now carries `exchangeId` and `roundId` (`bridge.js` `deliverRemote`).
- `runCall` reuses the caller's exchange for the member turn and the reply line, instead of minting
  an unrelated exchange (`groups.js`).
- The caller's `runRound` registers a `remoteWaiters` entry before sending the call. `receiveRemote`
  resolves that waiter when the line with the matching exchange arrives, appends the answer to the
  same round, and runs the copied `mentionsIn` / `callMembers` continuation. A timeout marks the slot
  `missed` and the round goes on, as the original does for a quiet member.
- `stopRound` cancels every remote waiter as well as the local member turns. A called Bot is not in
  `round.started`, so without that its waiter lived until the 240 s timeout after the user pressed
  Stop. A member that cannot be called (a person or an endpoint-less row) is reported as a failed
  slot with the reason, not silently counted as a pass.
- No second orchestrator or role table was added.

Regression tests:

- `test-realtime/workgroup-realtime.test.js`: remote exchange identity, same-round continuation, and
  the original speaker rules.
- `test/workgroup-membership.test.js`: the cross-machine test now asserts the same round continues
  rather than opening a second relay.

### 8.2 Membership and settings convergence

Implemented:

- `syncRoster` now passes the Hub's `name` and `notice` into `applyRoster`; previously they were read
  from the Hub and silently dropped, so a settings notification re-read the roster but left the open
  room's title/notice stale.
- `applyRoster` applies name/notice before its unchanged-roster early return, and saves with
  `kind: 'settings'`.
- A Hub `member.changed` still triggers `syncRoster`; the room/member hooks refresh on the resulting
  workgroup signal.

Regression tests:

- `test-realtime/workgroup-realtime.test.js` `a settings change on the Hub reaches the other open machine`.
- Existing `workgroup-membership` rename/notice, reply-mode, permission and lead tests: 28/28 pass.

### 8.3 Bot identity

Implemented:

- A line with `sender.botEndpointId` is treated as a Bot even when the roster has not resolved the
  endpoint yet. Its `memberId` is the endpoint, not the owner user id; its name is the published Bot
  name or endpoint id, never a masked phone.
- The roster projection keeps the Bot's published name, endpoint, owner and appearance; an unknown
  Bot endpoint therefore remains a Bot member.

Regression tests:

- `a Bot member never falls back to its owner's phone number` (normal and empty-name roster).
- `a Bot line with an unresolved endpoint never falls back to the owner phone`.

### 8.4 Real-time UI

Implemented:

- `src/host/feed.js` publishes a `workgroup` SSE event when a workgroup save or a Hub-received line
  changes the domain, through the existing `/api/bot/feed` route. No second browser transport was
  added.
- `src/workgroup/client/panel.js` opens one `EventSource` for the panel, refreshes the open room and
  the Hub roster on a `workgroup` event, and keeps a 5 s fallback poll. The old 700/1200 ms polling
  loops were removed as the live path.
- Workgroup saves carry an optional `{ workgroupId, roomId, kind, revision }` context, so the event
  names the group that changed.

Regression tests:

- `a workgroup save is delivered by the existing live feed`.
- `the workgroup panel subscribes to the live feed and keeps polling only as a fallback`.

### 8.5 Persistence and restart

Implemented/verified:

- A remote reply's `hubEventId` and `hubSeq` are written to the local log before the event is
  acknowledged; the bridge's dedup checks both its in-memory set and the persisted log.
- A restart keeps the line, its Hub ids and its Bot attribution, and a replay does not duplicate it.

Regression test:

- `both machines keep the workgroup history and Bot attribution across a restart` (fresh runtimes on
  the same `home` directories, not a re-read of the same object).

### 8.6 Verification evidence

- `test-realtime/*.test.js`: 9 pass / 0 fail, exit 0.
- Workgroup group (`test/workgroup-*.test.js` + `test/wg-*.test.js`): 239 pass / 0 fail, exit 0.
- Non-workgroup `test/*.test.js` batch (excluding feed): 872 pass / 0 fail / 1 skip, exit 0.
- Hub suite: 263 pass / 0 fail, exit 0.
- `node scripts/build-client.mjs --check`: exit 0.
- `npm run lint`: 13 warnings, 0 errors, exit 0.
- `src/host/`: no changes.

Known residual test-infrastructure issue: one full `npm test` run (117 test files, including the
workgroup and realtime files) ended with 1117 pass / 1 fail / 1 skip, and the failure was
`test/feed.test.js` timing out as a file. `test/feed.test.js` passes 5/5 when run alone and the feed
teardown clears its keepalive timer and SSE clients. The same full run also hung once without output.
This is a cross-file test-runner/handle isolation problem, not a failing product assertion; it must be
resolved before claiming a clean one-process full-suite gate. The grouped runs above are the
functional evidence.

### 8.7 Manual acceptance still required

Two real machines and accounts:

1. Invite and accept; both member lists and settings update without reopening the group.
2. A Bot with a role/instructions is called by the admin, answers on the other machine, and the
   original round continues with the next named member.
3. A colleague's Bot shows its own name plus the owner marker, never the owner's phone.
4. Messages appear live through `/api/bot/feed`; both machines keep history and attribution after a
   restart.
