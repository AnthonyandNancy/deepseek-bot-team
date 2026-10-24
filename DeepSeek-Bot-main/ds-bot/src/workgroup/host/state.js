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
  // taskId -> the approval card a request became (host/task-runner.js). Persisted because a
  // request that arrives while the panel is closed must still be there when somebody opens it,
  // and a restart must not make a pending approval silently disappear.
  taskRequests: {},
  // taskId -> the request this machine sent and has not seen answered. Local only: the Hub's
  // task row is the record, and this is what the panel polls between a send and its answer.
  taskOutbox: {},
  // runId -> { deliveredAt } for a task run that has already been handed to its Session. This is the
  // durable side-effect fence: a replayed start must not prompt the Bot a second time.
  taskRuns: {},
  // endpointId -> local Bot id, for the Bot endpoints THIS machine published.
  //
  // The Hub answers a group's roster with endpoint ids only (`ep_…`), because that is what a
  // member is on the wire. From that answer alone this machine cannot tell which endpoints are its
  // OWN Bots, and getting it wrong is not cosmetic: a member whose kind is not `localBot` is handed
  // to the Hub instead of to a local Session, so this machine's own Bot was asked — over the Hub —
  // to answer a question it had itself been told to send, and no member ever replied.
  //
  // Kept here rather than on the Hub because "which of my Bots is this endpoint" is a fact about
  // this device, not about the group: the same room resolves differently on every machine, and
  // that is correct. Rebuilt by `publishBotEndpoints` on every start, so a lost file heals.
  endpointBots: {},
  // The work Bots hand each other (host/handoffs.js): who asked whom, and what is still
  // out. Persisted because a Bot that asked for work waits across a restart, and losing the
  // record would leave it waiting for an answer nothing will ever send. It lives here and
  // not in the original's `state.works`, so one domain's hand-offs can never be read as the
  // other's.
  works: {},
  // roundId -> the obligations of a round that has not finished. Round objects hold signals and
  // promise resolvers that cannot be serialized; this projection holds only what a restarted
  // coordinator needs to find the answer on the Hub and decide whether the round may continue.
  rounds: {},
})

// Only what this domain understands is kept; an unknown or older shape resets to
// empty rather than throwing, because the original team must stay usable.
function adopt(raw) {
  if (raw === null || typeof raw !== 'object' || raw.version !== WG_STATE_VERSION) return emptyState()
  const state = emptyState()
  if (Number.isFinite(raw.revision)) state.revision = raw.revision
  for (const key of ['workgroups', 'links', 'sessionOwners', 'tasks', 'taskRequests', 'taskOutbox', 'taskRuns', 'endpointBots', 'works', 'rounds']) {
    const value = raw[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) state[key] = value
  }
  // A group file written by an earlier version carries `permission: null` for every group, which
  // means "no shared preset" but reads as "shared preset set" to both consumers: the toggle drew as
  // ON and the picker highlighted no preset. The field is absent for that state in an original group
  // (`src/host/permissions.js:64` deletes it), so dropping the key on load heals a group made before
  // this fix instead of making the user toggle it off and on again.
  for (const room of Object.values(state.workgroups)) {
    if (room !== null && typeof room === 'object' && room.permission === null) delete room.permission
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

  const save = (context = {}) => {
    if (stopped) return writing
    // `wg.state` is the one object the rest of the domain mutates (ownership index,
    // groups), so it — not a local binding — is what gets written.
    const current = wg.state
    current.revision += 1
    // The original feed is the browser's one live transport; tell it that this file moved. The
    // domain's save has already mutated the record by now, so the receiver can re-read `room` or
    // `group-members` immediately. A failure to notify must never fail the save.
    try {
      rt.workgroupStateSaved?.({
        revision: current.revision,
        ...(typeof context.workgroupId === 'string' ? { workgroupId: context.workgroupId } : {}),
        ...(typeof context.roomId === 'string' ? { roomId: context.roomId } : {}),
        ...(typeof context.kind === 'string' ? { kind: context.kind } : {}),
      })
    } catch { /* a window refresh is best effort */ }
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

  // Waits for every save queued so far to finish. The bridge uses it before handing a remote call
  // to the Hub: the exchange must be on disk BEFORE the call can produce an answer. A rejection is
  // already logged per write; this only reports that the queue drained.
  const flushSave = () => writing.catch(() => {})

  Object.assign(wg, {
    load,
    save,
    flushSave,
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
