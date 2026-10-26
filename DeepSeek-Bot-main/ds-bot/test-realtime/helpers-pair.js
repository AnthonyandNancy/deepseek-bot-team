// Shared two-machine fixture for the realtime workgroup tests.
//
// Everything here is the production path: a real Hub on a loopback port, two real createRuntime
// machines, real signed-in devices, real WebSockets, and the same apiHandle endpoints the panel
// calls. A test file that imports this shares the setup, not a stand-in for it.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from '../test/fake-ctx.js'

export const PASSWORD = 'correct horse battery staple'
export const ALICE = '+8613800138000'
export const BOB = '+8613900139000'

export const TEAM = (main, second) => ({
  version: 1,
  mainBotIds: [main.id],
  workspaceId: 'w1',
  bots: {
    [main.id]: { ...main, sessionId: main.id, createdAt: 1 },
    [second.id]: { ...second, sessionId: second.id, createdAt: 2 },
  },
  rooms: {},
  agents: {},
  capabilities: { items: {} },
  exchanges: [],
  exchangeTurns: {},
  works: {},
  questions: {},
  views: {},
  prefs: {},
  switching: {},
  revision: 0,
})

export const ALICE_TEAM = TEAM(
  { id: 'a', name: 'Chief', role: 'Boss' },
  { id: 'a2', name: 'Researcher', role: 'Research' },
)
export const BOB_TEAM = TEAM(
  { id: 'b', name: 'BobChief', role: 'Boss' },
  { id: 'b2', name: 'BobWriter', role: 'Write' },
)

export async function withHub(t) {
  const { createHub } = await import('../../../hub/src/server.js')
  const { createMemoryLogger } = await import('../../../hub/src/log.js')
  const dataDir = mkdtempSync(join(tmpdir(), 'ds-bot-wg-realtime-hub-'))
  const hub = createHub({
    config: {
      host: '127.0.0.1', port: 0, tls: null, allowInsecure: true, insecureLoopbackOnly: true, dataDir,
      accessTtlMs: 30 * 60 * 1000, refreshTtlMs: 24 * 60 * 60 * 1000, logLevel: 'error',
    },
    logger: createMemoryLogger().logger,
  })
  const address = await hub.listen()
  const baseUrl = `http://127.0.0.1:${address.port}`
  t.after(async () => {
    await hub.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
  })
  for (const phone of [ALICE, BOB]) {
    await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password: PASSWORD }),
    })
  }
  return { hub, baseUrl }
}

// Starts a machine on an existing home. A coordinator restart is the same call with the same `home`:
// the workgroup state file and the Hub cursor survive, while every in-memory waiter, AbortController
// and round object does not. A test that needs a restart must use this seam rather than hand-writing
// the projection the product is expected to persist.
export async function openMachine(t, { baseUrl, phone, home, root, name = 'machine' }) {
  const ctx = fakeContext()
  const routes = {}
  const registerRoute = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return registerRoute(options)
  }
  const workspaces = new Map()
  const followups = []
  Object.assign(ctx, {
    llm: { listProviders: () => [] },
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
      create: async () => ({ sessionId: `s-${Math.random().toString(16).slice(2)}` }),
      resolveAgent: async sessionId => ({
        agent: {
          session: { id: sessionId },
          followup: (message) => { followups.push({ sessionId, message }) },
          cancel: () => {},
        },
      }),
      selectModel: async () => {},
      prompt: async ({ sessionId, content, source }) => {
        followups.push({ sessionId, message: { content, source } })
        return { accepted: true }
      },
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await rt.workgroup?.bridge?.stop?.().catch?.(() => {})
    // Flush BEFORE disposing: the effect that disposes state refuses later writes, so a save queued
    // after that point can still be in flight when the temp home is removed. Waiting here keeps the
    // teardown quiet and makes the test's temp directory safe to delete.
    await rt.workgroup?.flushSave?.().catch?.(() => {})
    await ctx.dispose()
    // A late `removeDir`/save continuation can still hold the state queue after dispose. Let the
    // event loop drain once before deleting the home; otherwise a test-only ENOENT warning appears
    // from a write that no longer matters.
    await new Promise(resolve => setTimeout(resolve, 25))
    await rt.workgroup?.flushSave?.().catch?.(() => {})
    removeTemp(root)
  })
  const wg = rt.workgroup
  const call = (endpoint, payload) => wg.apiHandle(endpoint, payload)
  const signedIn = await call('hub-login', { baseUrl, phone, password: PASSWORD })
  assert.equal(signedIn.ok, true, `sign-in failed: ${JSON.stringify(signedIn.error)}`)
  return { rt, wg, call, routes, followups, home, ctx }
}

export async function machine(t, { baseUrl, phone, team, name = 'machine' }) {
  const root = mkdtempSync(join(tmpdir(), `ds-bot-wg-realtime-${name}-`))
  const home = join(root, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  return openMachine(t, { baseUrl, phone, home, root, name })
}

export async function until(predicate, { timeoutMs = 8000, label = 'condition' } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// Reads one SSE frame at a time. A comment keeps the connection alive without becoming a frame.
export function reader(response) {
  const source = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return async function next() {
    for (;;) {
      const end = buffer.indexOf('\n\n')
      if (end >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (block.startsWith(':')) continue
        const field = name => block.split('\n').find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)
        return { event: field('event'), data: JSON.parse(field('data')) }
      }
      const { value, done } = await source.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
    }
  }
}

export async function invitedPair(t) {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM, name: 'alice' })
  const bob = await machine(t, { baseUrl, phone: BOB, team: BOB_TEAM, name: 'bob' })
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })
  const created = await alice.call('create-room', {
    name: '实时回归',
    members: [
      { id: 'a', name: 'Chief', kind: 'localBot' },
      { id: 'a2', name: 'Researcher', kind: 'localBot' },
    ],
  })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub?.workgroupId
  assert.ok(workgroupId !== undefined)
  const invited = await alice.call('invite-member', { workgroupId, phone: BOB })
  assert.equal(invited.ok, true, JSON.stringify(invited.error))
  const incoming = await bob.call('group-invites', {})
  const invite = incoming.value.incoming[0]
  const accepted = await bob.call('answer-invite', { inviteId: invite.inviteId, accept: true })
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error))
  const joined = await bob.wg.bridge.joinWithPrimaryBot({ workgroupId })
  assert.equal(joined.length, 1, 'Bob brings his own Bot explicitly')
  return { baseUrl, alice, bob, workgroupId }
}

// Windows can keep a just-closed file handle alive for a moment, especially when several realtime
// files run in parallel. The temp directory is disposable; a cleanup race is not a product failure
// and must not turn a green assertion into a red suite. Retry a few times, then warn and move on.
function removeTemp(root) {
  if (root === undefined) return
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
      return
    } catch (error) {
      if (attempt === 5) {
        console.warn(`ds-bot test cleanup left ${root}: ${error?.message ?? error}`)
        return
      }
      // A synchronous sleep is acceptable in a teardown hook and avoids a second event-loop turn.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

export function roomOf(machine, workgroupId) {
  return machine.wg.roomOfHubGroup(workgroupId)
}

export function lineByText(machine, workgroupId, text) {
  return (roomOf(machine, workgroupId)?.log ?? []).find(line => line.text === text)
}
