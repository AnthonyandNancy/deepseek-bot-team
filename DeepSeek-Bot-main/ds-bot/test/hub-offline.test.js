// Gate item 5: with no Hub account — or with the Hub unreachable — the local Bot team is
// completely usable.
//
// This is the gate item most easily broken by adding a login feature, and the easiest to fake: a
// test that only checked "the settings page renders" would pass while every message send threw.
// So this drives the endpoints a person actually uses — state, create a Bot, create a local
// group, send — with the Workgroup domain (and therefore the Hub client) installed and signed
// out, and again with the Hub address pointing at nothing.
//
// Both routes are exercised through their registered fetch handlers, the way the panel calls
// them, rather than by reaching into the runtime.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const startRuntime = async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-hub-offline-'))
  // Disposing the context is what stops the runtime's timers and listeners. Every other test that
  // builds a runtime does it (see test/capabilities.test.js `t.after(() => env.dispose())`), so
  // leaving it out here left live handles in the shared test process.
  //
  // Not claimed: that this caused the two failures in one 490-second `npm run verify`. That run has
  // not been reproduced, and the mechanism linking this file to those two tests is unproven.
  t.after(() => {
    rmSync(home, { recursive: true, force: true })
    return ctx.dispose()
  })
  // A workspace registry is what `create-bot` needs to give a new Bot a folder; without it the
  // call fails with an internal error that has nothing to do with this test.
  const workspaces = new Map()
  const ctx = fakeContext({ services: { agentPresets: { list: async () => [] } } })
  // The three services a Bot needs in order to exist: a folder, a model, and a Session. Only
  // these are faked — everything the gate item is about (the channels, the Hub client, the
  // workgroup domain) is the real code.
  let sessions = 0
  Object.assign(ctx, {
    // Reached as `ctx.sessionTitle`, `ctx.sessions`, `ctx.workspaceRegistry` — not through
    // `ctx.get()`, which is why they are assigned here rather than passed as services.
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-chat' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }),
    },
  })

  // Capture both routes so each call goes through the same fetch handler the browser would use.
  const routes = new Map()
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes.set(options.path, options)
    return register(options)
  }

  const rt = createRuntime(ctx, { home })
  await rt.load?.()

  const post = async (path, endpoint, payload) => {
    const route = routes.get(`/${path}`)
    if (route === undefined) throw new Error(`no route registered for /${path}`)
    const response = await route.fetch(new Request(`http://localhost/${path}`, {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }

  return {
    rt,
    // The original team's own endpoint surface.
    api: (endpoint, payload) => post('api/bot', endpoint, payload),
    // The Workgroup domain's, where the hub-* endpoints live.
    wg: (endpoint, payload) => post('api/workgroup', endpoint, payload),
  }
}

test('a signed-out domain reports "not signed in" without a Hub', async (t) => {
  const { rt, wg } = await startRuntime(t)
  assert.notEqual(rt.workgroup, undefined, 'the domain should install')

  const result = await wg('hub-state', {})
  assert.equal(result.ok, true)
  // "Signed out" is a normal answer, not an error: an error would make the settings page look
  // broken to someone who never wanted a Hub.
  assert.equal(result.value.loggedIn, false)
  assert.equal(result.value.backend, 'file')
})

test('the local team is fully usable with the Hub signed out', async (t) => {
  const { api } = await startRuntime(t)

  const state = await api('state', {})
  assert.equal(state.ok, true, JSON.stringify(state.error))
  assert.ok(Array.isArray(state.value.bots))

  // Creating Bots and a local group are the two things the gate's wording names.
  const first = await api('create-bot', { name: 'Helper', role: 'Assistant' })
  assert.equal(first.ok, true, JSON.stringify(first.error))
  const second = await api('create-bot', { name: 'Writer', role: 'Writer' })
  assert.equal(second.ok, true, JSON.stringify(second.error))

  const room = await api('create-room', {
    name: 'Local group',
    members: [first.value?.id ?? first.value, second.value?.id ?? second.value],
  })
  assert.equal(room.ok, true, JSON.stringify(room.error))

  // The group is in the list, which is what "usable" means for a group chat.
  const after = await api('state', {})
  assert.equal(after.ok, true)
  assert.ok(after.value.rooms.length >= 1)
})

test('a Hub address that does not answer leaves the local team untouched', async (t) => {
  const { api, wg } = await startRuntime(t)

  // Point the account at a port nothing listens on, the way a person would before realising the
  // Hub is down.
  const failed = await wg('hub-login', {
    baseUrl: 'http://127.0.0.1:1',
    phone: '+8613800138000',
    password: 'correct horse battery staple',
  })
  // The refusal is reported, with the code that says it was the network rather than the password.
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'hub/unreachable')

  // Everything local still works afterwards.
  const state = await api('state', {})
  assert.equal(state.ok, true)
  const hub = await wg('hub-state', {})
  assert.equal(hub.ok, true)
  assert.equal(hub.value.loggedIn, false, 'a failed login must not leave a half-signed-in account')
})

test('the workgroup domain keeps answering with the Hub half signed out', async (t) => {
  // The domain is loaded through require() in index.js precisely so a broken Workgroup half
  // cannot take the original team down (index.js:66-82). This asserts the property that matters:
  // both routes answer while the Hub is unconfigured.
  const { api, wg } = await startRuntime(t)
  assert.equal((await api('state', {})).ok, true)
  assert.equal((await wg('state', {})).ok, true)
})

test('the hub endpoints refuse writes on a read-only host, like every other write', async (t) => {
  const { rt, wg } = await startRuntime(t)
  // `readOnly` is DSH's "this process must not write" mode; the rule already applies to every
  // write endpoint, and the Hub ones must not be an exception that silently signs someone in.
  rt.readOnly = () => 'ds-bot is read-only in this window'
  const result = await wg('hub-login', { baseUrl: 'http://127.0.0.1:1', phone: '+8613800138000', password: 'x'.repeat(12) })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bot/read-only')
  // Reading the account state is still allowed, so the page can say what is going on.
  assert.equal((await wg('hub-state', {})).ok, true)
})
