// Hand-offs inside a workgroup: a Bot that hands work to another Bot hears it back.
//
// This is the workgroup counterpart of the original's hand-off chain, and it is a copy gate
// of its own. The original keeps a ledger of work (`src/host/handoffs.js`): a Bot asks
// another for something, the asker waits, and when the answer comes back the asker is called
// again with it. The plan (§5.1) lists `host/handoffs.js` as an A-class copy.
//
// The copy was missing, and so were three of the places that feed it. What that looked like
// in the product: a Bot handed work to a colleague in a workgroup, the colleague answered,
// and the conversation stopped there — the asker was never called back, so nothing followed.
//
// These tests go through the product path only: the real `workgroup_post` tool, the real
// `workgroup_relay` tool, and the real `session/event` listener. Nothing calls `openWork` or
// `reportRound` behind the product's back, because a test that does that proves the functions
// work while the product still never calls them — the mistake G4's fourth and fifth rounds
// were about.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-wg-handoff-'))
  const ctx = fakeContext()
  const workspaces = new Map()
  const followups = []
  let seq = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }] },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => { const sessionId = `s-${++seq}`; return { sessionId } },
      resolveAgent: async sessionId => ({
        agent: {
          session: { id: sessionId },
          followup: (message) => { followups.push({ sessionId, message }) },
          cancel: () => {},
        },
      }),
      selectModel: async () => {},
      prompt: async ({ sessionId, content, source }) => { followups.push({ sessionId, message: { content, source } }); return { accepted: true } },
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  const wg = rt.workgroup
  // What was delivered into each Session, in order. Exposed on `ctx` because a test needs to
  // replay what the product wrote into a group's Session through the real listener.
  ctx.followups = followups

  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const answer = async (sessionId, text) => {
    await emit(sessionId, { type: 'turn/start', data: { turn: 1 } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  // A member's turn that outlives its round slot: the group moved on, then the turn ends.
  const answerLate = async (sessionId, text) => {
    await emit(sessionId, { type: 'turn/start', data: { turn: 1 } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  }
  const endTurn = async (sessionId) => {
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  const untilWaiter = async (memberId, deadlineMs = 20_000) => {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const waiter = [...wg.roomWaiters.values()].find(entry => entry.memberId === memberId)
      if (waiter !== undefined) return waiter.sessionId
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${memberId}'s waiter`)
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, wg, answer, answerLate, endTurn, emit, untilWaiter, stop, followups }
}

const twoMembers = () => ([
  { id: 'bot-a', kind: 'localBot', name: 'Writer' },
  { id: 'bot-b', kind: 'localBot', name: 'Editor' },
])

const plantBots = (rt) => {
  for (const [id, name] of [['bot-a', 'Writer'], ['bot-b', 'Editor']]) {
    rt.state.bots[id] = { id, name, instructions: `${name} instructions`, createdAt: 1, capabilities: [] }
  }
}

// A workgroup in the shape the product makes one. A workgroup's own relay Session has the
// SAME id as the group (`groups.js:284`), and member Sessions are created by the round.
async function groupWithBothMembers(wg, rt) {
  plantBots(rt)
  return wg.createWorkgroup({ name: 'HandoffProbe', members: twoMembers() })
}

// A member's post travels the way the product makes it travel: the group Session receives a
// `role: 'post'` message and this domain's `session/event` listener turns it into the round's
// opener. Going through the listener is what proves that branch exists at all — filling
// `roomInbox` by hand would pass even while the product dropped every member post.
const deliverPost = async (ctx, roomId, { senderName, senderSessionId, text, roomId: sourceRoomId, ...rest }) => {
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    await listener({ id: roomId }, {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: `[Workgroup post from ${senderName}]\n${text}` }],
        source: {
          kind: 'workgroup', form: 'relay', role: 'post',
          exchangeId: 'exchange-post', senderName, senderSessionId,
          roomId: sourceRoomId ?? roomId, ...rest,
        },
      },
    })
  }
}

const roundOf = (ctx, room) => ctx.registeredTools.get('workgroup_relay').execute(
  {},
  { agent: { id: room.id }, callId: 'call-relay', signal: new AbortController().signal },
)

// The work a post opened for `outer`, read from the ledger rather than remembered by the
// test: the id is the domain's to choose.
const subOf = (wg, outer) => (wg.state.works[outer]?.open ?? []).at(-1)

// `workgroup_post` writes into the group's own Session (that is what the product does), and
// this domain's listener is what turns such a message into the round's opener. Replaying what
// was written there is how the product's own order is kept: the post first, the relay after.
const deliverQueued = async (ctx, roomId) => {
  const wrote = (ctx.followups ?? []).filter(entry => entry.sessionId === roomId
    && entry.message?.source?.role === 'post')
  for (const entry of wrote) {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      await listener({ id: roomId }, {
        type: 'user/message',
        data: { content: entry.message.content, source: entry.message.source },
      })
    }
  }
}

test('a member post reaches the round as a member post, not as something the user said', async (t) => {
  const { ctx, rt, wg, stop } = start()
  t.after(stop)
  const room = await groupWithBothMembers(wg, rt)
  await deliverPost(ctx, room.id, { senderName: 'Editor', senderSessionId: 'bot-b', text: '@Writer look at this', reportBack: true, sub: 'work-child' })
  const queued = wg.roomInbox.get(room.id) ?? []
  assert.equal(queued.length, 1, 'the post was queued for the next round')
  const opener = queued[0]
  assert.equal(opener.botId, 'bot-b', 'the post is attributed to the member that wrote it')
  assert.equal(opener.name, 'Editor')
  assert.equal(opener.reportBack, true, 'the poster asked to be reported to')
  assert.equal(opener.sub, 'work-child', 'the work the replies belong to survived the trip')
  assert.doesNotMatch(opener.text, /Workgroup post from/, 'the transport header is not the message')
})

test('a post with report_back opens work under the request it serves, and the round closes it', async (t) => {
  const { ctx, rt, wg, answer, untilWaiter, stop } = start()
  t.after(stop)
  const room = await groupWithBothMembers(wg, rt)
  // Writer is working on a request from a colleague — the only situation in which a post's
  // replies count as work handed on for that request (the original's rule).
  const outer = 'work-outer'
  wg.openWork(outer, { from: 'bot-b', to: 'bot-a' })
  const writerSession = 'session-writer'
  wg.registerSessionOwner(writerSession, { kind: 'workgroup', workgroupId: room.id, botId: 'bot-a' })
  wg.live.set(writerSession, { info: { kind: 'workgroup', role: 'request', exchangeId: outer, senderSessionId: 'bot-b' } })

  const posted = await ctx.registeredTools.get('workgroup_post').execute(
    { group: 'HandoffProbe', message: '@Editor please review this', report_back: true },
    { agent: { id: writerSession }, callId: 'call-post', signal: new AbortController().signal },
  )
  assert.match(posted, /Posted in "HandoffProbe"/)
  assert.match(posted, /replies also come back to you/, 'report_back says the replies come back')
  assert.equal(wg.state.works[outer].open.length, 1, 'the post is open work under the request it serves')

  // The post was written into the group's own Session; the relay opens the round from there.
  await deliverQueued(ctx, room.id)
  const running = roundOf(ctx, room)
  const editor = await untilWaiter('bot-b')
  await answer(editor, 'Reviewed: looks fine')
  await running
  assert.equal(wg.state.works[outer].results.length, 1, 'the replies came back as a result of the outer work')
  assert.match(wg.state.works[outer].results[0].text, /Reviewed: looks fine/)
  // The child itself is gone, and the outer work's own waiting view no longer lists it: every
  // reader resolves `open` through `works()`, exactly as the original does.
  assert.equal(wg.state.works[subOf(wg, outer)]?.to, undefined, 'the child work is closed')
  assert.deepEqual(wg.waitingView()[outer]?.bots ?? [], [], 'the outer work waits for nobody')
})

test('the poster is told what came back, in its own chat, carrying the work it goes on with', async (t) => {
  const { ctx, rt, wg, answer, untilWaiter, stop, followups } = start()
  t.after(stop)
  const room = await groupWithBothMembers(wg, rt)
  const outer = 'work-outer-2'
  wg.openWork(outer, { from: 'bot-b', to: 'bot-a' })
  const writerSession = 'session-writer'
  wg.registerSessionOwner(writerSession, { kind: 'workgroup', workgroupId: room.id, botId: 'bot-a' })
  wg.live.set(writerSession, { info: { kind: 'workgroup', role: 'request', exchangeId: outer, senderSessionId: 'bot-b' } })
  await ctx.registeredTools.get('workgroup_post').execute(
    { group: 'HandoffProbe', message: '@Editor please review', report_back: true },
    { agent: { id: writerSession }, callId: 'call-post', signal: new AbortController().signal },
  )
  await deliverQueued(ctx, room.id)
  const running = roundOf(ctx, room)
  const editor = await untilWaiter('bot-b')
  await answer(editor, 'Done, see notes')
  await running
  // The report goes to the poster's OWN chat: that message is how it learns what came back and
  // goes on with the work. Without it the chain ends at the member's answer.
  const report = followups.find(entry => entry.sessionId === rt.chatOf('bot-a')
    && entry.message?.source?.role === 'report')
  assert.ok(report !== undefined, 'the poster was sent a report about the replies')
  assert.match(String(report.message.content?.[0]?.text ?? ''), /Done, see notes/)
  assert.equal(report.message.source.work, outer, 'the report carries the work it goes on with')
})

test('a member that outlives its round slot still posts what its turn ended with', async (t) => {
  const { ctx, rt, wg, answerLate, endTurn, untilWaiter, stop } = start()
  t.after(stop)
  const room = await groupWithBothMembers(wg, rt)
  wg.roomInbox.set(room.id, [{ text: '@Editor take your time', who: 'User' }])
  const running = roundOf(ctx, room)
  const editor = await untilWaiter('bot-b')
  // Let the round go on without this member (it went on working), which is what
  // `WG_WORK_GRACE_MS` would do on its own after 15 s. Resolving the waiter directly is the
  // same transition the grace timer makes, without a 15 s test.
  const [exchangeId, waiter] = [...wg.roomWaiters.entries()].find(([, entry]) => entry.sessionId === editor)
  wg.roomWaiters.delete(exchangeId)
  waiter.resolve({ working: true })
  await running
  const before = (wg.workgroupOf(room.id).log ?? []).length
  assert.equal(wg.live.get(editor)?.info?.role, 'room', 'the member keeps the round slot it was called by')
  await answerLate(editor, 'Finished the long job')
  // The step lines a turn writes go out through an async writer (`roomStepText`), so give it
  // its turn before the turn ends: the same order the real product produces.
  await new Promise(resolve => setImmediate(resolve))
  await endTurn(editor)
  for (let tries = 0; tries < 400 && (wg.workgroupOf(room.id).log ?? []).length === before; tries += 1) {
    // `setTimeout` rather than `setImmediate`: the late-reply path saves the state file before
    // it posts, and that is real I/O which an immediate-only loop never lets complete.
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  const log = wg.workgroupOf(room.id).log ?? []
  assert.ok(log.length > before, `what the late turn ended with still reached the group (log: ${JSON.stringify(log)})`)
  assert.match(log.at(-1).text, /Finished the long job/)
})

test('the workgroup has its own hand-off ledger and the original never sees it', async (t) => {
  const { rt, wg, stop } = start()
  t.after(stop)
  await groupWithBothMembers(wg, rt)
  wg.openWork('work-x', { from: 'bot-a', to: 'bot-b' })
  assert.equal(wg.state.works['work-x']?.to, 'bot-b', 'the work is in this domain\'s own state')
  assert.equal(rt.state.works?.['work-x'], undefined, 'the original team\'s ledger never learns about it')
  assert.equal(wg.ownsWork('bot-b', 'work-x'), true)
  assert.equal(wg.waitsWork('work-x'), false, 'no children yet, so it does not wait')
})
