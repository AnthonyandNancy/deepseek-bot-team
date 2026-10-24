// The work indicator in a workgroup's chat — the original group chat's in-progress animation.
//
// The user's report: 「工作群并没有原版群聊那种工作中的动效」. A local group shows a member at work
// while it runs: an avatar, a shimmering phrase of what it is doing, and an elapsed clock. The
// workgroup's panel showed nothing at all, and its chat is a transcript with no live part.
//
// The HOST side was never the problem: `roomWorkView` and `activityView` answer in the original's
// exact shape and the original's own state route merges them in. What was missing is that the panel
// never asked. So the assertions here are about the panel: it renders the members at work, from the
// domain's own state route, with the original's primitives.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClientModule } from './client-render.mjs'

const panelSource = readFileSync(new URL('../src/workgroup/client/panel.js', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../src/workgroup/client/styles.js', import.meta.url), 'utf8')

const codeOnly = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .filter(line => !line.trim().startsWith('//'))
  .join('\n')

test('a workgroup shows the members at work, like a local group does', async () => {
  // THE PANEL REALLY RENDERS IT. Asserted on the source first, because the mount point is what the
  // report was about: the component existing but not being drawn is exactly the earlier state.
  const code = codeOnly(panelSource)
  assert.match(code, /h\(LocalWorking, \{ roomId \}\)/, 'the chat pane draws the work indicator')
  assert.match(code, /h\(Composer,/, 'and it sits above the composer, where a local group puts it')
  // The mount is between the transcript and the box, which is the original's placement.
  const logAt = code.indexOf("className: 'bt-wg-log'")
  const workingAt = code.indexOf('h(LocalWorking, { roomId })')
  const composerAt = code.indexOf('h(Composer,')
  assert.ok(logAt !== -1 && workingAt !== -1 && composerAt !== -1, 'all three parts are present')
  assert.ok(logAt < workingAt && workingAt < composerAt,
    'the indicator sits between the log and the composer')

  // IT READS THE DOMAIN'S OWN STATE ROUTE, in the original's shape (`work.rooms[roomId]`). Using the
  // same route the panel already polls means no second mechanism and no new host endpoint.
  assert.match(code, /callWorkgroup\('state'\)/, 'the indicator asks this domain for its state')
  assert.match(code, /work\?\.rooms\?\.\[roomId\]/, 'and reads the room’s own work entries')

  // THE ORIGINAL'S PRIMITIVES, not new ones: the shimmering phrase and the elapsed clock are what
  // make a local group's indicator look alive, and they are imported rather than re-implemented.
  assert.match(code, /from '\.\.\/\.\.\/client\/cells\.js'/, 'it reuses the original client cells')
  assert.match(code, /Shimmer/, 'the phrase shimmers')
  assert.match(code, /Elapsed/, 'and the wait is timed')
  assert.match(code, /workPhrase/, 'and the phrase is the original one')
})

test('the work indicator has the original\'s look, with reduced-motion respected', () => {
  for (const name of ['bt-wg-working', 'bt-wg-working-line', 'bt-wg-working-time']) {
    assert.ok(stylesSource.includes(`.${name}{`), `${name} is styled`)
  }
  // The original's spring-in, and no animation when the reader asked for none.
  assert.match(stylesSource, /@keyframes bt-wg-working-in/)
  assert.match(stylesSource, /prefers-reduced-motion:reduce\)\{\.bt-wg-working-line\{animation:none\}\}/)
  // The round's current speaker is distinguished, the way the original marks it.
  assert.match(stylesSource, /\.bt-wg-working-line\[data-speaking="true"\]/)
})

test('the panel really loads, so the indicator cannot break it at runtime', async () => {
  // The source assertions above would pass for a module that throws on import. Loading it is what
  // proves the new imports resolve — the panel is one module, so a bad import takes the whole
  // workgroup page down, not just the indicator.
  const module = await loadClientModule(`
    export { LocalWorking } from './src/workgroup/client/panel.js'
  `)
  assert.equal(typeof module.LocalWorking, 'function', 'the panel exports the work indicator')
})

// THE OPEN GROUP STAYS LIVE.
//
// `openWorkgroup` reads the room once, and for a long time nothing read it again. A line that arrived
// while the group was on screen — the colleague's Bot answering, a member joining, a rename made on
// another machine — was written to disk by the host and never reached the screen until the group was
// closed and reopened. That is the reported 「邀请同事加入后，消息并没有实时更新」.
//
// The assertions are about the two things that make it work and are easy to lose: the poll is
// MOUNTED in the chat pane, and it only writes the store when the room actually changed.
test('the open workgroup is re-read while it is on screen', () => {
  const code = codeOnly(panelSource)
  // The CALL, not the definition: matching the name alone passed even with the mount removed, because
  // `export function useLiveRoom(` is the same string.
  assert.match(code, /^\s+useLiveRoom\(roomId\)$/m, 'the chat pane keeps the open group live')
  // The hook exists and polls `room`, the read that carries the log.
  assert.match(code, /export function useLiveRoom\(/, 'the live hook is exported, so a test can name it')
  assert.match(code, /callWorkgroup\('room', \{ id: roomId \}\)/, 'it re-reads the room itself')
  // AND IT DOES NOT RE-RENDER ON EVERY TICK. A poll that set the store unconditionally would rebuild
  // the transcript several times a second; the signature is what stops that.
  assert.match(code, /roomSignature/, 'a change signature decides whether to write')
  assert.match(code, /if \(next !== last && store\.getSnapshot\(\)\.selected === roomId\)/,
    'and only the group still on screen is written')
})
