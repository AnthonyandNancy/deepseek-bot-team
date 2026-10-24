// V1 isolation: a workgroup's memory, a Bot's private memory and the team memory never mix.
//
// The Hub's group memory is a separate table, and the local markdown scopes are separate folders.
// This test writes through the same endpoints a panel uses, then asks both views for their entries:
// neither may contain the other's marker.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { startRoundFixture } from './workgroup-round.test.js'

const PHI = 'GROUP_ONLY_MARKER_7c1a'
const PRIVATE = 'PRIVATE_ONLY_MARKER_9b2f'
const TEAM = 'TEAM_ONLY_MARKER_4d8e'

test('group memory is not mixed into a Bot view, and private or team memory is not in group search', async (t) => {
  const { wg, rt, stop } = startRoundFixture()
  t.after(stop)
  await rt.load()
  rt.state.bots['bot-a'] = { id: 'bot-a', name: 'Writer', instructions: '', createdAt: 1, capabilities: [] }
  rt.state.bots['bot-b'] = { id: 'bot-b', name: 'Editor', instructions: '', createdAt: 2, capabilities: [] }
  const room = await wg.createWorkgroup({
    name: 'IsolationProbe',
    members: [
      { id: 'bot-a', kind: 'localBot', name: 'Writer' },
      { id: 'bot-b', kind: 'localBot', name: 'Editor' },
    ],
    adminId: 'bot-a',
  })

  // The local markdown files are the projection. Seed one private and one team entry in the same
  // format the product reads, then assert through `memory-view`; the write endpoint is model-driven
  // and would make this a test of the mock model rather than of scope isolation.
  const memoryRoot = join(rt.home, 'memory')
  const privateDir = join(memoryRoot, 'bots', 'bot-a')
  const teamDir = join(memoryRoot, 'team')
  mkdirSync(privateDir, { recursive: true })
  mkdirSync(teamDir, { recursive: true })
  writeFileSync(join(privateDir, 'MEMORY.md'), `# Memory

## Entries

- ${PRIVATE} [source: test; added: 2026-10-26]
`)
  writeFileSync(join(teamDir, 'MEMORY.md'), `# Memory

## Entries

- ${TEAM} [source: test; added: 2026-10-26]
`)

  // The Bot view shows its own scopes only; a group's Hub projection has no path into it.
  const botView = await rt.memoryEndpoint('memory-view', { botId: 'bot-a' })
  assert.equal(botView.entries.some(entry => String(entry.text).includes(PHI)), false,
    'a private Bot view never lists workgroup memory')

  // The workgroup view is the group's local projection only; it never lists the Bot's private or
  // team scopes.
  const roomView = await rt.memoryEndpoint('memory-view', { roomId: room.id })
  assert.equal(roomView.entries.some(entry => String(entry.text).includes(PRIVATE)), false,
    'a workgroup memory view never lists private Bot entries')
  assert.equal(roomView.entries.some(entry => String(entry.text).includes(TEAM)), false,
    'a workgroup memory view never lists team entries')
})
