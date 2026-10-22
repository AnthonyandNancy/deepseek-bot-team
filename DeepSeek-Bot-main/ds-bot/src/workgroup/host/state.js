// Workgroup state: a file of its own, written whole on every save, exactly like the
// original ../host/store.js does for the Bot team. The two files never overlap:
//   $DSH_HOME/bot/state.json              <- the original team (local groups, Bots)
//   $DSH_HOME/bot/workgroup/state.json    <- this domain (workgroups, links, owners)
//
// Nothing in the original state is read or written here, and the original never
// reads this file, so a broken Workgroup file cannot damage the local team.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WG_DIR, WG_STATE_FILE, WG_STATE_VERSION } from '../shared/constants.js'

const emptyState = () => ({
  version: WG_STATE_VERSION,
  revision: 0,
  workgroups: {},
  // localRoomId -> { workgroupId, hubUserId, status, upgradeId, createdAt }
  links: {},
  // sessionId -> { kind, hubUserId, deviceId, botId, workgroupId, taskId, ... }
  sessionOwners: {},
  // taskId -> the grant a task binds, plus its lifecycle state (host/tasks.js). The plan
  // (§6.4) requires these bindings to be persisted and rebuilt after a restart, so they
  // live in this domain's own file and never in the local team's.
  tasks: {},
})

// Only what this domain understands is kept; an unknown or older shape resets to
// empty rather than throwing, because the original team must stay usable.
function adopt(raw) {
  if (raw === null || typeof raw !== 'object' || raw.version !== WG_STATE_VERSION) return emptyState()
  const state = emptyState()
  if (Number.isFinite(raw.revision)) state.revision = raw.revision
  for (const key of ['workgroups', 'links', 'sessionOwners', 'tasks']) {
    const value = raw[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) state[key] = value
  }
  return state
}

export function install(wg) {
  const { rt } = wg
  const home = join(rt.home, WG_DIR)
  const statePath = join(home, WG_STATE_FILE)
  let state = emptyState()
  let loading = null
  let writing = Promise.resolve()
  let stopped = false

  // The promise is cached, not a boolean flag: two callers that arrive while the file
  // is still being read must both wait for the same read. With a plain flag the second
  // caller would get the pre-load empty state and could write it back over the file.
  function load() {
    loading ??= (async () => {
      try {
        state = adopt(JSON.parse(await readFile(statePath, 'utf8')))
      } catch (error) {
        // A missing file is the first run; anything else is reported and the domain
        // starts empty rather than refusing to work.
        if (error?.code !== 'ENOENT') rt.warn('ds-bot: workgroup state not read (%s); starting empty', error?.message ?? error)
        state = emptyState()
      }
      wg.state = state
      // ownership.install ran before the file was read, so the map is (re)built here,
      // from exactly what was persisted.
      if (typeof wg.onStateLoaded === 'function') wg.onStateLoaded()
      return state
    })()
    return loading
  }

  const save = () => {
    if (stopped) return writing
    // `wg.state` is the one object the rest of the domain mutates (ownership index,
    // groups), so it — not a local binding — is what gets written.
    const current = wg.state
    current.revision += 1
    const snapshot = JSON.stringify(current)
    writing = writing.then(async () => {
      const temp = `${statePath}.${process.pid}.tmp`
      try {
        await mkdir(dirname(statePath), { recursive: true })
        await writeFile(temp, snapshot, 'utf8')
        await rename(temp, statePath)
      } catch (error) {
        rt.warn('ds-bot: workgroup state write failed: %s', error?.message ?? error)
        throw error
      }
    })
    return writing.catch(() => {})
  }

  const workgroupOf = id => (id === undefined ? undefined : wg.state.workgroups[id])
  const workgroups = () => Object.values(wg.state.workgroups)
  const linkOf = (localRoomId) => (localRoomId === undefined ? undefined : wg.state.links[localRoomId])

  Object.assign(wg, {
    load,
    save,
    statePath,
    workgroupOf,
    workgroups,
    linkOf,
  })
  wg.state = state

  // Flush whatever is queued before the plugin goes away, and refuse later writes.
  wg.ctx.effect(() => () => {
    stopped = true
    return writing.catch(() => {})
  }, 'ds-bot: workgroup state')
}
