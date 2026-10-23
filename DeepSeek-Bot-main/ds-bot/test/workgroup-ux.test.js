// Six requested behaviours, each pinned so it cannot silently regress.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const panelSrc = readFileSync(new URL('../src/workgroup/client/panel.js', import.meta.url), 'utf8')
// The approval cards live in their own module now: the group settings drawer shows the same cards,
// so a second copy of the assertions would be a second thing to keep in step.
const tasksSrc = readFileSync(new URL('../src/workgroup/client/tasks.js', import.meta.url), 'utf8')
const rowsSrc = readFileSync(new URL('../src/workgroup/client/rows.js', import.meta.url), 'utf8')
const sidebarSrc = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
const indexSrc = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')

test('@mentions are highlighted with the ORIGINAL parser, not a second one', async () => {
  // The host decides who answers with `mentionSpans`; the panel must mark the same spans,
  // so what the reader sees called is what actually got called.
  assert.match(panelSrc, /import \{ mentionSpans \} from '\.\.\/\.\.\/shared\/mentions\.js'/)
  assert.match(panelSrc, /mentionSpans\(value, bots\)/, 'reuses the shared parser')
  assert.ok(!/function (mentionSpans|mentionsIn)\(/.test(panelSrc), 'and does not define its own')
  // Rendered as a marked span, with @all distinguishable.
  assert.match(panelSrc, /className: span\.all \? 'bt-wg-at bt-wg-at-all' : 'bt-wg-at'/)
})

test('the group header shows the member avatars and the name, like a local group', () => {
  assert.match(panelSrc, /bt-wg-chat-head/, 'the header exists')
  assert.match(panelSrc, /h\(RoomAvatar, \{ room: \{ members:/, 'it draws the member avatars')
  assert.match(panelSrc, /bt-wg-chat-name/, 'and the group name')
})

test('both kinds of group row reveal the full name on hover', () => {
  // A long name is ellipsised, so the row carries the whole one in `title`.
  assert.match(sidebarSrc, /title: room\.name,/, 'local group rows have it')
  assert.match(rowsSrc, /title: room\.name,/, 'workgroup rows have it')
})

test('the panel reports a MEASURED connection state, not a decoration', () => {
  assert.match(panelSrc, /function ConnectionLine\(/)
  // It times a real round trip through the plugin's own route.
  assert.match(panelSrc, /await callWorkgroup\('state'\)/)
  assert.match(panelSrc, /Date\.now\(\) - started/, 'latency is measured')
  // Failure shows the reason rather than a generic dot.
  assert.match(panelSrc, /state\.kind === 'down' \? t\('Not connected: \{reason\}'/)
  // It stops polling when the panel goes away.
  assert.match(panelSrc, /live = false; clearTimeout\(timer\)/)
  assert.match(panelSrc, /data-connection/, 'the state is addressable for a screenshot/test')
})

test('names are labels: the automatic one carries a timestamp, the id is the identity', () => {
  const groups = readFileSync(new URL('../src/workgroup/host/groups.js', import.meta.url), 'utf8')
  // The automatic name is the members plus the creation time, so two groups over the same
  // Bots stay distinguishable in the list.
  assert.match(groups, /autoWorkgroupName = \(members, createdAt\) =>/, 'the automatic name takes a timestamp')
  assert.match(groups, /stamp\(createdAt\)/, 'and uses it')
  // Identity is the id, so no name is checked for uniqueness.
  // The id is the group's own Session, exactly as the original's buildRoom does it —
  // that is what makes `openSession(room.id)` able to open it.
  assert.match(groups, /const id = await rt\.createSession\(title, \{\}\)/, 'the id is the group Session')
  assert.ok(!/Another group chat is already called/.test(groups), 'no name clash check remains')
  // Members are de-duplicated, as the original composer does.
  assert.match(groups, /const seen = new Set\(\)/, 'members are de-duplicated')
})

test('the admin of a group whose name is shared cannot change until it is renamed', () => {
  const groups = readFileSync(new URL('../src/workgroup/host/groups.js', import.meta.url), 'utf8')
  assert.match(groups, /const sameName = Object\.values\(wg\.state\.workgroups\)\.filter\(other => other\.name === room\.name\)\.length/)
  assert.match(groups, /if \(sameName > 1\)/, 'the block applies to a duplicated name')
  assert.match(groups, /rename this one before changing its admin/)
})

test('a workgroup polls its OWN round progress, and reads the answer as it arrives', () => {
  // The typing line and the bottom capsule both come from `room-progress`. Two ways it
  // silently returned nothing, each of which made the workgroup look finished while a
  // member was still answering:
  //   1. the request went to the original route, which only knows local-group rounds;
  //   2. the answer was unwrapped as `{ok, value}` although `callWorkgroup` hands back the
  //      value itself, so `result.ok` was `undefined` and the poll always yielded `[]`.
  assert.match(indexSrc, /roomProgress: roomId => \(workgroupStore\.getSnapshot\(\)\.rooms\.some/,
    'a workgroup id is recognised')
  assert.match(indexSrc, /callWorkgroup\('room-progress', \{ roomId \}\)\.then\(value => value \?\? \[\]\)/,
    'and answered by this domain, without re-unwrapping the envelope')
  assert.ok(!/callWorkgroup\('room-progress'\).*result\.ok/s.test(indexSrc),
    'the already-unwrapped value is not unwrapped twice')
})

test('the difference manifest names every file this fork changed', () => {
  const manifest = readFileSync(new URL('../../docs/workgroup/diff-manifest.md', import.meta.url), 'utf8')
  // The manifest is part of the G1 gate ("准确保存差异清单"), so a file this fork changed
  // but the manifest does not name is a gate failure, not a documentation nicety. The
  // first version of it listed the workgroup UI and its RPC route as "not done" long
  // after both existed, and did not name src/host/channel.js at all.
  for (const file of [
    'src/workgroup/host/groups.js',
    'src/workgroup/host/channel.js',
    'src/workgroup/host/state.js',
    'src/workgroup/host/ownership.js',
    'src/workgroup/host/tasks.js',
    'src/workgroup/host/hub.js',
    'src/workgroup/host/hub-store.js',
    'src/workgroup/host/hub-format.js',
    'src/workgroup/index.js',
    'src/workgroup/shared/constants.js',
    'src/workgroup/client/api.js',
    'src/workgroup/client/index.js',
    'src/workgroup/client/panel.js',
    'src/workgroup/client/rows.js',
    'src/workgroup/client/styles.js',
    'src/host/channel.js',
    'src/host/store.js',
    'src/host/tools.js',
    'src/host/capabilities.js',
    'src/host/secrets.js',
    'src/host/usage.js',
    'src/host/feed.js',
    'src/client/index.js',
    'src/client/cells.js',
    'src/client/text.js',
    'src/client/sources.js',
    'src/client/sidebar.js',
    'src/client/new-chat.js',
    'src/client/context-menu.js',
    'src/client/at-menu.js',
    'src/client/i18n.js',
    'src/client/hub-settings.js',
    'src/client/settings.js',
    'client.js',
  ]) {
    assert.ok(manifest.includes(file), `the manifest names ${file}`)
  }
  // Claims that were wrong and must not come back.
  assert.ok(!/工作群 RPC 端点.*未做/s.test(manifest), 'the RPC route exists and must not be listed as not done')
})

test('the difference manifest still records the originals it did NOT change', () => {
  const manifest = readFileSync(new URL('../../docs/workgroup/diff-manifest.md', import.meta.url), 'utf8')
  // The strongest evidence for "the local group does not regress": the original group
  // core and its turn machinery are byte-identical to upstream. A manifest that stops
  // saying so loses that evidence.
  for (const file of ['src/host/groups.js', 'src/host/turns.js', 'src/host/resume.js', 'src/host/delivery.js', 'src/host/constants.js']) {
    assert.ok(manifest.includes(file), `the manifest still names ${file} as unchanged`)
  }
  assert.match(manifest, /逐字节相同|byte-identical/, 'and says how that was checked')
})

// ── G5: the approval card ─────────────────────────────────────────────────────────
// The G4 audit found six endpoints with no caller: a feature that existed on the host and nowhere a
// person could reach it. These pin the other direction — the card exists, it calls the endpoints that
// answer, and it refuses to hide the scope a person is approving.

test('the approval card is wired to the endpoints that answer it', () => {
  assert.match(tasksSrc, /function ApprovalCards\(/, 'the component exists')
  // The list it draws comes from the host, not from a local guess.
  assert.match(tasksSrc, /await callWorkgroup\('task-requests'\)/)
  // Both answers exist, and both go through the decision endpoint.
  assert.match(tasksSrc, /callWorkgroup\('task-decide', \{\s*taskId: request\.taskId,\s*decision,/)
  assert.match(tasksSrc, /void decide\(request, 'granted'\)/)
  assert.match(tasksSrc, /void decide\(request, 'rejected'\)/)
  // And it is actually rendered by the panel, not merely defined beside it.
  assert.match(panelSrc, /\n      h\(ApprovalCards, \{ onChanged:/, 'the panel renders it')
})

test('the three ways to assign a task are all offered', () => {
  for (const mode of ['existingBot', 'chiefPicks', 'newBot']) {
    assert.match(tasksSrc, new RegExp(`value: '${mode}'`), `${mode} must be offered`)
  }
})

test('the card shows the requested scope before the decision', () => {
  // A scope nobody read is a scope nobody approved, so the resources and capabilities appear on the
  // card rather than only being stored.
  assert.match(tasksSrc, /request\.resources/)
  assert.match(tasksSrc, /request\.capabilities/)
  assert.match(tasksSrc, /bt-wg-task-scope/)
})

test('a card with nothing waiting renders nothing at all', () => {
  // Neither a request nor a task of this machine's own: nothing to draw, so the panel does not draw
  // an empty section header.
  assert.match(tasksSrc, /if \(requests\.length === 0 && active\.length === 0\) return null/)
})

test('an approved task can be started, finished and stopped from the panel', () => {
  // The G4 audit found six host endpoints with no caller; these three are the ones a person needs
  // after approving, so each must be reachable from the card.
  assert.match(tasksSrc, /callWorkgroup\(endpoint, \{ taskId \}\)/)
  assert.match(tasksSrc, /run\(task\.taskId, 'task-start'\)/)
  assert.match(tasksSrc, /run\(task\.taskId, 'task-finish'\)/)
  assert.match(tasksSrc, /run\(task\.taskId, 'task-cancel'\)/)
  // Start is offered only while the ledger says it may run, so the UI cannot present an action the
  // guard would refuse.
  assert.match(tasksSrc, /task\.state === 'APPROVED' && task\.live/)
  // And the running half comes from the same host call as the waiting half.
  assert.match(tasksSrc, /setActive\(answer\.active \?\? \[\]\)/)
})
