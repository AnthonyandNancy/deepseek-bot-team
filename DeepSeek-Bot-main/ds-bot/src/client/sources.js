// -------------------------------------------------------------------------
// Small observable sources for the inject `hooks` compartment.

export function createSource(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) {
      const resolved = typeof next === 'function' ? next(value) : next
      if (resolved === value) return
      value = resolved
      for (const listener of [...listeners]) listener()
    },
  }
}

export const EMPTY_ROSTER = { revision: -1, mainBotId: null, mainBotIds: [], bots: [], rooms: [], agents: [], exchangeTurns: {}, questions: {}, secrets: [], capabilities: [], capabilityStatuses: {}, secretRequests: {}, models: [], defaultModel: null, modelsKey: null, prefs: {}, byId: {}, roomsById: {}, agentsById: {}, agentOf: {}, ready: false }
// Any Main Bot holds the Main Bot powers; `mainBotId`, the first one, is the sidebar tile.
export const isMainOf = (roster, id) => id !== undefined && (roster.mainBotIds ?? []).includes(id)

// A Bot's chat is a chain of Sessions ("parts"): the Bot id is its first part's id
// and `sessionId` its current one. Every part id finds the Bot; Session state
// (running, unread, turns) is read from the current part, team state from the Bot id.
//
// `workgroups` (optional) are the Workgroup domain's own rooms. A workgroup IS a group
// chat, so it is indexed in `roomsById` beside the local groups: that is what makes the
// original group-aware components work on it unchanged. They stay OUT of `rooms`, which
// is the local group list the sidebar renders, so a workgroup never appears twice.
export function indexRoster(value, workgroups) {
  const byId = {}
  for (const bot of value.bots) {
    for (const id of [...(bot.parts ?? []), bot.sessionId ?? bot.id, bot.id]) byId[id] = bot
  }
  const roomsById = {}
  for (const room of value.rooms) roomsById[room.id] = room
  for (const room of groupRooms(workgroups)) roomsById[room.id] = room
  // A workgroup member has to be findable BY ID, because that is the only way any original component
  // reaches a member: `room.members` is a list of ids to them, and they draw whatever `byId` answers.
  // A Hub member is not one of this team's Bots, so it is indexed here rather than in `value.bots` —
  // which keeps it out of the Bots list, the roster count, and every place that iterates `bots`.
  //
  // Written after the bots so a local Bot wins a collision. A workgroup member id is a Hub id
  // (`ep_…`/`usr_…`) and cannot collide today, but the precedence should not rest on that.
  //
  // A member that IS one of this team's Bots resolves to that BOT, not to the thin member record.
  // The record carried just `{id, kind, name}`, so `lookOf()` derived a character from the Hub's
  // `ep_…` id and every member of a workgroup wore a shape and colour of its own — visibly not the
  // Bot's own character, which is what the sidebar and every other surface draw for the same Bot.
  // `botId` is what `applyRoster` records for a member it recognised as this machine's own Bot.
  for (const member of workgroupMembers(workgroups)) {
    const own = member.botId === undefined ? undefined : byId[member.botId]
    if (byId[member.id] === undefined) byId[member.id] = own ?? member
  }
  // The DSH Agent is not a Bot: it indexes by its own id and by each Session it owns.
  const agentsById = {}
  const agentOf = {}
  for (const agent of value.agents ?? []) {
    agentsById[agent.id] = agent
    for (const sessionId of agent.sessions ?? []) agentOf[sessionId] = agent.id
  }
  return { ...value, agents: value.agents ?? [], byId, roomsById, agentsById, agentOf, ready: true }
}

// A workgroup record adapted to the shape the original group components read: member *ids*
// (`RoomAvatar` and every other component map them through `roster.byId`) and the admin as
// `admin`. The workgroup keeps its own record under `workgroup`, so nothing is lost.
//
// The ids alone are not enough — `indexRoster` has to answer for them too, which is what
// `workgroupMembers` below exists for. Reducing the members and NOT indexing them is the shape
// that broke on screen: 「4 位成员」 in the header (it reads `room.members.length`) over
// 「成员 · 0」 (it maps through `byId`), no admin, and a black gumdrop for the group face, because
// `lookOf(undefined)` is exactly that. The two halves belong together; neither works alone.
export function groupRooms(workgroups) {
  return (workgroups ?? []).map(room => ({
    ...room,
    members: (room.members ?? []).map(member => (member !== null && typeof member === 'object' ? member.id : member)),
    admin: room.adminId ?? null,
    workgroup: true,
  }))
}

// The member RECORDS of every workgroup, which are what a Bot mark needs to draw a face (a name and
// an id; its shape and colour come from the id when it sets none). They are not Bots of this team, so
// they belong in `byId` but never in `roster.bots`. A member without an id cannot be addressed or
// looked up, so it is dropped rather than indexed under `undefined`.
function workgroupMembers(workgroups) {
  const members = []
  for (const room of workgroups ?? []) {
    for (const member of room.members ?? []) {
      if (member !== null && typeof member === 'object' && member.id !== undefined && member.id !== null) members.push(member)
    }
  }
  return members
}

// Whether a main-view Session id belongs to the team's DSH Agent: the conversation
// group then stays withdrawn while the shell keeps the sidebar. Before the roster
// arrives, the ids cached from the last pull answer.
export function isAgentSession(roster, cache, sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === '') return false
  if (roster.ready) return roster.agentOf[sessionId] !== undefined
  return cache.has(sessionId)
}

// A request can reuse a call id; question and secret ids belong to separate kinds.
export const heldCardKey = (kind, requestId) => JSON.stringify([kind, requestId])

// Per Session, how many mounted cells draw or hold each card; 0 drops the entry.
export function countCards(state, sessionId, callIds, delta) {
  const own = { ...state[sessionId] }
  for (const callId of callIds) {
    const count = (own[callId] ?? 0) + delta
    if (count > 0) own[callId] = count
    else delete own[callId]
  }
  return { ...state, [sessionId]: own }
}
