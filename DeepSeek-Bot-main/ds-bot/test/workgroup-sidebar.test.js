// G4 gate item 5: the "plugins" entry stays where it was, and the "Bot" entry exists once.
//
// The gate is about the DSH sidebar, which this plugin does not own. What can be asserted without
// a running shell is the two facts the shell acts on:
//
//   * the plugin-manager entry is registered into `sidebar.panellist` with `order: 0`, and nothing
//     here has any power to change that — so the assertion is that OUR entry does not claim order
//     0, and that its id is not `plugins`;
//   * our entry is registered exactly once, with an order strictly between the two shipped
//     entries (plugins 0, schedules 10).
//
// The visual half of the gate ("the Bot entry appears once, below plugins") is manual and lives in
// docs/workgroup/manual-checklist.md; this file records the structural half so a later edit cannot
// silently move it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const clientIndex = readFileSync(new URL('../src/workgroup/client/index.js', import.meta.url), 'utf8')

// Comments out, code only. Several tests below count registrations or look for a sentence, and this
// repository's sources quote both the shipped DSH registration shapes and the banner they removed —
// a quotation in a comment is documentation, not behaviour.
const codeOnly = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .filter(line => !line.trim().startsWith('//'))
  .join('\n')

const code = codeOnly(clientIndex)

// Read from the source rather than imported: the client entry imports `react`, which the host test
// harness does not load — and the values are literals in that file anyway, so reading them is the
// same fact without a bundler in the way.
const literal = (name) => {
  const match = new RegExp(`export const ${name} = ([^\\n]+)`).exec(code)
  assert.ok(match !== null, `${name} is exported`)
  return match[1].trim()
}
const PANEL_ID = literal('PANEL_ID').replace(/'/g, '')
const WG_PANEL_KEY = literal('WG_PANEL_KEY').replace(/'/g, '')
const PANEL_ORDER = Number(literal('PANEL_ORDER'))

// The shipped entries, as they appear in the DSH packages. `order: 0` is plugin-manager, `order: 10`
// is schedules; everything this plugin registers must sit strictly between them.
const PLUGINS_ORDER = 0
const SCHEDULES_ORDER = 10

test('the Bot entry sits between "plugins" and "schedules"', () => {
  assert.ok(PANEL_ORDER > PLUGINS_ORDER, `the Bot entry must come after plugins (${PANEL_ORDER} > ${PLUGINS_ORDER})`)
  assert.ok(PANEL_ORDER < SCHEDULES_ORDER, `and before schedules (${PANEL_ORDER} < ${SCHEDULES_ORDER})`)
})

test('the Bot entry does not take the plugins id or its order', () => {
  assert.notEqual(PANEL_ID, 'plugins', 'the id must not collide with the shipped entry')
  assert.notEqual(PANEL_ID, 'schedules')
  assert.notEqual(PANEL_ORDER, PLUGINS_ORDER, 'claiming order 0 would push plugins aside')
  // The registration in the source must carry the same numbers the export does, or the two could
  // drift and the test would be checking a constant nothing uses.
  assert.match(code, /order: PANEL_ORDER,/)
  assert.match(code, /id: PANEL_ID,/)
})

test('every sidebar entry and main panel is registered exactly once', () => {
  // Two registrations of one id is what makes an entry appear twice; the shell does not dedupe.
  const panelistRegistrations = code.match(/name: 'sidebar\.panellist'/g) ?? []
  assert.equal(panelistRegistrations.length, 1, 'exactly one sidebar.panellist registration')

  // The rail entry and the panel it opens share one id (layout refuses a rail entry with no panel).
  const mainKeys = [...code.matchAll(/key: (PANEL_ID|WG_PANEL_KEY)/g)].map(match => match[1])
  assert.deepEqual(mainKeys.sort(), ['PANEL_ID', 'WG_PANEL_KEY'], 'each keyed main panel is registered once')
  assert.notEqual(PANEL_ID, WG_PANEL_KEY, 'the door and the workgroup panel are different panels')
})

test('the Bot entry keeps the same slot the shipped entries use', () => {
  // `sidebar.panellist` is the only first-level nav slot (slot-probe V1/V2), and the id must match a
  // keyed `main` entry or `selectPanel` throws.
  assert.match(code, /ctx\.slots\.inject\('sidebar\.panellist'/)
  assert.match(code, /ctx\.slots\.inject\('main'/)
  assert.match(code, /name: 'main', key: PANEL_ID/, 'the rail id has a main panel')
})

test('the workgroup panel is reachable without a second first-level icon', () => {
  // WG_PANEL_KEY is a keyed main entry with no sidebar row of its own: opening it comes from the
  // Bot sidebar's rows, so the rail keeps exactly one Bot icon.
  const icons = code.match(/BotPanelIcon/g) ?? []
  // One definition and one use (the sidebar registration).
  assert.equal(icons.length, 2, 'the icon is defined once and used by the one sidebar entry')
})

// ── the notice that must not come back ──────────────────────────────────────────
// G3 shipped a panel banner: "Not finished: workgroup chat and messages are not available yet."
// G4 made both available, so the banner is gone. This assertion is what stops the sentence from
// reappearing while the feature it disclaims exists — a text that says "not available" next to a
// working chat is worse than no text, because it teaches the user to distrust the screen.
test('the panel does not claim that chat and messages are unavailable', () => {
  const panel = codeOnly(readFileSync(new URL('../src/workgroup/client/panel.js', import.meta.url), 'utf8'))
  const i18n = codeOnly(readFileSync(new URL('../src/client/i18n.js', import.meta.url), 'utf8'))
  for (const source of [panel, i18n]) {
    assert.equal(/Not finished/i.test(source), false, 'the G3 banner must not come back')
    assert.equal(source.includes('bt-wg-unfinished'), false)
    assert.equal(/工作群聊天与消息尚未提供/.test(source), false)
  }
  // And what replaced it is a statement of fact, drawn from the bridge: a group on the Hub shows
  // its connection state, and a group that is not on the Hub shows nothing.
  assert.match(panel, /function HubLine\(/, 'the Hub line exists')
  assert.match(panel, /data-hub/, 'and is addressable')
  assert.match(panel, /hub === null \? null : h/, 'a local workgroup shows no Hub claim at all')
})

// G4 fixed four defects that a green suite had hidden. Each gets a structural assertion so the
// *wiring* cannot silently disappear again — the behaviour itself is covered by
// workgroup-e2e.test.js.
test('the G4 wiring that was missing is present', () => {
  const panel = codeOnly(readFileSync(new URL('../src/workgroup/client/panel.js', import.meta.url), 'utf8'))
  const channel = codeOnly(readFileSync(new URL('../src/workgroup/host/channel.js', import.meta.url), 'utf8'))
  const bridge = codeOnly(readFileSync(new URL('../src/workgroup/host/bridge.js', import.meta.url), 'utf8'))
  const groups = codeOnly(readFileSync(new URL('../src/workgroup/host/groups.js', import.meta.url), 'utf8'))

  // 1) Signing in starts the socket; no UI has to press "connect".
  assert.match(channel, /case 'hub-register':[\s\S]*?await wg\.bridge\.start\(\)/, 'signing in starts the bridge')
  assert.match(channel, /case 'hub-state':[\s\S]*?wg\.bridge\.start\(\)/, 'reading the account reconnects a restarted bridge')

  // 2) The panel's own "create" path makes a Hub group, so a workgroup is one another person can join.
  assert.match(channel, /case 'create-room':[\s\S]*?wg\.bridge\.createWorkgroup\(/, 'create-room reaches the Hub')

  // 3) The seam the round calls for a remote member exists in production, not only in a test.
  assert.match(bridge, /async deliverRemote\(/, 'the bridge defines deliverRemote')
  assert.match(bridge, /wg\.deliverRemote = /, 'and installs it on the domain')
  assert.match(groups, /wg\.deliverRemote\?\./, 'which is what the round calls')

  // 4) A line from the Hub SHOWS in the group's own chat AND continues the original hand-off.
  //
  // The old rule was "a Hub line never starts a local round", implemented by stamping it
  // `role: 'remote'`, which the relay hook ignores. That kept the colleague's Bot out of the
  // displayed chat, and it also broke the copied round: the original asks the next speaker from the
  // current member's post, so a remote Bot's `@Name` never called the member it named on THIS
  // machine. Bot lines now arrive as the same `post` a local member produces, marked `member` so an
  // @-less answer is not mistaken for the user. `openingSpeakers` still decides every speaker, and
  // a PERSON's line remains outside the group Session.
  const receiveRemote = groups.slice(groups.indexOf('async function receiveRemote'), groups.indexOf('wg.receiveRemote = receiveRemote'))
  assert.equal(receiveRemote.length > 0, true, 'receiveRemote exists')
  assert.match(receiveRemote, /role: 'post'/, 'a Hub Bot line is a member post, not inert history')
  assert.match(receiveRemote, /member: true/, 'and keeps the original member-vs-user speaker rule')
  const cells = codeOnly(readFileSync(new URL('../src/client/cells.js', import.meta.url), 'utf8'))
  assert.match(cells, /source\.role !== 'post' && source\.role !== 'remote'/, 'the chat still draws it')
  assert.match(groups, /async function applyRoster/, 'the Hub roster reaches the local room')
  assert.match(bridge, /wg\.syncRoster\?\./, 'and the bridge asks for it on connect')

  // 5) The three controls that had no UI now have one.
  assert.match(panel, /callWorkgroup\('group-invites'\)/, 'the invite inbox reads the list')
  assert.match(panel, /callWorkgroup\('answer-invite'/, 'and can accept one')
  assert.match(panel, /callWorkgroup\('attachment-download'/, 'an attachment can be fetched')
  assert.match(panel, /callWorkgroup\('publish-endpoints'\)/, 'and this machine can publish its Bots')
})

// The panel's own claims about G4 features must match what the host actually answers. Each of these
// endpoint names is used by the client and must exist on the host, or the button is a dead control.
test('every endpoint the panel calls exists on the host', () => {
  const panel = codeOnly(readFileSync(new URL('../src/workgroup/client/panel.js', import.meta.url), 'utf8'))
  const channel = codeOnly(readFileSync(new URL('../src/workgroup/host/channel.js', import.meta.url), 'utf8'))
  const called = new Set([...panel.matchAll(/callWorkgroup\('([a-z-]+)'/g)].map(match => match[1]))
  assert.ok(called.size >= 6, `the panel calls several endpoints, found ${[...called].join(', ')}`)
  for (const endpoint of called) {
    assert.ok(channel.includes(`case '${endpoint}':`), `the host must answer "${endpoint}"`)
  }
})
