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

// ── the five reported regressions ───────────────────────────────────────────────
// These belong to G4's already-delivered surfaces: the open group, the member card and the copied
// group settings. They are pinned in this TRACKED file because `ds-bot/.gitignore` currently ignores
// new `test*/` paths; a regression test the repository does not keep is not evidence.

test('the member card follows the Hub roster while the group is open', () => {
  assert.match(panelSrc, /export function useLiveMembers\(/, 'a live member hook exists')
  assert.match(panelSrc, /const members = useLiveMembers\(hubWorkgroupId\)/, 'ChatPane mounts it')
  assert.match(panelSrc, /callWorkgroup\('group-members', \{ workgroupId \}\)/, 'it reads the Hub roster')
  // The live path is the host feed now; 1200 ms polling was the previous (stale) mechanism and must
  // not remain as a parallel live path. The slow fallback is asserted by workgroup-realtime.test.js.
  assert.match(panelSrc, /addEventListener\('workgroup'/, 'it follows the live workgroup signal')
  assert.match(panelSrc, /setTimeout\(tick, 5000\)/, 'with a slow fallback while mounted')
  assert.doesNotMatch(panelSrc, /\[hubWorkgroupId, room\?\.log\?\.length\]/,
    'membership changes are not tied to a new message')
})

test('the open group and member card converge from one shared revision', () => {
  const channelSrc = readFileSync(new URL('../src/workgroup/host/channel.js', import.meta.url), 'utf8')
  // Every workgroup write bumps `wg.state.revision` (host/state.js save). A room that is open must
  // be able to ask "did anything in this group change?" without downloading the whole transcript on
  // every tick, and a member change, a rename and a new line all have to produce the same answer.
  assert.match(channelSrc, /revision: wg\.state\?\.revision \?\? 0/,
    'the state answer carries the local revision')
  assert.match(panelSrc, /callWorkgroup\('state'\)/, 'the open group polls the cheap revision first')
  assert.match(panelSrc, /revision/, 'and compares it before reading the full room')
})

test('a member row uses the appearance its owner published', () => {
  // The row used to hand `RoomAvatar` an endpoint id and no roster, so `lookOf()` derived a
  // different character and colour on every machine.
  assert.match(panelSrc, /h\(BotMark, \{[^}]*bot: \{/, 'the row draws a Bot mark from a record')
  assert.match(panelSrc, /avatar: \{\s*\.\.\.\(typeof member\.avatar\.shape === 'string'/,
    'the published shape is split out of the Hub snapshot')
  assert.match(panelSrc, /color: member\.avatar\.color/, 'and the published colour reaches the record')
})

test('a Bot line carries whose Bot spoke, like the member card does', () => {
  // Two colleagues may both call their butler "Chief". The roster row already distinguishes them;
  // the conversation is where a person actually reads who did the work, so the line needs the same
  // answer. `ownerIsYou` comes from the Hub; a line for a person's own message has no owner tag.
  assert.match(panelSrc, /const memberOfLine = \(line\) => \(members \?\? \[\]\)\.find/,
    'the line resolves its author against the live Hub roster')
  assert.match(panelSrc, /const owner = memberOfLine\(line\)/,
    'each line looks its own member up')
  assert.match(panelSrc, /data-mine/, 'and says whether that Bot is yours or a colleague\'s')
  assert.match(panelSrc, /t\('Yours'\)[\s\S]{0,120}t\("A colleague's"\)/,
    'using the same two words as the member card')
})

test('the copied group settings read workgroup members and adminId', () => {
  const settingsSrc = readFileSync(new URL('../src/workgroup/client/group-settings.js', import.meta.url), 'utf8')
  assert.match(settingsSrc, /const memberRecords = \(room, roster\)/, 'one normaliser for both member shapes')
  assert.match(settingsSrc, /room\.adminId \?\? room\.admin/, 'the workgroup admin field is read')
  assert.match(settingsSrc, /memberRecords\(room, roster\)\.length/, 'the subtitle counts records')
  assert.match(settingsSrc, /const leads = adminIdOf\(room\) === member\.id/, 'the admin tag uses adminId')
  // The original local-team form is untouched: only the copied file learns the workgroup shape.
  const originalSettings = readFileSync(new URL('../src/client/group-settings.js', import.meta.url), 'utf8')
  assert.doesNotMatch(originalSettings, /memberRecords|adminIdOf/, 'the original form keeps its contract')
})

test('a joined room is initialised by the admin, exactly as a created one is', () => {
  const groupsSrc = readFileSync(new URL('../src/workgroup/host/groups.js', import.meta.url), 'utf8')
  // The kickoff is triggered at the first roster that has an answerer, not only at create time.
  assert.match(groupsSrc, /room\.greeted !== true && \(room\.adminId \?\? null\) !== null/,
    'the first ready roster asks for a greeting')
  assert.match(groupsSrc, /greetWorkgroup\(room\.id\)/, 'and delivers it into the room Session')
  // Joining synchronises the roster; nothing else has to invent a second welcome path.
  const bridgeSrc = readFileSync(new URL('../src/workgroup/host/bridge.js', import.meta.url), 'utf8')
  assert.match(bridgeSrc, /async answerInvite\([^]*?await wg\.syncRoster\?\.\(\{ hubWorkgroupId: answer\.workgroupId \}\)/,
    'accepting a known invitation syncs the joined roster')
})

test('a Bot reply that crossed the Hub continues the round instead of reading as the user', () => {
  const groupsSrc = readFileSync(new URL('../src/workgroup/host/groups.js', import.meta.url), 'utf8')
  const bridgeSrc = readFileSync(new URL('../src/workgroup/host/bridge.js', import.meta.url), 'utf8')
  // The original asks the next speaker from the line the current speaker posted
  // (`runRound` -> `mentionsIn` -> `callMembers`). A workgroup member may answer on another
  // machine, so its line arrives through `receiveRemote`. It has to keep its Bot identity there:
  // `mine === true && senderEndpointId === undefined` is the USER path, and a Bot's mirrored line
  // replayed through `ack.ok` used to lose `botEndpointId`, so the author's own machine treated a
  // Bot's answer as a message typed by the person and opened another round for it.
  const ack = bridgeSrc.slice(bridgeSrc.indexOf("case 'ack.ok':"))
  assert.match(ack.slice(0, ack.indexOf('emit(', 0)), /botEndpointId: sent\.botEndpointId/,
    'a replayed ack keeps the Bot authorship the Hub stored')
  assert.match(groupsSrc, /receiveRemote[\s\S]*?role: 'post'/,
    'a Bot line from the Hub enters the path that can choose the next speaker')
  // And it stays a MEMBER's post. Without `member`, `admin` mode treats an @-less answer as a
  // plain user message and calls the admin, so every remote reply would start another turn.
  const receive = groupsSrc.slice(groupsSrc.indexOf('async function receiveRemote('))
  assert.match(receive.slice(0, receive.indexOf('wg.receiveRemote = receiveRemote')), /member: true/,
    'a remote Bot line is marked as a member speaking, not as the user')
})

test('the product sidebar consumes the workgroup feed and refreshes the shared store', () => {
  assert.match(panelSrc, /export const listenLive/, 'the existing subscriber is exported')
  assert.match(sidebarSrc, /listenLive/, 'the product sidebar subscribes to the same feed')
  assert.match(sidebarSrc, /refreshWorkgroups()/, 'and re-reads the list projection')
  assert.match(sidebarSrc, /payload\?\.kind === 'settings'/, 'a settings signal is handled')
  assert.match(sidebarSrc, /hasWorkgroups/, 'a team with no workgroups opens no feed')
})

test('the settings form writes the Hub setting that makes the admin receive plain messages', () => {
  // The form sends the original's field names (`mode`, `admin`); the workgroup channel forwards
  // them as this domain's own and the host pushes them to the Hub. A report of "not synced" has to
  // fail here before it can be called a transport problem.
  const channelSrc = readFileSync(new URL('../src/workgroup/host/channel.js', import.meta.url), 'utf8')
  assert.match(channelSrc, /for \(const key of \['name', 'notice', 'mode', 'permission', 'workDir', 'lead'\]\)/,
    'update-room forwards the reply mode')
  assert.match(channelSrc, /if \(body\.admin !== undefined && body\.adminId === undefined\) patch\.adminId = body\.admin/,
    "and the admin under this domain's field name")
  const groupsSrc = readFileSync(new URL('../src/workgroup/host/groups.js', import.meta.url), 'utf8')
  assert.match(groupsSrc, /modeChanged \? \{ replyMode: room\.mode \}/, 'the host sends the mode to the Hub')
  assert.match(groupsSrc, /leadTouched[\s\S]{0,400}leadMembershipId/, 'and the chosen lead with it')
  assert.match(groupsSrc, /const modeChanged = WG_ROOM_MODES\.includes\(replyMode\) && room\.mode !== replyMode/,
    'the other machine applies the shared mode on its next roster read')
})
