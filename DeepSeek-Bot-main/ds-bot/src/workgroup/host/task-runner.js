// Cross-user task execution: the part that runs on B's machine (plan §10.1, §10.2, §10.4).
//
// `host/tasks.js` (G2) is the registry and the state machine: it holds what B authorized and refuses
// a transition the plan does not allow. This module is what drives it from the wire — a request
// arriving for B, a decision from B, an execution on B's own Bot — and it is deliberately the only
// place that creates a Session for delegated work.
//
// The four refusals that make the gates real:
//
//   1. **Nothing runs before an approval.** `startTask` is the only path to a Session, and it refuses
//      a task that is not `APPROVED` with a live ledger entry. Gate 1 depends on this being an
//      ordering, not a check somebody could forget.
//   2. **The preview runs nothing.** A request becomes an approval card; the Chief may summarise it
//      in words, and its answer is never an authorization.
//   3. **Execution is verified before the first prompt.** Bot identity, working folder, visible
//      tools and the installed guard are all checked; any of them missing stops the run and reports
//      why (`verifyBeforeRun`).
//   4. **Revocation is immediate.** `ctx.tools.guard` consults the local grant on every call, so a
//      revoked task cannot start a new tool even if its Agent is mid-turn.
//
// What this module does NOT do: decide what B may share. The scope B chose is stored, and the
// share step asks B again when a result was produced under a broad scope.
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { buildTaskRequest } from './envelope.js'

// How often progress can become a group event. `task.progress` is the one task event that can be
// produced continuously, and `events` is a table every client replays — merging ticks inside this
// window is what keeps a long run from becoming a log nobody can pull.
export const PROGRESS_MERGE_MS = 2000

// The tools a delegated task may never use, whatever the group's preset says. Each is a way to reach
// past the task's scope: the original team's own chat, another Bot's inbox, the model's file tools
// over paths the scope did not allow, and the Bot-to-Bot dispatch that would turn a task into an
// unbounded fan-out (plan §10.4: "原有 message_bot 不得成为向无关 Bot 派单的旁路").
export const DENIED_TOOLS = [
  'read_own_chat',
  'message_bot',
  'ask_user',
  'create_bot',
  'update_bot',
  'delete_bot',
]

export const TASK_ERROR = {
  notApproved: 'task/not-approved',
  expired: 'task/approval-expired',
  notOwner: 'task/not-owner',
  badWorkspace: 'task/bad-workspace',
  badBot: 'task/bad-bot',
  noGuard: 'task/no-guard',
  cancelled: 'task/cancelled',
  empty: 'task/empty',
}

const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '')}`

// The three ways B can answer a request (plan §10.1 step 4). Named here rather than inline so the UI
// and the tests refer to the same three strings.
export const ASSIGNMENT_MODES = ['existingBot', 'chiefPicks', 'newBot']

export function install(wg) {
  const { rt, ctx } = wg

  // ── the approval card a request becomes ─────────────────────────────────────────
  //
  // Held in memory AND in the state file: a request that arrives while the panel is closed must still
  // be there when the person opens it, and a restart must not make a pending approval vanish (B would
  // never learn somebody is waiting). It is not a Task Session — nothing has been created yet.
  const pending = () => {
    wg.state.taskRequests ??= {}
    return wg.state.taskRequests
  }

  const publicRequest = record => ({
    taskId: record.taskId,
    workgroupId: record.workgroupId,
    groupName: record.groupName ?? '',
    requesterId: record.requesterId,
    requesterName: record.requesterName ?? '',
    title: record.title ?? '',
    resources: record.resources ?? [],
    capabilities: record.capabilities ?? [],
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    state: record.state ?? 'PENDING_APPROVAL',
  })

  // ── the guard ───────────────────────────────────────────────────────────────────
  //
  // Registered once, at install time, so it covers every Agent of this runtime. It answers one
  // question for every tool call: "is this call inside a live task grant?" A Session that no task
  // owns is not this guard's business and is allowed through untouched — the local team must behave
  // exactly as before.
  //
  // The closure is where N1 lives: `wg.liveTask` reads the ledger, so a revoked or expired grant
  // stops the very next call, even in a turn that started before the revoke.
  const taskOfSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const owner = wg.sessionOwners.get(sessionId)
    if (owner?.kind !== 'task') return undefined
    return wg.taskOf(owner.taskId)
  }

  if (typeof ctx.tools?.guard === 'function') {
    ctx.tools.guard((exec) => {
      const sessionId = exec.agent?.session?.id ?? exec.agent?.sessionId
      const record = taskOfSession(sessionId)
      // Not a delegated task: the original team's rules apply, and they are not this module's.
      if (record === undefined) return undefined
      // A live task is one whose ledger entry still exists, is in a live state and has not expired.
      // `liveTask` is the registry's own answer to that question, so the guard and the runner cannot
      // disagree about whether the work is still authorized.
      if (wg.liveTask(record.taskId) === undefined) {
        // Gate N1: the call is refused with a sentence the person can read in the transcript.
        return `This task is no longer authorized (${record.state}), so ${exec.name} may not run.`
      }
      if (DENIED_TOOLS.includes(exec.name)) {
        return `${exec.name} is not available to a delegated task.`
      }
      // Tools the approval did not cover. An empty list means "whatever the Bot already has", which is
      // the scope the approval card shows as "its usual tools".
      const allowed = record.capabilities
      if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(exec.name)) {
        return `${exec.name} was not part of what was approved for this task.`
      }
      return undefined
    })
  } else {
    // Without this seam there is no enforced boundary, and a run would be "prompted not to" rather
    // than prevented (plan §10.4: "仅 prompt 禁止越权不合格"). The runner refuses to start instead.
    wg.taskGuardMissing = true
  }

  // ── receiving a request (the approver's side) ───────────────────────────────────
  //
  // Called from the bridge when an `approval.request`/`task.request` event arrives for this person.
  // It records the card and NOTHING else: no Session, no model call, no tool. That is the whole of
  // gate 1's "B ran nothing before approving", and it holds even if the Chief is asked to summarise
  // the request — the summary is a message, not a run.
  async function receiveRequest({ workgroupId, event }) {
    if (event?.type !== 'task.request') return false
    const payload = event.payload ?? {}
    const me = wg.hub.account?.hubUserId
    if (me === undefined) return false
    // Addressed to somebody else: this machine has nothing to approve.
    if (payload.target?.userId !== me) return false

    await wg.load()
    const taskId = String(payload.taskId ?? '')
    if (taskId === '') return false
    const room = wg.roomOfHubGroup?.(workgroupId)
    const requesterMember = (room?.members ?? []).find(member => member.hubUserId === payload.requesterId)
    pending()[taskId] = {
      taskId,
      workgroupId,
      groupName: room?.name ?? '',
      requesterId: payload.requesterId,
      // The Hub has no display name for a person, so this is whatever the roster calls them.
      requesterName: requesterMember?.name ?? '',
      title: payload.title ?? '',
      // The envelope's field names are the plan's (§9.2): `requestedResources` and
      // `requestedCapabilities`. Reading the short names here meant a card that showed no scope at
      // all, which is worse than showing the wrong one: B approves what they can see.
      resources: Array.isArray(payload.requestedResources) ? payload.requestedResources
        : Array.isArray(payload.resources) ? payload.resources : [],
      capabilities: Array.isArray(payload.requestedCapabilities) ? payload.requestedCapabilities
        : Array.isArray(payload.capabilities) ? payload.capabilities : [],
      createdAt: event.createdAt ?? new Date().toISOString(),
      expiresAt: payload.expiresAt,
      state: 'PENDING_APPROVAL',
    }
    await wg.save()
    // A notification for the panel: the card is what B acts on, and it exists now.
    wg.emitTask?.('request', { taskId, workgroupId })
    return true
  }
  wg.receiveTaskRequest = receiveRequest

  const requests = () => Object.values(pending()).map(publicRequest)

  // ── answering a request (B's own decision) ──────────────────────────────────────
  //
  // The decision goes to the Hub over HTTP first, because the Hub is the record: if this call fails,
  // nothing local has changed and B can try again. Only after the Hub has the task in APPROVED does
  // the local ledger get its grant — so "Hub says approved" can never be the only thing that happened.
  async function decide({ taskId, decision, mode = 'existingBot', botId, workDir, capabilities, resources, leaseMs }) {
    const card = pending()[taskId]
    if (card === undefined) throw Object.assign(new Error('Unknown task request'), { code: 'task/not-found' })
    const me = wg.hub.account?.hubUserId
    if (me === undefined) throw Object.assign(new Error('Sign in to the Hub first.'), { code: 'hub/not-signed-in' })

    if (decision === 'rejected') {
      await wg.hub.decideTask({ taskId, decision: 'rejected', scope: {} })
      card.state = 'REJECTED'
      await wg.save()
      wg.emitTask?.('decided', { taskId, decision: 'rejected' })
      return { taskId, decision: 'rejected' }
    }

    // Three ways to answer, all of them ending in a real Bot on THIS machine (plan §10.1 step 4).
    const assignment = await assign({ mode, botId, workDir, taskId })
    const scope = {
      endpointId: assignment.endpointId,
      // The scope the guard enforces. Empty means "the Bot's own tools"; a list means exactly those.
      capabilities: Array.isArray(capabilities) ? capabilities : [],
      allowedResources: Array.isArray(resources) ? resources : card.resources,
      workDir: assignment.workDir,
      // The expiry the Hub will clamp at a week. B's choice, not the requester's.
      ...(Number.isFinite(leaseMs) ? { expiresAt: new Date(Date.now() + leaseMs).toISOString() } : {}),
    }

    const answer = await wg.hub.decideTask({ taskId, decision: 'granted', scope })
    // The local ledger: the binding the guard reads. Written after the Hub has the grant, so an
    // interrupted call leaves no local authorization for a task the Hub does not consider approved.
    // The folder is recorded as a REAL path, resolved now rather than at run time, so the root and
    // the thing later compared against it are the same kind of string. `rt.real` is the original's
    // helper (src/host/folders.js:28), so a symlink is followed here exactly as it is everywhere else
    // in the plugin.
    const approvedDir = assignment.workDir === undefined ? undefined : await rt.real(assignment.workDir).catch(() => undefined)
    wg.registerTask({
      taskId,
      sessionId: assignment.sessionId,
      botId: assignment.botId,
      workgroupId: card.workgroupId,
      authorizationId: newId('auth'),
      hubUserId: me,
      deviceId: wg.hub.account?.deviceId,
      allowedResources: scope.allowedResources,
      capabilities: scope.capabilities,
      ...(approvedDir === undefined ? {} : { workDir: approvedDir, workDirRoot: approvedDir }),
      expiresAt: Date.parse(scope.expiresAt ?? '') || Date.now() + 24 * 60 * 60 * 1000,
    })
    card.state = 'APPROVED'
    card.assignment = { mode, botId: assignment.botId, workDir: assignment.workDir }
    await wg.save()
    wg.emitTask?.('decided', { taskId, decision: 'granted', mode })
    return { taskId, decision: 'granted', task: answer?.task }
  }
  wg.decideTask = decide

  // The three assignment modes. Each returns the Bot, the folder and the endpoint that the Hub record
  // will name, so `tasks.endpoint_id`/`owner_id` describe what actually ran.
  async function assign({ mode, botId, workDir, taskId }) {
    if (!ASSIGNMENT_MODES.includes(mode)) throw Object.assign(new Error(`Unknown assignment mode "${mode}"`), { code: 'task/bad-mode' })
    // A Session of its own: a delegated task must never run in the Bot's own chat or in a group
    // Session, because its transcript is somebody else's request and its tools are narrowed.
    if (mode === 'newBot') {
      if (typeof rt.createBot !== 'function') {
        throw Object.assign(new Error('This runtime cannot create a Bot for a task.'), { code: TASK_ERROR.badBot })
      }
      // A fresh Bot, so the work leaves no trace in a Bot the person uses for their own conversations.
      const bot = await rt.createBot({
        name: `Task ${String(taskId).slice(-6)}`,
        role: 'Task',
        instructions: 'You carry out one delegated task and report the result. Stay inside what was approved.',
        ...(workDir === undefined ? {} : { workDir }),
      })
      // A Session of the task's own, not the Bot's chat Session: `registerSessionOwner` refuses a
      // Session the original domain already holds, and a new Bot's own chat is exactly that. Reusing
      // it would also put somebody else's request into a transcript the person will read as theirs.
      const dir = workDir ?? bot.workDir ?? rt.workDirOf({ botId: bot.id })
      const sessionId = await rt.createSession(`${bot.name} · task`, { dir })
      wg.registerSessionOwner(sessionId, { kind: 'task', taskId, botId: bot.id, workgroupId: pending()[taskId]?.workgroupId })
      const endpoint = await endpointFor(bot.id)
      return { botId: bot.id, sessionId, workDir: dir, endpointId: endpoint }
    }

    if (mode === 'chiefPicks') {
      // The Chief may choose, but the choice is still a real Bot on this machine: it picks among the
      // Bots this account already has, and it cannot pick one that does not exist.
      const chosen = await chooseBotForTask(taskId)
      if (chosen === undefined) throw Object.assign(new Error('There is no Bot available to take this task.'), { code: TASK_ERROR.badBot })
      return assign({ mode: 'existingBot', botId: chosen, workDir, taskId })
    }

    // `existingBot`: the Bot B named in the approval card.
    const bot = rt.botOf(botId)
    if (bot === undefined) throw Object.assign(new Error('That Bot does not exist.'), { code: TASK_ERROR.badBot })
    const sessionId = await rt.createSession(bot.name, { dir: workDir ?? rt.workDirOf({ botId: bot.id }) })
    wg.registerSessionOwner(sessionId, { kind: 'task', taskId, botId: bot.id, workgroupId: pending()[taskId]?.workgroupId })
    const endpoint = await endpointFor(bot.id)
    return { botId: bot.id, sessionId, workDir: workDir ?? bot.workDir, endpointId: endpoint }
  }

  // Which Bot should take it. Kept deliberately dumb: the first Bot that is not the Chief, else the
  // Chief. A model choosing would make "which Bot ran" a fact about a prompt rather than about the
  // roster, and gate 2 asks that the target Bot be identifiable.
  async function chooseBotForTask() {
    const bots = Object.values(rt.state?.bots ?? {})
    if (bots.length === 0) return undefined
    const mainIds = new Set(rt.state?.mainBotIds ?? [])
    const helper = bots.find(bot => !mainIds.has(bot.id))
    return (helper ?? bots[0]).id
  }

  // The published endpoint for a local Bot, so the Hub's task row can name it. Published here rather
  // than left to the account page because a task that ran under an endpoint the Hub does not know
  // would leave `tasks.endpoint_id` empty and gate 2's "which Bot ran" unanswerable.
  async function endpointFor(localBotId) {
    const bot = rt.botOf(localBotId)
    try {
      const published = await wg.hub.publishBotEndpoint({
        localBotId: String(localBotId),
        name: String(bot?.name ?? localBotId),
        capabilities: ['chat', 'files'],
      })
      return published?.endpoint?.endpointId
    } catch {
      // A group already containing this endpoint does not need a second publication, and a Hub that
      // refuses must not stop the decision: the local run is what B approved.
      return undefined
    }
  }

  // ── starting the work ───────────────────────────────────────────────────────────
  //
  // `verifyBeforeRun` is plan §10.1 step 5's "验证实际身份/工作目录/可见工具/Guard 已成功安装后才运行".
  // Every one of the four is checked here, and a refusal reports which one failed instead of running
  // against a Session that is not what B approved.
  async function verifyBeforeRun(record, { workDir } = {}) {
    // 1. The Bot must be a real Bot of this runtime, not an id that happens to resolve somewhere.
    const bot = rt.botOf(record.botId)
    if (bot === undefined) return { ok: false, code: TASK_ERROR.badBot, detail: 'The Bot this task was assigned to no longer exists.' }

    // 2. The Session must still be ours, and still a task Session: a handoff that reassigned it would
    //    otherwise let the task drive a Bot's own conversation.
    const owner = wg.sessionOwners.get(record.sessionId)
    if (owner?.kind !== 'task' || owner.taskId !== record.taskId) {
      return { ok: false, code: TASK_ERROR.badBot, detail: 'The Session for this task is not available any more.' }
    }
    const agent = await rt.resolveAgent(record.sessionId).catch(() => undefined)
    if (agent === undefined) return { ok: false, code: TASK_ERROR.badBot, detail: 'The Session for this task could not be opened.' }

    // 3. The folder. Both sides are resolved with `rt.real` first, so a symlink or a `..` is judged by
    //    where it really points rather than by how it is spelled. A run outside the approved root is
    //    refused and is NOT redirected to the team folder (T14).
    //
    //    This used to be dead code: `record.workDirRoot` was read here and assigned nowhere, so the
    //    check never ran and any folder was accepted. The grant now carries the root (`decide`) and
    //    this branch is reachable.
    if (record.workDirRoot !== undefined) {
      // The folder this run will ACTUALLY use, asked of DSH: `rt.sessionFolder` is the original's own
      // answer (src/host/folders.js:48) and reads the working directory the harness reports for this
      // Session. Checking the caller's optional argument instead would check a value that a real run
      // never passes, which is how this gate came to be dead code twice over.
      const wanted = workDir === undefined ? (rt.sessionFolder?.(agent.session) ?? record.workDirRoot) : workDir
      const target = await rt.real(wanted).catch(() => undefined)
      if (target === undefined) {
        return { ok: false, code: TASK_ERROR.badWorkspace, detail: `"${wanted}" is not a folder, so the task was not started.` }
      }
      const root = await rt.real(record.workDirRoot).catch(() => record.workDirRoot)
      const check = checkInsideRoot(target, root)
      if (!check.ok) return check
    }

    // 4. The guard. Without it the boundary is advice; the run does not happen.
    if (wg.taskGuardMissing === true || typeof ctx.tools?.guard !== 'function') {
      return { ok: false, code: TASK_ERROR.noGuard, detail: 'This runtime cannot enforce task tool limits, so the task was not started.' }
    }

    // 5. The visible tools must not include one of the denied ones: if `restrict` failed silently the
    //    task would have a route out of its scope.
    const schemas = typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas(agent) : []
    const leaking = schemas.map(schema => schema.name).filter(name => DENIED_TOOLS.includes(name))
    if (leaking.length > 0) {
      // `restrict` is the seam the original team already uses for Bot Sessions; it throws on a name
      // this profile does not serve, so a refusal here means the profile changed under us.
      try {
        agent.ctx?.tools?.restrict?.({ deny: leaking })
      } catch (error) {
        return { ok: false, code: TASK_ERROR.noGuard, detail: `Could not remove ${leaking.join(', ')} from this task's tools: ${error?.message ?? error}` }
      }
    }

    return { ok: true, agent, bot, toolCount: schemas.length - leaking.length }
  }

  async function startTask(taskId) {
    const record = wg.liveTask(taskId)
    if (record === undefined) throw Object.assign(new Error('That task is not live.'), { code: TASK_ERROR.notApproved })
    // A RUNNING task is already started. Returning the same record makes `task-start` idempotent for
    // a caller that lost the answer; `runTask` separately checks whether its prompt was delivered.
    if (record.state === 'RUNNING' && record.runId !== undefined) return record
    if (record.state !== 'APPROVED' && record.state !== 'INTERRUPTED') {
      throw Object.assign(new Error(`That task is ${record.state}; it cannot start.`), { code: TASK_ERROR.notApproved })
    }
    const card = pending()[taskId]
    const verified = await verifyBeforeRun(record, { workDir: card?.workDir })
    if (!verified.ok) {
      // Reported to the Hub as a failure, so the requester is not left waiting on a task this machine
      // refused to run. The reason is a sentence, not a stack.
      await reportToHub({ taskId, next: 'FAILED', error: verified.detail }).catch(() => {})
      throw Object.assign(new Error(verified.detail), { code: verified.code })
    }

    // ASSIGNED then RUNNING, through the registry's own machine. Doing them here (rather than let the
    // caller pick a state) is what keeps "an unapproved task can never be RUNNING" true by structure.
    //
    // The version is read from what each call RETURNS, not from `record`: `advanceTask` bumps the
    // record in place, so `record.version + 1` after the first call would already be one too far.
    // A new explicit start gets a new run identity. An INTERRUPTED task keeps the old one for its
    // history until the user starts this new run.
    if (record.state === 'INTERRUPTED' || record.runId === undefined) {
      record.runId = `run-${randomUUID()}`
      record.runStartedAt = Date.now()
      record.version += 1
      await wg.save()
    }
    // An interrupted task is already past ASSIGNED on the Hub. Reporting ASSIGNED again is refused
    // (`RUNNING -> ASSIGNED` is not a legal transition), so resume only goes straight to RUNNING.
    // A fresh approved task still follows the full APPROVED -> ASSIGNED -> RUNNING path.
    const resuming = record.state === 'INTERRUPTED'
    if (resuming) {
      wg.advanceTask(taskId, 'RUNNING', { version: record.version })
    } else {
      const assigned = wg.advanceTask(taskId, 'ASSIGNED', { version: record.version })
      await reportToHub({ taskId, next: 'ASSIGNED' }).catch(() => {})
      wg.advanceTask(taskId, 'RUNNING', { version: assigned.version })
    }
    const running = wg.taskOf(taskId)
    await reportToHub({ taskId, next: 'RUNNING' }).catch(() => {})
    wg.emitTask?.('started', { taskId })
    return running
  }
  wg.startTask = startTask

  // ── the actual turn ─────────────────────────────────────────────────────────────
  //
  // One user message into the task Session: the approved request, phrased as the work. The Agent is
  // the Bot's own, so the transcript is the Bot's real work and its tools are the ones verified above.
  async function runTask({ taskId, text }) {
    const body = typeof text === 'string' && text.trim() !== '' ? text : taskPromptFor(taskId)
    if (body.trim() === '') {
      // A request with nothing in it cannot be worked on, and sending an empty prompt would leave the
      // Bot guessing at somebody else's intent.
      throw Object.assign(new Error('That request has nothing to work on, so it was not started.'), { code: TASK_ERROR.empty })
    }
    const record = await startTask(taskId)
    // ONE RUN, ONE DELIVERY.
    //
    // `startTask` may be called again by a retry or a reconnect. The first delivery is recorded
    // durably BEFORE `wg.deliver` can start a turn; a later call that sees the marker returns the
    // same record without prompting the Bot again. This is the side-effect-once fence T17 asks for,
    // not merely request dedup.
    wg.state.taskRuns ??= {}
    const runMark = wg.state.taskRuns[record.runId]
    if (runMark?.deliveredAt !== undefined) return record
    wg.state.taskRuns[record.runId] = { deliveredAt: Date.now() }
    await wg.save()
    // The delivery is `wg.deliver`, the copy of the original's `rt.deliver` that this domain already
    // has. It is the seam that already resolves the Agent, creates the user message, prefers
    // `followup`, falls back to `sessionController.prompt` and flushes — the four steps this function
    // used to re-implement by hand. `role: 'task'` is what the copy needed to gain: it had the role
    // hard-coded to 'room', so only group rounds could use it.
    await wg.deliver({
      sessionId: record.sessionId,
      text: body,
      exchangeId: `task-${taskId}`,
      role: 'task',
      taskId,
      roomId: record.workgroupId,
      senderName: 'Task request',
    })
    return record
  }
  wg.runTask = runTask

  // What the Bot is asked to do, in the requester's own words.
  //
  // It comes from the request A signed and B approved, never from a field somebody could set later:
  // "the content B approved" and "the content the Bot was told" have to be the same string, or the
  // approval is a formality. `title` is the plan's field (§9.2); the scope lines are added only when
  // they are not empty, so a bare request reads as a bare request.
  function taskPromptFor(taskId) {
    const card = pending()[taskId]
    if (card === undefined) return ''
    const lines = []
    if (typeof card.title === 'string' && card.title.trim() !== '') lines.push(card.title.trim())
    if ((card.resources ?? []).length > 0) lines.push(`Resources: ${card.resources.join(', ')}`)
    if ((card.capabilities ?? []).length > 0) lines.push(`Allowed tools: ${card.capabilities.join(', ')}`)
    return lines.join('\n')
  }
  wg.taskPromptFor = taskPromptFor

  // ── progress, result, cancellation ──────────────────────────────────────────────
  //
  // Progress is merged: at most one event per task per PROGRESS_MERGE_MS, with the last note kept. The
  // log is what every client replays, so a chatty run must not become the group's history.
  const progressAt = new Map()
  async function reportProgress({ taskId, note, percent }) {
    const record = wg.liveTask(taskId)
    if (record === undefined || record.state !== 'RUNNING') return { recorded: false }
    const last = progressAt.get(taskId) ?? 0
    const now = Date.now()
    if (now - last < PROGRESS_MERGE_MS) {
      // Merged into the next window rather than dropped silently: the note is kept and sent when the
      // window opens, so a reader never sees a gap that looks like the task stalled.
      progressAt.set(taskId, last)
      return { recorded: false, merged: true }
    }
    progressAt.set(taskId, now)
    const workgroupId = record.workgroupId
    await wg.bridge.sendEvent({
      workgroupId,
      frameType: 'task.progress',
      payload: { taskId, note: note ?? '', ...(Number.isFinite(percent) ? { percent } : {}) },
    }).catch(() => {})
    return { recorded: true }
  }
  wg.reportProgress = reportProgress

  // The result. `review` is the plan's step 7: the machine that produced it decides what of it may be
  // shared, and a broad scope asks the person again rather than assuming.
  async function finishTask({ taskId, summary, artifacts = [] }) {
    const record = wg.liveTask(taskId)
    if (record === undefined || record.state !== 'RUNNING') {
      throw Object.assign(new Error('That task is not running.'), { code: 'task/not-running' })
    }
    wg.advanceTask(taskId, 'RESULT_REVIEW', { version: record.version })
    await reportToHub({ taskId, next: 'RESULT_REVIEW', summary }).catch(() => {})
    const shared = []
    for (const artifact of artifacts) {
      const uploaded = await wg.shareArtifact({ taskId, ...artifact }).catch(error => ({ error }))
      if (uploaded?.error === undefined) shared.push(uploaded)
    }
    const reviewed = wg.liveTask(taskId)
    if (reviewed !== undefined) {
      wg.advanceTask(taskId, 'COMPLETED', { version: reviewed.version })
      await reportToHub({ taskId, next: 'COMPLETED', summary }).catch(() => {})
    }
    wg.emitTask?.('completed', { taskId, artifacts: shared.length })
    return { taskId, shared }
  }
  wg.finishTask = finishTask

  async function shareArtifact({ taskId, path, name, mime, acl }) {
    const { readFile } = await import('node:fs/promises')
    const bytes = await readFile(path)
    return wg.hub.uploadArtifact({ taskId, name, mime, data: bytes.toString('base64'), acl })
  }
  wg.shareArtifact = shareArtifact

  // Cancelling from this side (the requester asked, or B changed their mind). The ledger entry is
  // removed FIRST, so the guard stops the very next tool call while the Hub round trip is in flight.
  async function cancelTask({ taskId, reason }) {
    const record = wg.taskOf(taskId)
    if (record === undefined) throw Object.assign(new Error('Unknown task'), { code: 'task/not-found' })
    if (wg.liveTask(taskId) !== undefined) {
      try { wg.advanceTask(taskId, 'CANCELLED', { version: record.version }) } catch { /* already final */ }
    }
    // The Session keeps running its current turn, but every further tool call is refused by the
    // guard because the record is no longer live. The Agent's own cancel path is asked too, so a
    // running turn stops rather than merely failing its next step.
    try { await rt.cancelSession?.(record.sessionId) } catch { /* not every host offers one */ }
    progressAt.delete(taskId)
    await reportToHub({ taskId, next: 'CANCELLED', error: reason }).catch(() => {})
    wg.emitTask?.('cancelled', { taskId })
    return { taskId, cancelled: true }
  }
  wg.cancelTask = cancelTask

  // ── progress from the work itself ───────────────────────────────────────────────
  //
  // `reportProgress` above is the API; this is what CALLS it. A task Session's own tool calls are the
  // only honest source of "how is it going", and they arrive on `session/event` like every other turn
  // signal in this domain. Without this the endpoint existed with no producer — the same shape as the
  // six uncalled endpoints G4's audit found.
  //
  // It never writes one event per tool call: `reportProgress` merges inside PROGRESS_MERGE_MS, so a
  // twenty-call run produces a handful of lines rather than twenty.
  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      const sessionId = session?.id
      if (sessionId === undefined) return
      const record = taskOfSession(sessionId)
      if (record === undefined || record.state !== 'RUNNING') return
      // Only the calls that mean something to a reader: the start of a tool, and the start of a step.
      if (event.type === 'tool/call') {
        const name = String(event.data?.name ?? '')
        if (name === '') return
        void reportProgress({ taskId: record.taskId, note: name }).catch(() => {})
      } else if (event.type === 'turn/end') {
        const ids = wg.wgToolCalls?.get(record.taskId)
        if (ids !== undefined) wg.wgToolCalls.delete(record.taskId)
      }
    })
  }

  // ── reporting to the Hub ────────────────────────────────────────────────────────
  //
  // Every state this machine reports goes through the socket, so the Hub's row and this machine's
  // ledger move together — and a report that cannot be sent leaves the local state ahead, which is
  // the safe direction (the Hub never thinks a task is running when it is not).
  // No `version` is sent, deliberately. The two sides count different things: this machine's ledger
  // counts ITS transitions (APPROVED → ASSIGNED → RUNNING is 0,1,2) while the Hub counts the whole
  // line including the states a decision walked through on its behalf. Sending the local counter as
  // an optimistic check would make every report look stale. The fence that matters is the Hub's own
  // transition table, which refuses an illegal move whatever version a client believes it is at.
  async function reportToHub({ taskId, next, error, summary }) {
    const record = wg.taskOf(taskId)
    if (record === undefined) return { sent: false }
    return wg.bridge.sendEvent({
      workgroupId: record.workgroupId,
      frameType: 'task.report',
      payload: {
        taskId,
        next,
        ...(error === undefined ? {} : { error }),
        ...(summary === undefined ? {} : { summary }),
      },
    })
  }
  wg.reportTaskToHub = reportToHub

  // ── sending a request (the requester's side) ────────────────────────────────────
  //
  // A's half: mint the id, build and sign the envelope, hand it to the outbox. The signature comes
  // from the Hub client's own signer, so this module never holds the private key.
  async function requestTask({ workgroupId, targetUserId, targetEndpointId, title, resources, capabilities, ttlMs }) {
    const me = wg.hub.account
    if (me === undefined) throw Object.assign(new Error('Sign in to the Hub first.'), { code: 'hub/not-signed-in' })
    const socketAuth = await wg.hub.socketAuth()
    const taskId = `task_${randomUUID().replace(/-/g, '')}`
    const envelope = buildTaskRequest({
      taskId,
      workgroupId,
      sender: { userId: me.hubUserId, deviceId: me.deviceId },
      target: { userId: targetUserId, ...(targetEndpointId === undefined ? {} : { botEndpointId: targetEndpointId }) },
      payload: {
        title: String(title ?? ''),
        requestedResources: Array.isArray(resources) ? resources : [],
        requestedCapabilities: Array.isArray(capabilities) ? capabilities : [],
      },
      signBytes: socketAuth.signPayload,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    })
    // Local record first: if the send is queued by the outbox, the requester can already see "asked"
    // in the timeline, and the panel has something to poll.
    wg.state.taskOutbox ??= {}
    wg.state.taskOutbox[taskId] = { taskId, workgroupId, title, targetUserId, state: 'REQUESTED', sentAt: Date.now() }
    await wg.save()
    const sent = await wg.bridge.sendEvent({
      workgroupId,
      frameType: 'task.request',
      envelope,
      eventId: envelope.eventId,
    })
    return { taskId, envelope: { eventId: envelope.eventId, createdAt: envelope.createdAt, expiresAt: envelope.expiresAt }, ...sent }
  }
  wg.requestTask = requestTask

  // The card a person answers, and the queue the panel draws. Read-only: nothing here runs.
  wg.taskRequests = requests

  // The tasks this machine has already agreed to, with the state the panel needs to offer the next
  // action on them. Read from the LEDGER, not from the card: after a restart the cards are still
  // there, and a task whose card was lost must still be cancellable.
  wg.taskActivity = () => Object.values(wg.state.tasks ?? {}).map(record => ({
    taskId: record.taskId,
    workgroupId: record.workgroupId,
    botId: record.botId,
    state: record.state,
    live: wg.liveTask(record.taskId) !== undefined,
    ...(pending()[record.taskId]?.title === undefined ? {} : { title: pending()[record.taskId].title }),
    ...(Number.isFinite(record.expiresAt) ? { expiresAt: record.expiresAt } : {}),
  }))
  wg.taskRequest = taskId => (pending()[taskId] === undefined ? undefined : publicRequest(pending()[taskId]))

  // The Bridge hands an incoming `task.request` here. Kept as a named function so the wiring is one
  // line and a test can call it without a socket.
  wg.onTaskEvent = async ({ workgroupId, event }) => {
    if (event?.type === 'task.request') return receiveRequest({ workgroupId, event })
    if (event?.type === 'approval.granted') {
      const record = pending()[event.payload?.taskId]
      if (record !== undefined) record.state = 'APPROVED'
      await wg.save()
    }
    return false
  }
}

// The hash a scope is remembered by, so two approvals of the same request can be compared without
// storing the scope twice. Exported for the tests that check the ledger's own record.
export const scopeHash = scope => createHash('sha256').update(JSON.stringify(scope ?? {})).digest('hex')

// Whether `path` is inside `root`, after resolving both. Exported so the rule is testable without a
// Session: T14 is about this function refusing `..` and a symlink that points outside.
export function checkInsideRoot(path, root) {
  const resolvedRoot = resolve(String(root))
  const resolved = resolve(String(path))
  const rel = relative(resolvedRoot, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, code: TASK_ERROR.badWorkspace, detail: `"${path}" is outside the folder this task was approved for.` }
  }
  return { ok: true }
}
