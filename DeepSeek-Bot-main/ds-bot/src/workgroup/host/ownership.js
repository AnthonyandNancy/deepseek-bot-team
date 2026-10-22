// Workgroup Session ownership. A Session belongs to exactly one domain:
//
//   original domain : the Bot's own chat, or its Session in a *local* group
//                     (indexed by ../host/store.js in chatOwners/groupOwners)
//   this domain     : a Workgroup relay Session, or a cross-user Task Session
//
// `resolveSessionOwnerStrict` refuses to guess. If a Session is claimed by both
// domains the caller gets an error instead of "first match wins": a shared Session
// would mean one domain's waiter, memory or tool policy acting on the other's turn,
// which is exactly the class of bug this fork must not ship.
//
// The original indexes are never written from here, and this map is never read by
// the original modules, so neither domain can move the other's Sessions.

export const OWNER_KINDS = ['workgroup', 'task']

export function install(wg) {
  const { rt } = wg

  /** @type {Map<string, {kind:string, workgroupId:string, botId?:string, taskId?:string}>} */
  const sessionOwners = new Map()
  wg.sessionOwners = sessionOwners

  // A map of anything is not an owner record: refuse rather than half-register.
  const check = (sessionId, owner) => {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('ds-bot: a workgroup Session needs an id')
    if (owner === null || typeof owner !== 'object') throw new Error('ds-bot: a workgroup Session needs an owner record')
    if (!OWNER_KINDS.includes(owner.kind)) throw new Error(`ds-bot: unknown workgroup owner kind "${owner.kind}"`)
    if (typeof owner.workgroupId !== 'string' || owner.workgroupId === '') throw new Error('ds-bot: a workgroup owner needs a workgroupId')
    if (owner.kind === 'task' && (typeof owner.taskId !== 'string' || owner.taskId === '')) throw new Error('ds-bot: a task owner needs a taskId')
  }

  // The original domain's claim on a Session, as the original modules see it.
  const localClaim = (sessionId) => {
    const chat = rt.chatOwners?.get(sessionId)
    if (chat !== undefined) return { kind: 'chat', botId: chat }
    const group = rt.groupOwners?.get(sessionId)
    if (group !== undefined) return { kind: 'localGroup', botId: group.botId, roomId: group.roomId }
    const past = rt.pastOwners?.get(sessionId)
    if (past !== undefined) return { kind: 'archived', botId: past.botId, roomId: past.roomId }
    return undefined
  }
  wg.localClaim = localClaim

  // undefined  -> neither domain owns it (an ordinary DSH Session)
  // {domain:'workgroup'|'original', kind:...} -> exactly one owner
  // throws     -> both domains claim it, which must never be resolved silently
  //
  // `domain` says whose Session it is; `kind` keeps the finer meaning inside that
  // domain ('chat' / 'localGroup' / 'archived' for the original, 'workgroup' / 'task'
  // for this one). They are separate keys on purpose: a single `kind` field would let
  // one value shadow the other.
  function resolveSessionOwnerStrict(sessionId) {
    if (sessionId === undefined) return undefined
    const mine = sessionOwners.get(sessionId)
    const theirs = localClaim(sessionId)
    if (mine !== undefined && theirs !== undefined) {
      const error = new Error(`ds-bot: Session ${sessionId} is claimed by both domains (workgroup ${mine.workgroupId}; original ${theirs.kind})`)
      error.code = 'bot/session-owned-twice'
      throw error
    }
    if (mine !== undefined) return { ...mine, domain: 'workgroup' }
    if (theirs !== undefined) return { ...theirs, domain: 'original' }
    return undefined
  }
  wg.resolveSessionOwnerStrict = resolveSessionOwnerStrict
  // A workgroup in the shape the ORIGINAL group code reads: member ids (not member
  // records) and `admin`, exactly like `state.rooms[*]`. Exposed on `rt` as the one
  // read-only seam for original modules that take a room id — the memory panel is the
  // first of them. It never writes and never falls back to a local room.
  const roomOf = (id) => {
    const room = wg.state?.workgroups?.[id]
    if (room === undefined) return undefined
    return {
      ...room,
      members: (room.members ?? []).map(member => (member !== null && typeof member === 'object' ? member.id : member)),
      admin: room.adminId ?? null,
    }
  }
  wg.roomOf = roomOf
  rt.workgroupRoomOf = roomOf
  // Read-only convenience for listeners that only need "is this mine".
  wg.ownsSession = sessionId => sessionOwners.has(sessionId)

  function register(sessionId, owner) {
    check(sessionId, owner)
    // Registering over a claim the original already holds would create the very
    // double ownership the resolver refuses; catch it at the write instead.
    const theirs = localClaim(sessionId)
    if (theirs !== undefined) throw new Error(`ds-bot: Session ${sessionId} already belongs to the original domain (${theirs.kind})`)
    const existing = sessionOwners.get(sessionId)
    if (existing !== undefined && existing.workgroupId !== owner.workgroupId) {
      throw new Error(`ds-bot: Session ${sessionId} already belongs to workgroup ${existing.workgroupId}`)
    }
    const record = {
      kind: owner.kind,
      workgroupId: owner.workgroupId,
      ...(owner.botId !== undefined ? { botId: owner.botId } : {}),
      // The member's name when the Session was made. The identity prompt reads it when the
      // Bot record is gone, so a member Session always has a name to give the model
      // instead of an empty prompt — an empty prompt answers with nothing.
      ...(owner.name !== undefined ? { name: owner.name } : {}),
      ...(owner.taskId !== undefined ? { taskId: owner.taskId } : {}),
      ...(owner.hubUserId !== undefined ? { hubUserId: owner.hubUserId } : {}),
      ...(owner.deviceId !== undefined ? { deviceId: owner.deviceId } : {}),
      registeredAt: Date.now(),
    }
    sessionOwners.set(sessionId, record)
    // Persisted so a restart rebuilds the same ownership instead of guessing from
    // the Session title (the original's groupOwners are rebuilt from state.json;
    // this domain keeps its own index in workgroup/state.json).
    wg.state.sessionOwners[sessionId] = record
    return record
  }
  wg.registerSessionOwner = register

  function release(sessionId) {
    const gone = sessionOwners.delete(sessionId)
    if (wg.state.sessionOwners[sessionId] !== undefined) {
      delete wg.state.sessionOwners[sessionId]
      void wg.save()
    }
    return gone
  }
  wg.releaseSessionOwner = release

  // Rebuilds the map from persisted state. Called after the state file is read, and
  // only then: `save()` must never call it, or a registration made in memory would be
  // overwritten by the older on-disk copy just before being written.
  function indexSessionOwners() {
    sessionOwners.clear()
    for (const [sessionId, record] of Object.entries(wg.state.sessionOwners ?? {})) {
      if (record === null || typeof record !== 'object') continue
      if (!OWNER_KINDS.includes(record.kind)) continue
      sessionOwners.set(sessionId, record)
    }
  }
  wg.indexSessionOwners = indexSessionOwners
  // The map is (re)built from the file once the file has been read; state.load drives
  // that through wg.onStateLoaded. The map exists empty from here on, so no stale claim
  // can outlive a restart, and a claim made before the first load is still written.
  wg.onStateLoaded = () => {
    // Registrations made before the file was read are newer than the file, so they win.
    const pending = new Map(sessionOwners)
    indexSessionOwners()
    for (const [sessionId, record] of pending) sessionOwners.set(sessionId, record)
  }

  // Every id the domain knows, for tool-scope checks and strict lookups.
  wg.ownedSessionIds = () => [...sessionOwners.keys()]

  // A Workgroup member Session seen as "the group it speaks in", for the host tools that
  // must treat a local group and a workgroup alike without knowing either record shape
  // (`message_bot`'s in-group branch, src/host/tools.js). The original answers that
  // question from `rt.groupOwners`, which never holds a workgroup Session, so this domain
  // answers it itself — carefully, because a Workgroup's members are objects
  // (`{id, kind, name}`) where a local group's are Bot ids.
  //
  // Undefined for the GROUP's own Session: it is the relay, not a member, so it speaks in
  // no group as a member and a tool must not treat it as one.
  function sessionGroupScope(sessionId) {
    const owner = sessionOwners.get(sessionId)
    if (owner === undefined || owner.botId === undefined) return undefined
    const room = wg.workgroupOf(owner.workgroupId)
    if (room === undefined) return undefined
    const members = room.members ?? []
    return {
      name: room.name,
      has: botId => members.some(member => member.id === botId),
      isAdmin: botId => room.adminId !== undefined && room.adminId !== null && room.adminId === botId,
      // Deliberately FALSE: `update_group` is the original's tool and knows only local
      // groups, so a workgroup's admin cannot add a member with it. A refusal that tells
      // them to "add it yourself with update_group" sends them at a tool that answers
      // "No group chat called … that you can see". This domain's membership is changed
      // through its own `update-room` endpoint, which no Bot tool reaches yet (G4).
      canBeChangedHere: false,
      // A line "in the group" goes through this domain's own step path, the same one a
      // member's step text takes; it is what writing "@Name" in the group does.
      post: text => wg.roomStepText(sessionId, wg.live.get(sessionId)?.info, text, false),
    }
  }
  wg.sessionGroupScope = sessionGroupScope

  // The BOT a Session speaks for, in either domain, as one lookup: the original index
  // first, then this domain's own ownership record.
  //
  // Deliberately NOT a replacement for `rt.isBotSession`. That flag is what the original's
  // turn machinery filters on (`turns.js:352`), so answering "yes" for a workgroup member
  // there would make the original's listeners start managing this domain's turns — the
  // cross-domain claim P0-3 forbids, and the exact bug that already cost this fork two
  // rounds. What the modules below actually need is narrower: "which Bot does this
  // Session speak for", which is a question this domain can answer safely.
  //
  // `capabilities.js`'s `botOfSession`, `folders.js`'s `sessionFolder` and
  // `permissions.js`'s `setPermission` were all reading the original indexes alone, so for
  // a workgroup member they answered "no Bot". Three real consequences, none of which
  // reported an error:
  //
  //   - `ensureCapabilities` returned immediately, so a workgroup member never got its
  //     tools or MCP servers mounted at all.
  //   - `setPermission` never walked a workgroup member's Session, so revoking a Bot's
  //     permissions left the member running under the old ones — the gate's "撤权".
  //     `groupSessionsOf` is extended for the same reason.
  //   - `hideBotUnusedTools` (tools.js:613) never ran on a member's Agent, so `ask_user`
  //     and the goal tools stayed in its list.
  const originalSelfOf = rt.selfOf
  const originalGroupSessionsOf = rt.groupSessionsOf

  // The Bot a workgroup member speaks for; undefined for the group's own relay Session
  // (it speaks for no Bot) and for any Session this domain does not own.
  const memberBotId = sessionId => (sessionId === undefined ? undefined : sessionOwners.get(sessionId)?.botId)

  const selfOf = sessionId => originalSelfOf(sessionId) ?? memberBotId(sessionId)

  // Every Session this Bot speaks from in this domain, in the shape `setPermission`,
  // `applyModel` and `trackBotAgents` walk. A union, so a local group's list is unchanged.
  const groupSessionsOf = (botId) => {
    const local = originalGroupSessionsOf(botId) ?? []
    const mine = []
    for (const [sessionId, owner] of sessionOwners) {
      if (owner.botId !== undefined && owner.botId === botId) mine.push(sessionId)
    }
    return mine.length === 0 ? local : [...new Set([...local, ...mine])]
  }

  // Where a member's Session works. `folders.js`'s `workDirOf` reads
  // `rt.roomOf(roomId)?.workDir`, and `rt.roomOf` knows only the LOCAL groups, so a
  // workgroup's own folder was invisible to it: setting one in the settings form wrote
  // the record and changed nothing about where members actually worked. This resolves a
  // workgroup id to this domain's record first, then falls through untouched.
  const originalWorkDirOf = rt.workDirOf

  const workDirOf = ({ botId, roomId } = {}) => {
    const mine = roomId === undefined ? undefined : wg.workgroupOf(roomId)
    if (mine !== undefined) return mine.workDir ?? rt.botOf(botId)?.workDir
    return originalWorkDirOf({ botId, roomId })
  }

  // The same dispatch for "this Session is waiting on an approval, let the round go on".
  // `approvals.js` calls `rt.yieldRoomTurn`, which the ORIGINAL installs to walk its own
  // waiters. A workgroup member's waiter lives in this domain, so the call has to reach
  // here for a member Session and nowhere else — without this the member's round never
  // learns that its turn yielded, and the round waits while the user answers.
  const originalYieldRoomTurn = rt.yieldRoomTurn

  const yieldRoomTurn = (sessionId) => {
    if (sessionId !== undefined && sessionOwners.has(sessionId)) {
      wg.yieldRoomTurn?.(sessionId)
      return
    }
    originalYieldRoomTurn?.(sessionId)
  }

  Object.assign(rt, {
    resolveSessionOwnerStrict,
    workgroupOwnsSession: wg.ownsSession,
    sessionGroupScope,
    selfOf,
    groupSessionsOf,
    workDirOf,
    yieldRoomTurn,
  })
}
