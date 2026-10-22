// A file or a picture posted into a workgroup must reach every member, exactly as it does
// in a local group: the file travels with the line it was posted with, and a picture
// arrives as its reading, so a member without vision still sees what it shows.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-wg-files-'))
  const ctx = fakeContext()
  let seq = 0
  const followups = []
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }] },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s-${++seq}` }),
      resolveAgent: async sessionId => ({
        agent: { session: { id: sessionId }, followup: message => { followups.push({ sessionId, message }) }, cancel: () => {} },
      }),
      selectModel: async () => {},
      prompt: async () => ({ accepted: true }),
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  const wg = rt.workgroup
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, wg, followups, stop }
}

// One member, so the round has a single speaker to inspect.
async function ready() {
  const host = start()
  host.rt.state.bots['bot-a'] = { id: 'bot-a', name: 'Writer', instructions: 'x', createdAt: 1, capabilities: [] }
  const room = await host.wg.createWorkgroup({ name: 'Files', members: [{ id: 'bot-a', kind: 'localBot', name: 'Writer' }, { id: 'bot-c', kind: 'localBot', name: 'Other' }] })
  host.wg.registerSessionOwner('relay-session', { kind: 'workgroup', workgroupId: room.id })
  // The round is ended by aborting it, the way the relay's own signal does when the turn
  // is stopped: a member that never answers would otherwise hold it for the full timeout.
  const controller = new AbortController()
  const begin = (item) => {
    host.wg.roomInbox.set(room.id, [{ who: 'User', ...item }])
    return host.ctx.registeredTools.get('workgroup_relay')
      .execute({}, { agent: { id: 'relay-session' }, callId: 'call-f', signal: controller.signal })
  }
  const waitFor = async (check, why) => {
    for (let at = 0; at < 400; at += 1) {
      const value = check()
      if (value !== undefined) return value
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail(why)
  }
  return { ...host, room, begin, waitFor, controller }
}

test('a file posted into a workgroup reaches the member with the line it was posted with', async (t) => {
  const { wg, room, begin, waitFor, followups, controller, stop } = await ready()
  t.after(stop)
  const file = { name: 'notes.txt', bytes: 42, attachmentId: 'att-1' }
  const running = begin({ text: '看这个文件', files: [file] })
  t.after(() => { controller.abort(); return wg.stopRound(room.id) })
  await waitFor(() => wg.workgroupOf(room.id).sessions['bot-a'], 'the member got a Session')

  // The line carries the file, for every member the line is shown to.
  const line = wg.workgroupOf(room.id).log.at(-1)
  assert.deepEqual(line.files, [file], 'the log line keeps the file')
  assert.match(line.text, /notes\.txt/, 'and says a file was attached')

  // The member's turn received it, as a file block DSH turns into a readable path.
  const memberSession = wg.workgroupOf(room.id).sessions['bot-a']
  const delivered = await waitFor(() => followups.find(item => item.sessionId === memberSession), 'the member was delivered a turn')
  const blocks = delivered.message.content ?? []
  assert.ok(blocks.some(block => block.type === 'file' && block.attachment.name === 'notes.txt'),
    'the file travels in the message content')

  // End the round: the member never answers here, so aborting is what releases its turn.
  controller.abort()
  await wg.stopRound(room.id)
  await running
})

test('a picture posted into a workgroup reaches the member as its reading', async (t) => {
  const { rt, wg, room, begin, waitFor, controller, stop } = await ready()
  t.after(stop)
  // No vision model is part of this test: the reading is stubbed at the seam the original
  // uses, which is `rt.imagesForGroup`.
  rt.imagesForGroup = async () => ['[Image screenshot.png, read by test-vision:]\na red box\n[End of image screenshot.png]']
  const running = begin({ text: '看这张图', images: [{ name: 'screenshot.png' }] })
  t.after(() => { controller.abort(); return wg.stopRound(room.id) })
  await waitFor(() => wg.workgroupOf(room.id).sessions['bot-a'], 'the member got a Session')

  const line = wg.workgroupOf(room.id).log.at(-1)
  assert.match(line.text, /a red box/, 'the reading is in the log the members read')

  // End the round: the member never answers here, so aborting is what releases its turn.
  controller.abort()
  await wg.stopRound(room.id)
  await running
})

test('a conversation the user referenced reaches the member in the round prompt', async (t) => {
  const { wg, room, begin, waitFor, followups, controller, stop } = await ready()
  t.after(stop)
  const running = begin({
    text: '按这个来',
    references: [{ label: 'design notes', text: 'The plan says use two domains.' }],
  })
  t.after(() => { controller.abort(); return wg.stopRound(room.id) })
  await waitFor(() => wg.workgroupOf(room.id).sessions['bot-a'], 'the member got a Session')

  const memberSession = wg.workgroupOf(room.id).sessions['bot-a']
  const delivered = await waitFor(() => followups.find(item => item.sessionId === memberSession), 'the member was delivered a turn')
  const prompt = String(delivered.message.content[0]?.text ?? '')
  assert.match(prompt, /Conversations the user referenced in this round/, 'the reference is in the prompt')
  assert.match(prompt, /use two domains/, 'with its text')

  controller.abort()
  await wg.stopRound(room.id)
  await running
})
