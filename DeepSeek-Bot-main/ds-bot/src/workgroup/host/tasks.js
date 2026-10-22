// The Task Session registry: the local, durable half of a cross-user task (plan §6.4,
// §10.2, §10.3).
//
// An authorization that B granted binds `taskId`, `ownerUserId`, `botId`, `sessionId`,
// `resources`, `capabilities` and `expiresAt`. Those bindings are kept HERE, in this
// domain's own state file, and rebuilt after a restart — the plan requires the mapping to
// be transactional and to be checked against the Sessions that really exist, so a
// restart can neither orphan a task Session nor hand out an authorization that has lapsed.
//
// What this is NOT (yet):
//   * no Hub routing, no signatures, no cross-user delivery — plan G4/G5;
//   * no approval UI — plan G5.
// G2 asks for the registry and the strict resolver behind it, and nothing wider.
//
// The state machine is plan §10.2's, with the transitions it allows and no others: an
// unapproved task can never be RUNNING, and a cancelled one can never start again. A
// transition that is not listed is refused rather than coerced, because a task record that
// says RUNNING for work nobody approved is exactly what this registry must never hold.

import { OWNER_KINDS } from './ownership.js'

// Plan §10.2, in order, plus its branches.
export const TASK_STATES = [
  'REQUESTED', 'DELIVERED', 'PENDING_APPROVAL', 'APPROVED', 'ASSIGNED', 'RUNNING',
  'RESULT_REVIEW', 'COMPLETED',
  'REJECTED', 'EXPIRED', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED', 'INTERRUPTED',
]

// A state a task never leaves. Nothing may follow these, so a finished task's history
// cannot be rewritten into a new run.
const FINAL = ['COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED']

// Only these moves are allowed. The plan's rule is that a transition is legal only from
// the state it names; everything else — including any move out of a final state — throws.
const TRANSITIONS = {
  REQUESTED: ['DELIVERED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  DELIVERED: ['PENDING_APPROVAL', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  APPROVED: ['ASSIGNED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  ASSIGNED: ['RUNNING', 'EXPIRED', 'CANCELLED', 'FAILED', 'INTERRUPTED'],
  RUNNING: ['RESULT_REVIEW', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED', 'INTERRUPTED', 'COMPLETED'],
  RESULT_REVIEW: ['COMPLETED', 'CANCELLED', 'FAILED'],
  CANCEL_REQUESTED: ['CANCELLED', 'FAILED'],
  // Work cut off by a restart: the same task may be picked back up, but only through the
  // states that mean "it is not running now".
  INTERRUPTED: ['ASSIGNED', 'RUNNING', 'CANCELLED', 'FAILED'],
}

// The states in which a task is still worth acting on. Anything else is history.
const LIVE = ['REQUESTED', 'DELIVERED', 'PENDING_APPROVAL', 'APPROVED', 'ASSIGNED', 'RUNNING', 'RESULT_REVIEW', 'CANCEL_REQUESTED', 'INTERRUPTED']

const need = (value, name, pattern) => {
  if (typeof value !== 'string' || value === '') throw new Error(`ds-bot: a task needs a ${name}`)
  if (pattern !== undefined && !pattern.test(value)) throw new Error(`ds-bot: a task's ${name} is not usable: ${value}`)
  return value
}

export function install(wg) {
  // Plan §6.4's binding, validated as a whole before anything is written.
  function cleanGrant(input) {
    if (input === null || typeof input !== 'object') throw new Error('ds-bot: a task needs a grant record')
    const taskId = need(input.taskId, 'taskId')
    const sessionId = need(input.sessionId, 'sessionId')
    const botId = need(input.botId, 'botId')
    const workgroupId = need(input.workgroupId, 'workgroupId')
    const authorizationId = need(input.authorizationId, 'authorizationId')
    if (!Number.isFinite(input.expiresAt)) throw new Error('ds-bot: a task needs an expiresAt time')
    const allowedResources = input.allowedResources ?? []
    if (!Array.isArray(allowedResources) || allowedResources.some(item => typeof item !== 'string')) {
      throw new Error('ds-bot: a task\'s allowedResources must be a list of strings')
    }
    return {
      taskId,
      sessionId,
      botId,
      workgroupId,
      authorizationId,
      ...(typeof input.hubUserId === 'string' ? { hubUserId: input.hubUserId } : {}),
      ...(typeof input.deviceId === 'string' ? { deviceId: input.deviceId } : {}),
      allowedResources: [...allowedResources],
      ...(Array.isArray(input.capabilities) ? { capabilities: [...input.capabilities] } : {}),
      expiresAt: input.expiresAt,
    }
  }

  // The registry is the state file's `tasks`, mirrored in memory. Both are keyed by taskId.
  const tasks = () => {
    wg.state.tasks ??= {}
    return wg.state.tasks
  }
  const map = new Map()
  wg.tasks = map

  // Registers a granted task and claims its Session in one step.
  //
  // The Session claim comes FIRST and the record is written only after it succeeds: a
  // record pointing at an unowned Session would be the exact window the strict resolver
  // must never see, and a refused claim must leave no half-registered task behind.
  function registerTask(input) {
    const grant = cleanGrant(input)
    const existing = tasks()[grant.taskId]
    if (existing !== undefined) throw new Error(`ds-bot: task ${grant.taskId} is already registered`)
    // `registerSessionOwner` refuses a Session the original domain already holds, and one
    // this domain already owns under another group. Either is a double claim, not a
    // rebind, so the refusal is allowed to escape and nothing is written.
    wg.registerSessionOwner(grant.sessionId, {
      kind: 'task',
      workgroupId: grant.workgroupId,
      taskId: grant.taskId,
      botId: grant.botId,
      ...(grant.hubUserId !== undefined ? { hubUserId: grant.hubUserId } : {}),
      ...(grant.deviceId !== undefined ? { deviceId: grant.deviceId } : {}),
    })
    const record = {
      ...grant,
      state: 'APPROVED',
      version: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    tasks()[grant.taskId] = record
    map.set(grant.taskId, record)
    void wg.save().catch(() => {})
    return record
  }
  wg.registerTask = registerTask

  // One task, by id, whatever state it is in — the record the UI and the audit read.
  const taskOf = taskId => (taskId === undefined ? undefined : tasks()[taskId])
  wg.taskOf = taskOf

  const expired = record => !Number.isFinite(record?.expiresAt) || Date.now() >= record.expiresAt

  // A task that may still be acted on: on record, in a live state, and not expired.
  // Expiry is a separate answer from the state machine — a lapsed authorization stops
  // being usable without its record being rewritten, so the history stays intact.
  function liveTask(taskId) {
    const record = taskOf(taskId)
    if (record === undefined) return undefined
    if (!LIVE.includes(record.state)) return undefined
    if (expired(record)) return undefined
    return record
  }
  wg.liveTask = liveTask

  // Every task of one owner, newest first. `owner` is any of the binding's identifiers,
  // so a Hub user's tasks, one Bot's tasks and one workgroup's tasks are all answerable.
  function tasksOf(owner = {}) {
    const wanted = ['taskId', 'sessionId', 'botId', 'workgroupId', 'hubUserId', 'deviceId', 'authorizationId']
      .filter(key => owner[key] !== undefined)
    if (wanted.length === 0) return Object.values(tasks())
    return Object.values(tasks())
      .filter(record => wanted.every(key => record[key] === owner[key]))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }
  wg.tasksOf = tasksOf

  // A move the plan allows, or a refusal. `version` is bumped on every accepted
  // transition so a stale caller's request cannot land on top of a newer state.
  function advanceTask(taskId, next, { version } = {}) {
    const record = taskOf(taskId)
    if (record === undefined) throw new Error(`ds-bot: no task ${taskId}`)
    if (!TASK_STATES.includes(next)) throw new Error(`ds-bot: unknown task state "${next}"`)
    if (version !== undefined && version !== record.version) {
      throw new Error(`ds-bot: task ${taskId} moved on (version ${record.version}, not ${version})`)
    }
    if (FINAL.includes(record.state)) throw new Error(`ds-bot: task ${taskId} is ${record.state}; not allowed`)
    const allowed = TRANSITIONS[record.state] ?? []
    if (!allowed.includes(next)) throw new Error(`ds-bot: task ${taskId}: ${record.state} -> ${next} is not allowed`)
    // An authorization that has lapsed cannot become running work, whatever the caller
    // believes: the grant's expiry is checked at the transition, not only at the lookup.
    if (next === 'RUNNING' && expired(record)) throw new Error(`ds-bot: task ${taskId}'s authorization has expired; not allowed to start`)
    record.state = next
    record.version += 1
    record.updatedAt = Date.now()
    void wg.save().catch(() => {})
    return record
  }
  wg.advanceTask = advanceTask

  // Forgets a task and frees the Session it held. The Session itself is the caller's to
  // archive; what this domain must not keep is a claim on a Session nobody owns.
  function releaseTask(taskId) {
    const record = taskOf(taskId)
    if (record === undefined) return false
    wg.releaseSessionOwner(record.sessionId)
    delete tasks()[taskId]
    map.delete(taskId)
    void wg.save().catch(() => {})
    return true
  }
  wg.releaseTask = releaseTask

  // Rebuilt from the state file, exactly like the Session owner index and from the same
  // hook: state.load reads the file and then calls this once, so nothing stale survives a
  // restart and a task registered before the first read is not lost.
  function indexTasks() {
    map.clear()
    for (const [taskId, record] of Object.entries(wg.state.tasks ?? {})) {
      if (record === null || typeof record !== 'object') continue
      if (typeof record.sessionId !== 'string' || record.sessionId === '') continue
      if (!OWNER_KINDS.includes('task') || !TASK_STATES.includes(record.state)) continue
      map.set(taskId, record)
    }
  }
  wg.indexTasks = indexTasks

  // state.js calls ONE `onStateLoaded`; ownership.js claimed it first. Chain rather than
  // overwrite, or whichever installed last would silently drop the other's rebuild.
  const previous = wg.onStateLoaded
  wg.onStateLoaded = () => {
    if (typeof previous === 'function') previous()
    indexTasks()
  }
}
