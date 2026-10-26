// The Workgroup group core: the original group chat's room log, @mention rounds and
// relay, copied rather than rewritten, with its own names and its own state.
//
// Copied from src/host/groups.js (ds-bot 0.1.7, commit 939a6635830cb5b246e7dd19c67b0e1352ad1c07)
// and changed in exactly these ways — nothing else:
//   1. `rt.<state>` -> `wg.<state>`: roomWaiters / roomProgress / roomInbox, so a
//      workgroup turn can never touch a local group's waiter (P0-8).
//   2. tool `group_relay` -> `workgroup_relay` (P0-2: no duplicate tool names).
//   3. `SOURCE_KIND` ('bot') -> `WG_SOURCE_KIND` ('workgroup'), so the original
//      turns/handoff listeners do not consume this domain's messages (P0-3).
//   4. group line files under workgroup/group-lines, not group-lines (P0-1).
//   5. Session ownership recorded in wg.sessionOwners, not rt.groupOwners (P0-1).
//   6. the room's member list is Workgroup members, not just local Bots, and a
//      remote member never becomes a local Session (plan §8.3).
//
// G1 scope was the room log, rounds, @mentions, relay and stop against LOCAL messages
// only. G4 adds the one seam that was left for it: a member whose `kind` is not
// `localBot` is a real person (or their Bot) on ANOTHER device. Such a member is never
// given a local Session — that would be the "fake remote DSH Session" plan §8.3 forbids —
// and its turn is handed to `wg.deliverRemote` (host/bridge.js), which puts it on the Hub.
// A line that arrives from the Hub comes back in through `wg.receiveRemote` and is posted
// into the same log as a local member's line, so the chat pane needs one code path.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mentionSpans, speakerOf } from '../../shared/mentions.js'
import { escapeRegExp, headOf, splitRef, textOf } from '../../host/text.js'
import { SOURCE_KIND, TEAM_TOOLS } from '../../host/constants.js'
import { WG_ADOPT_INTERVAL_MS, WG_ADMIN_EXTRA_TURNS, WG_ADMIN_TURNS_EACH, WG_DELTA_MAX, WG_DIR, WG_EXTRA_TURNS, WG_FIRST_LOOK, WG_LATE_ROUNDS, WG_LINE_READ, WG_LOG_MAX, WG_READ_MAX, WG_REPLY_TIMEOUT_MS, WG_ROOM_MAX_MEMBERS, WG_ROOM_MIN_MEMBERS, WG_ROOM_MODES, WG_SOURCE_KIND, WG_STEP_GAP_MS, WG_TEXT_KEPT, WG_TOOLS, WG_TURNS_EACH, WG_WORK_GRACE_MS } from '../shared/constants.js'

// The original's group passes [PASS] to stay silent; the same rule applies here so a
// copied round behaves identically.
export // COPY OF THE ORIGINAL (`failureLine`, src/host/turns.js:23). Kept here rather than
// imported so this domain does not depend on the original's turn loop.
const failureLine = failure => `${failure.code}${failure.status ? ` ${failure.status}` : ''}${failure.message ? `: ${failure.message.slice(0, 200)}` : ''}`

const isPass = text => text === '' || /^\s*[[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i.test(text)

export const stripOwnName = (name, text) => text.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), '').trim()

// COPY OF THE ORIGINAL (`lineText`, src/host/groups.js:55). Every line kind the original
// renders is rendered here the same way: a member that was stopped, resumed, cut off, or
// finished its work is an event of the round, not a sentence somebody said. Leaving those
// kinds out meant a resumed or stopped member appeared as a normal line with no text.
const lineText = (line, text = line.text) => {
  if (line.kind === 'lookup') return `[${speakerOf(line)} looked up its own chat${line.text ? ` for "${line.text}"` : ''}]`
  if (line.kind === 'resumed') return `[${speakerOf(line)}'s work here was cut off when DeepSeek Harness restarted; it is picking it back up and posts when done]`
  if (line.kind === 'cut') return `[${speakerOf(line)}'s work here was cut off by a restart again, so it stopped; ask it to go on if it still matters]`
  if (line.kind === 'stopped') return `[The user stopped ${speakerOf(line)}'s work here]`
  if (line.kind === 'done') return `[${speakerOf(line)} finished the work it was asked for]`
  return `${speakerOf(line)}: ${text}`
}

// The blank line between two messages, written this way so the source stays ASCII.
const BS = String.fromCharCode(10)

const transcript = (lines, textOfLine = line => line.text) => lines.map(line => lineText(line, textOfLine(line))).join('\n')

// COPY OF THE ORIGINAL (src/host/groups.js:88-91). The round's instructions are the
// original's, word for word: they are what makes a member do the work it is asked for
// instead of promising it, and what makes "@Name" call the next member.
const ROOM_REPLY = 'Reply with your message for the group, no name prefix: in a discussion, one or two short messages. When you are asked to do something, do it now with your tools. The group does not wait for you and sees what you write while you work: say what you will do, write again only when something matters, and end with the result, never a promise to do it later. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.'
// COPY OF THE ORIGINAL (`fileLine`, src/host/groups.js:117). A file posted in the group
// is named in the log line, so every member reading the log knows it was there.
const fileLine = file => `[File "${file.name}" (${file.bytes} bytes) attached]`
// COPY OF THE ORIGINAL (`referenceNote`, src/host/groups.js:84). What the user referenced
// in this round, for a member that has not been shown it yet. Without it a reference the
// user attached to a message never reached the members.
const referenceNote = references => (references?.length
  ? `Conversations the user referenced in this round:\n\n${references.map(reference => reference.text).join('\n\n')}`
  : '')
const ROOM_CALLS = 'Writing "@Name" calls that member next, to answer or to do what you ask; when it finishes work you gave it, you answer its result. To only mention a member, write its name without "@".'

// COPY OF THE ORIGINAL (`slotLabel`, src/host/groups.js:91).
const slotLabel = (slot) => {
  if (slot.status === 'speaking') return `${slot.name} (you, now)`
  if (slot.status === 'posted') return `${slot.name} (posted)`
  if (slot.status === 'passed') return `${slot.name} (passed)`
  if (slot.status === 'missed') return `${slot.name} (no answer)`
  if (slot.status === 'working') return `${slot.name} (working on it; posts when done)`
  if (slot.status === 'waiting-approval') return `${slot.name} (waiting for the user's approval; posts when done)`
  if (slot.status === 'failed') return `${slot.name} (could not answer: error)`
  if (slot.status === 'left') return `${slot.name} (left the group)`
  return slot.name
}

// COPY OF THE ORIGINAL (`adminNote`, src/host/groups.js:103). `room.mode` is the
// workgroup's own field with the same meaning.
const adminNote = room => [
  'You are this group\'s admin.',
  room.mode === 'admin' ? 'Plain messages come to you first: answer them, or call the members who should answer with @Name.' : '',
  '"@all" calls every member. When the user asks, change the group with update_group.',
].filter(Boolean).join(' ')

// COPY OF THE ORIGINAL (`roomKickoff`, src/host/groups.js:110): the opening turn of a
// group the user just made without a first message.
const roomKickoff = language => `The user just created this group and has not written yet. Greet the user in one short message and ask what they want this group to work on. Do not call members with @ yet, and do not reply [PASS]. No name prefix. Write in ${language ?? 'the user\'s language if known; otherwise Chinese'}.`

// The group's own relay Session, as opposed to a member's Session.
//
// BOTH are owned by this domain under the same `kind: 'workgroup'`, so `kind` alone can
// never tell them apart. That mistake silenced every member turn twice: first in the
// system prompt (G1R12), and then in the `llm/stream` hook, where a member's Session was
// sent a synthesized relay call instead of reaching the model — so every member turn
// ended with an empty `assistant/message` and the group showed nothing.
//
// A member's owner record carries the member's `botId`; the group's own record does not,
// so its absence is the reliable "this is the group's own Session" test. Every gate that
// must treat the two differently uses this one function.
const isGroupSession = owner => owner !== undefined && owner.botId === undefined

export function install(wg) {
  const { ctx, rt } = wg

  const linesDir = join(rt.home, WG_DIR, 'group-lines')
  const lineFile = (roomId, seq) => join(linesDir, roomId, `${seq}.txt`)
  const wholeLines = new Map()
  const lineKey = (roomId, seq) => `${roomId}/${seq}`
  // The domain writes its own files; the original's read-only host rule still applies
  // because it is a property of the DSH install, not of this domain.
  const writes = () => rt.readOnly?.() === undefined

  function keepLine(roomId, line, text) {
    const kept = headOf(text, WG_TEXT_KEPT)
    if (kept.length === text.length) return line
    const read = headOf(text, WG_LINE_READ)
    wholeLines.set(lineKey(roomId, line.seq), read)
    if (writes()) {
      try {
        mkdirSync(join(linesDir, roomId), { recursive: true })
        writeFileSync(lineFile(roomId, line.seq), read, 'utf8')
      } catch (error) {
        rt.warn('ds-bot: workgroup line %s/%s not kept whole: %s', roomId, line.seq, error)
      }
    }
    return { ...line, text: kept, length: text.length }
  }

  function dropLine(roomId, line) {
    if (line.length === undefined) return
    wholeLines.delete(lineKey(roomId, line.seq))
    if (writes()) void rm(lineFile(roomId, line.seq), { force: true }).catch(() => {})
  }

  function dropLines(roomId) {
    for (const key of wholeLines.keys()) if (key.startsWith(`${roomId}/`)) wholeLines.delete(key)
    if (writes()) void rm(join(linesDir, roomId), { recursive: true, force: true }).catch(() => {})
  }
  wg.dropLines = dropLines
  // Exposed for the long-line path the original keeps as a file: the G1 isolation
  // test asserts where that file lands, so the seam has to be reachable.
  wg.keepGroupLine = keepLine

  const loadLines = room => Promise.all(room.log
    .filter(line => line.length !== undefined && !wholeLines.has(lineKey(room.id, line.seq)))
    .map(line => readFile(lineFile(room.id, line.seq), 'utf8').then((text) => { wholeLines.set(lineKey(room.id, line.seq), text) }, () => {})))

  const memberText = room => (line) => {
    const read = line.length === undefined ? line.text : wholeLines.get(lineKey(room.id, line.seq))
    if (read === undefined) return `${line.text}… (cut; ${line.length} characters in all, the rest was not kept)`
    const length = line.length ?? read.length
    const shown = headOf(read, WG_LINE_READ)
    return length > shown.length ? `${shown}… (cut; ${length} characters in all)` : shown
  }

  const appendLine = (room, line) => {
    room.seq += 1
    const log = [...room.log, keepLine(room.id, { ...line, seq: room.seq }, line.text ?? '')]
    for (const gone of log.slice(0, -WG_LOG_MAX)) dropLine(room.id, gone)
    room.log = log.slice(-WG_LOG_MAX)
  }

  // A line this machine produced, put on the Hub as well.
  //
  // THE GAP THIS CLOSES. G4 made the Hub the group's record: what the user types goes up
  // (`send-hub`), and what another machine says comes down (`receiveRemote`). What a LOCAL BOT says
  // never went up at all — `appendLine` has fourteen callers and not one of them sent anything — so
  // a workgroup whose conversation is mostly Bots had a Hub log containing only the humans' lines.
  // A colleague who joined afterwards pulled that and saw an almost empty group: 「同事加入后，
  // 群历史消息包括现有实时消息没显示」. It was not a pull problem; there was nothing to pull.
  //
  // Two rules keep it from becoming noise or a loop:
  //   * only called for lines a Bot or the user actually SAID (`postInRound`, `postToGroupSession`,
  //     the user's own line) — never for markers like `stopped`/`resumed`/`done`, which describe a
  //     round on one machine and are not conversation;
  //   * the Hub's `eventId` is recorded ON the log line (`hubEventId`), so the ack and any later
  //     replay are recognised by `receiveRemote`'s dedup instead of being drawn again.
  //
  // Signed out, a group without a Hub id, or a bridge that is not connected does nothing: a local
  // group and an offline workgroup behave exactly as before.
  const mirrorLine = (room, line) => {
    if (room.hubWorkgroupId === undefined) return
    if (wg.bridge?.status?.().connected !== true) return
    const text = String(line.text ?? '')
    if (text === '') return
    // A line that came FROM the Hub is already there; sending it back would loop it around.
    if (line.via === 'hub') return
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`
    line.hubEventId = eventId
    // A Bot's line names its endpoint when this machine published one, so the Hub can attribute the
    // author to the Bot rather than to the person whose machine ran it.
    const endpointId = line.memberId === undefined
      ? undefined
      : Object.entries(wg.bridge?.endpointBots?.() ?? wg.state?.endpointBots ?? {})
        .find(([, botId]) => String(botId) === String(line.memberId))?.[0]
    void Promise.resolve()
      .then(() => wg.bridge.send({
        workgroupId: room.hubWorkgroupId,
        text,
        eventId,
        ...(endpointId === undefined ? {} : { botEndpointId: endpointId }),
        // The answer to a remote call names the caller's exchange. It travels inside the payload
        // (not just on the local log line), because the Hub is what carries it back to the machine
        // whose round is waiting for that exact slot.
        ...(line.exchangeId === undefined ? {} : { exchangeId: String(line.exchangeId) }),
      }))
      .catch(error => rt.warn('ds-bot: a line in "%s" did not reach the Hub: %s', room.name, error?.message ?? error))
  }
  wg.mirrorLine = mirrorLine

  const unseenLines = (room, memberId) => {
    const since = room.seen[memberId]
    if (since === undefined) return room.log.slice(-WG_FIRST_LOOK)
    return room.log.filter(line => line.seq > since && line.memberId !== memberId).slice(-WG_DELTA_MAX)
  }

  // Who "@" calls. Members carry `name` and a `kind`, so a remote person's display
  // name can be addressed without ever being turned into a local Bot. mentionSpans
  // reads `.name` and returns the matching member as `span.bot`.
  const mentionsIn = (text, members) => {
    const found = []
    let all = false
    for (const span of mentionSpans(text, members)) {
      if (span.all) all = true
      else if (span.bot !== undefined && !found.some(member => member.id === span.bot.id)) found.push(span.bot)
    }
    return { all, found }
  }
  wg.mentionsIn = mentionsIn
  wg.isPass = isPass
  wg.stripOwnName = stripOwnName

  // COPY OF THE ORIGINAL (`worksOf`, src/host/tools.js:114): the works (handoffs.js) the
  // calling turn does — what it answers, and the requests that joined it. The original reads
  // `rt.live`; a workgroup member Session is never in that map, so this domain's own `wg.live`
  // answers. Read through `wg.workOf`, so it is this domain's ledger or nothing.
  const worksOf = (exec) => {
    const turn = wg.live?.get(exec.agent?.id)
    return [wg.workOf?.(turn?.info), ...(turn?.joined ?? []).map(joined => wg.workOf?.(joined.info))].filter(Boolean)
  }
  wg.worksOf = worksOf

  // A member record by member id, whichever kind it is. `rt.botOf` knows the local Bots and
  // says nothing about a Hub person or a remote endpoint, so a name lookup that only asked it
  // printed "undefined" for exactly the members a workgroup adds.
  wg.workgroupBotOf = (id) => {
    for (const room of Object.values(wg.state?.workgroups ?? {})) {
      const member = (room.members ?? []).find(other => other.id === id)
      if (member !== undefined) return member
    }
    return undefined
  }

  // A workgroup is created locally in G1 and linked to a Hub group later (G4). The
  // record lives in workgroup/state.json, never in the original state.rooms.
  // The display name of an automatically-named workgroup: the members, then a timestamp.
  //
  // The original derives "You, Chief, …" from the members alone and lets two groups share
  // it (its identity is the Session id, not the name; `cleanRoomName` only checks a CUSTOM
  // name). Two groups over the same Bots are therefore indistinguishable in a list, so the
  // product decision here is to append the creation time: "机器人组 + 时间戳". Uniqueness
  // still rests on the id (`wg-<uuid>`), which is what the user asked for — the timestamp
  // is a readable label, not the identity.
  const stamp = (ms) => {
    const d = new Date(ms)
    const pad = n => String(n).padStart(2, '0')
    // Seconds are enough for a human label; the id is what actually identifies a group, so
    // a same-second pair is allowed to read the same (the user asked for id-uniqueness, not
    // name-uniqueness). What must NOT happen is two rows that look identical AND cannot be
    // told apart — the row therefore also shows the member count and keeps `data-workgroup-id`.
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }
  const autoWorkgroupName = (members, createdAt) =>
    [['You', ...members.map(member => member.name).filter(Boolean)].join(', '), stamp(createdAt)].filter(Boolean).join(' · ')

  // COPY OF THE ORIGINAL (`checkMembers`, src/host/roster.js:312). Called wherever the
  // member list changes, exactly at the original's three sites: on create, on the re-check
  // just before the record is written, and on any change to membership.
  //
  // Without it this domain accepted a "workgroup" with one member, and with none at all —
  // measured, not assumed: a local group refuses both with "A group chat needs at least two
  // Bots", a workgroup created them silently. A one-member group has nobody to answer the
  // user, which is the state the user reported as "no response".
  function checkMembers(members) {
    if (members.length < WG_ROOM_MIN_MEMBERS) throw new Error('A group chat needs at least two Bots')
    if (members.length > WG_ROOM_MAX_MEMBERS) throw new Error(`A group chat holds at most ${WG_ROOM_MAX_MEMBERS} Bots`)
  }
  wg.checkMembers = checkMembers

  // The automatic name, exposed because the Hub needs it BEFORE the local room exists: the Hub
  // requires text, and the composer legitimately sends none. Keeping it a single function means the
  // name the Hub stores and the name the local room derives cannot drift apart — which they did while
  // the Hub call passed `undefined` and failed with "The group name must be text."
  //
  // No timestamp here: this names a group that is being created right now, and the Hub row is read by
  // other people, for whom a creation timestamp is noise rather than a way to tell two groups apart.
  wg.autoNameFor = members => ['You', ...(members ?? []).map(member => member?.name).filter(Boolean)].join(', ')

  // A workgroup made before the "a group is a Session" fix has a synthetic `wg-<uuid>` id
  // and no Session, so there is nothing to open. Such a record is upgraded in place the
  // first time it is touched: a Session is created, the room is re-keyed to it, and the
  // old key is dropped. Nothing else about the group changes.
  //
  // This is deliberately a migration, not a compatibility mode: after it runs, every
  // workgroup in the state follows the same rule as a local group.
  async function adoptSession(room) {
    if (!String(room.id).startsWith('wg-')) return room
    await wg.load()
    const legacyId = room.id
    const sessionId = await rt.createSession(room.name, {})
    const { [legacyId]: moved, ...rest } = wg.state.workgroups
    const next = { ...moved, id: sessionId }
    wg.state.workgroups = { ...rest, [sessionId]: next }
    // The link table points at the old id; keep it pointing at the group.
    for (const link of Object.values(wg.state.links ?? {})) {
      if (link?.workgroupId === legacyId) link.workgroupId = sessionId
    }
    delete wg.state.sessionOwners[legacyId]
    wg.registerSessionOwner(sessionId, { kind: 'workgroup', workgroupId: sessionId })
    await wg.save()
    rt.warn('ds-bot: workgroup "%s" got its own Session (%s -> %s)', next.name, legacyId, sessionId)
    return next
  }
  wg.adoptSession = adoptSession

  // COPY OF THE ORIGINAL (`retitleRoom`, src/host/roster.js:292): a group is a Session, so
  // the group's name IS the Session's title. Every rename of the record has to carry
  // through to the Session, or the two drift apart — and the Session title is what the
  // "@" menu and the shell's conversation list show.
  //
  // Failure is reported, never fatal, exactly as the original treats it: the group was
  // renamed and saved, and a title that would not take is a cosmetic problem, not a
  // reason to fail the user's rename.
  async function retitleWorkgroup(room) {
    try {
      const agent = await rt.resolveAgent(room.id)
      await ctx.sessionTitle?.rename?.(agent.session, room.name)
    } catch (error) {
      rt.warn('ds-bot: workgroup title for %s not updated: %s', room.name, error)
    }
  }
  wg.retitleWorkgroup = retitleWorkgroup

  // `hubWorkgroupId` is set by host/bridge.js when the group was created on the Hub. Such a group
  // is a *linked* one: its membership is decided by the Hub, and the local member list is a
  // projection that arrives with the first sync. It is therefore the one case where the local
  // "a group needs at least two members" rule does not apply — that rule exists so a local group
  // never has nobody to answer, and a Hub group's answerers are on other machines by design.
  async function createWorkgroup({ name, members = [], adminId, notice = '', hubWorkgroupId } = {}) {
    // The file must be read before anything is written on top of it, or a first-run
    // create would overwrite a state file written by an earlier process.
    await wg.load()
    // Same de-duplication as the original: the composer can offer a Bot twice, and the
    // members are identities, not occurrences.
    const unique = []
    const seen = new Set()
    for (const member of members) {
      const id = member?.id
      if (id === undefined || id === null || seen.has(id)) continue
      seen.add(id)
      unique.push({ ...member })
    }
    // An empty name means "use the automatic one"; it is never an error.
    //
    // No name is checked for uniqueness at all: a workgroup's identity is its id
    // (`wg-<uuid>`), which the user asked to be the sole guarantee. Names are labels —
    // the automatic one already carries a timestamp so two groups over the same Bots stay
    // distinguishable, and a custom name may be reused.
    const custom = String(name ?? '').trim().slice(0, 60)
    const createdAt = Date.now()
    // COPY OF THE ORIGINAL (`createRoom`, src/host/roster.js:323): the member list is
    // checked BEFORE anything is created, so a refused create leaves no Session behind.
    if (hubWorkgroupId === undefined) checkMembers(unique)
    const title = custom !== '' ? custom : autoWorkgroupName(unique, createdAt)
    // COPY OF THE ORIGINAL (`buildRoom`): a group is a Session — `const id = await
    // createSession(title)` — which is exactly what lets the sidebar open it with
    // `openSession(room.id)`. Without one there is nothing to open, which is why a
    // workgroup could be created but not entered.
    const id = await rt.createSession(title, {})
    const room = {
      id,
      name: title,
      ...(custom !== '' ? { named: true } : {}),
      notice: String(notice ?? '').slice(0, 2000),
      members: unique,
      adminId: adminId ?? unique[0]?.id ?? null,
      mode: 'admin',
      createdAt,
      // The Hub's own id for this group, when the group lives on a Hub. Absent for a group that
      // exists only on this machine. It is a plain field of the record: the routing it enables
      // (`roomOfHubGroup`) is a lookup, never a second source of truth for membership.
      ...(hubWorkgroupId === undefined ? {} : { hubWorkgroupId }),
      seq: 0,
      log: [],
      seen: {},
      sessions: {},   // memberId -> sessionId (localBot members only)
      segments: {},   // memberId -> archived part ids
      // COPY OF THE ORIGINAL (`state.rooms[*].permission`): one preset for every member
      // here, in place of each member's own. Absent means "each member uses its own",
      // exactly as an absent `permission` on a local group does. `sessionFor` reads it.
      //
      // ABSENT, not `null`. The original never writes this key until the user turns "Same for
      // every member" on, and every reader tests `!== undefined`: `GroupPermission` computed
      // `shared = room.permission !== undefined` — so `null` drew the toggle as ON — while the
      // picker got `saved: null` and highlighted none of the three presets. That is the reported
      // 「权限不知道选中哪个」. `setRoomPermission` deletes the key to clear it
      // (`src/host/permissions.js:64`), so `null` is a value this field never holds.
    }
    wg.state.workgroups[id] = room
    // The group's own Session belongs to this domain: an owned-but-unrecorded Session is
    // exactly the window the strict resolver must never see (P0-5).
    wg.registerSessionOwner(id, { kind: 'workgroup', workgroupId: id })
    await wg.save()
    // The group opens with its admin asking what it is for, exactly as a new local group
    // does (`greetRoom`). Failure is reported, never fatal: the group exists either way.
    void greetWorkgroup(id).catch(error => rt.warn('ds-bot: workgroup "%s" could not open its chat: %s', title, error?.message ?? error))
    return room
  }
  wg.createWorkgroup = createWorkgroup

  // The local room for a Hub group, if this machine has one. Scanned rather than indexed: there are
  // at most a few dozen workgroups, and a second index could drift from the records it indexes.
  const roomOfHubGroup = (hubWorkgroupId) => {
    if (hubWorkgroupId === undefined) return undefined
    for (const room of Object.values(wg.state?.workgroups ?? {})) {
      if (room?.hubWorkgroupId === hubWorkgroupId) return room
    }
    return undefined
  }
  wg.roomOfHubGroup = roomOfHubGroup

  // Idempotent: the room for a Hub group, created the first time it is needed. Called when this
  // machine creates a group on the Hub and when an event arrives for a group it has just joined,
  // so the chat pane always has a room to open. `name` and `notice` come from the Hub, so the two
  // machines show the same title.
  async function ensureLinkedGroup({ hubWorkgroupId, name, notice = '' }) {
    await wg.load()
    const known = roomOfHubGroup(hubWorkgroupId)
    if (known !== undefined) {
      // The Hub is authoritative for the group's settings: a rename on one machine must not leave
      // another machine showing the old title.
      let changed = false
      if (typeof name === 'string' && name !== '' && known.name !== name) {
        known.name = name.slice(0, 60)
        changed = true
      }
      if (typeof notice === 'string' && known.notice !== notice) {
        known.notice = notice
        changed = true
      }
      if (changed) {
        await retitleWorkgroup(known)
        await wg.save({ workgroupId: known.hubWorkgroupId, roomId: known.id, kind: 'settings' })
      }
      return known
    }
    // A linked group starts with no local member records: the Hub owns the roster, and the first
    // sync fills the log. A local admin id would be a lie — `adminId` is what decides who may
    // rename a LOCAL group.
    return createWorkgroup({ name: name ?? '', notice, hubWorkgroupId })
  }
  wg.ensureLinkedGroup = ensureLinkedGroup

  // The Hub's roster, written into the local room's `members`.
  //
  // Two things need it. A line that arrives from another machine carries the Hub's user id, and
  // without a matching member the log can only say "A member". And a Hub group's member list is
  // decided on the Hub — a person who joined on another device, or an endpoint its owner published,
  // is not somebody this machine picked in a composer.
  //
  // The shape is this domain's own member record (`{id, kind, name, hubUserId}`), because that is
  // what `sessionFor`, `mentionsIn` and the panel already read. A Hub *person* is `kind: 'user'`:
  // there is no local Session for another human, and inventing one would be the fake remote Session
  // plan §8.3 forbids. A Hub *Bot endpoint* is `kind: 'remoteBot'`, with the endpoint id as `id`.
  //
  // `adminId` follows the Hub's owner, so a group renamed on one machine and an admin-only round on
  // another agree about who leads.
  async function applyRoster({ hubWorkgroupId, members: hubMembers, replyMode, permission, leadMembershipId, name, notice, configVersion }) {
    if (hubWorkgroupId === undefined) return undefined
    await wg.load()
    const room = roomOfHubGroup(hubWorkgroupId)
    if (room === undefined) return undefined
    const roster = Array.isArray(hubMembers) ? hubMembers : undefined
    if (roster === undefined) return room
    // COMPARE AND APPLY. Two machines may read the group and save settings at almost the same time;
    // the slower response must not overwrite the newer room. The Hub's version is monotonic, so an
    // answer older than what this room already applied is ignored. An answer with the same version is
    // still applied: the first response for that version may have been a roster-only read.
    if (Number.isFinite(configVersion) && Number.isFinite(room.hubConfigVersion) && configVersion < room.hubConfigVersion) {
      return room
    }
    const versionChanged = Number.isFinite(configVersion) && room.hubConfigVersion !== configVersion
    if (Number.isFinite(configVersion)) room.hubConfigVersion = configVersion
    let changedByRoster = versionChanged
    // THE HUB OWNS THE GROUP'S NAME AND NOTICE, TOO.
    //
    // `syncRoster` reads the whole group (`GET /v1/workgroups/:id`) but used to pass only the
    // roster/settings subset into this function. A `member.changed` notification announcing a
    // rename or a new notice therefore arrived, re-read the Hub, and then dropped those two fields:
    // the colleague's open room kept its old title and notice until a full room read or restart.
    // Apply them here, before the "same roster" early return, because a settings change is exactly
    // a case where the member list did not move.
    if (typeof name === 'string' && name.trim() !== '' && room.name !== name.trim().slice(0, 60)) {
      room.name = name.trim().slice(0, 60)
      changedByRoster = true
    }
    if (typeof notice === 'string' && room.notice !== notice.slice(0, 2000)) {
      room.notice = notice.slice(0, 2000)
      changedByRoster = true
    }

    const next = roster.map((member) => {
      // A Bot endpoint publishes a name, so it has one. A person's account carries no display name in
      // this Hub — the only thing it exposes is a masked phone number — so that is what a member row
      // shows. It is a real limit of the account model (`users` has no `display_name`), not a
      // missing lookup, and inventing one locally would show two machines different names.
      const name = member.memberType === 'botEndpoint'
        ? (member.name ?? member.endpointName ?? member.endpointId)
        : (member.phoneMasked ?? member.name ?? 'A member')
      // THE HUB ANSWERS WITH ENDPOINT IDS, AND SOME OF THEM ARE THIS MACHINE'S OWN BOTS.
      //
      // A member whose `kind` is not `localBot` is handed to the Hub instead of to a local Session
      // (`sessionFor`), which is right for somebody else's Bot and catastrophic for one's own: the
      // round posted "answer this" up to the Hub and waited for a device that was never going to
      // answer, so a workgroup had no greeting and no reply. `endpointBots` is what this machine
      // published (`publishBotEndpoints`), and it is the only place that mapping exists.
      const localBotId = member.memberType === 'botEndpoint'
        ? wg.bridge?.endpointBots?.()?.[member.endpointId] ?? wg.state?.endpointBots?.[member.endpointId]
        : undefined
      const local = localBotId !== undefined && rt.botOf(localBotId) !== undefined
      return {
        // A MEMBER THAT IS ONE OF THIS MACHINE'S BOTS IS IDENTIFIED BY THAT BOT'S ID.
        //
        // The original's group is built of Bot ids (`src/host/roster.js` `createRoom`), and every
        // original component reads a member through `roster.byId[id]`: the admin tag is
        // `room.admin === member.id`, the settings row opens `member.id`, the avatar draws that
        // record. Keyed by the Hub's `ep_…`, `byId[ep_…]` resolved to a copy of the Bot record whose
        // OWN `id` was the Bot's, so `room.admin === member.id` was `ep_…` vs a Bot id and every
        // admin tag vanished while the group still had an admin. `endpointId` below keeps the Hub's
        // id, which is what addressing that endpoint actually needs.
        id: local ? localBotId : member.memberType === 'botEndpoint' ? member.endpointId : member.userId,
        // A Bot of this team answers here; anything else is reached through the Hub.
        kind: local ? 'localBot' : member.memberType === 'botEndpoint' ? 'remoteBot' : 'user',
        name,
        ...(local ? { botId: localBotId } : {}),
        // Which Hub user this member is, so an incoming event's `sender.userId` can be matched to a
        // name without a second lookup.
        hubUserId: member.userId ?? undefined,
        ...(member.memberType === 'botEndpoint' ? { endpointId: member.endpointId } : {}),
        // WHOSE BOT THIS IS, carried on the member record so every surface can say it.
        //
        // A workgroup's members come from several accounts, and two colleagues may each have a Bot
        // called "Chief". Without the owner, the member list is a list of names with no way to tell
        // whose is whose — which is exactly what the user asked for: 「需要在每个 bot 增加标识，
        // 区分每个 bot 的归属」. `hubUserId` above is the PERSON member's account and is empty on a
        // Bot row, so it cannot answer this.
        //
        // `mine` is the Hub's own answer (`ownerIsYou`, computed from the authenticated connection),
        // not a local guess: this machine must not have to know the account ids of its own Bots to
        // draw the tag, and a record written by an older build has no `ownerUserId` at all.
        ...(member.memberType === 'botEndpoint'
          ? {
              ...(member.ownerUserId === undefined ? {} : { ownerUserId: member.ownerUserId }),
              ...(member.ownerIsYou === true ? { mine: true } : {}),
            }
          : {}),
        // THE APPEARANCE THE OWNER PUBLISHED.
        //
        // The original derives a Bot's look from its own id (`lookOf`, characters.js). This roster's
        // ids are Hub ids (`ep_…`), so the same Bot was drawn from a different id on every machine —
        // a different shape and a different colour. The Hub now returns the owner's snapshot, and
        // this is where it becomes part of the member record every component already reads.
        //
        // Only a REMOTE Bot needs it: a member that resolved to one of this team's own Bots (`local`)
        // is indexed by its real id, so `roster.byId` answers with the Bot record itself and its own
        // `avatar` — the live one, which must win over a snapshot taken at publish time.
        ...(!local && member.avatar !== undefined && typeof member.avatar === 'object'
          ? {
              // Split the way `lookOf()` READS it: the shape and the photo live on `avatar`, and the
              // colour lives on the record itself (`colorOf`). Putting all three on `avatar` would
              // leave the colour to be derived from the Hub id again — the same wrong colour, in a
              // different place.
              ...(typeof member.avatar.shape === 'string' ? { avatar: { shape: member.avatar.shape, ...(typeof member.avatar.image === 'string' ? { image: member.avatar.image } : {}) } }
                : typeof member.avatar.image === 'string' ? { avatar: { image: member.avatar.image } } : {}),
              ...(typeof member.avatar.color === 'string' ? { color: member.avatar.color } : {}),
            }
          : {}),
        role: member.role,
        membershipId: member.membershipId,
      }
    }).filter(member => member.id !== undefined && member.id !== null)

    // WHO LEADS. COPY OF THE ORIGINAL (`defaultAdmin`, src/host/roster.js:332):
    // `members.includes(createdBy) ? createdBy : members.find(rt.isMain) ?? null`.
    //
    // The original's group is led by the **Main Bot** among its members — the Bot the user made
    // their chief — and that is what the user means by 「群主是我，管理员是管家 Bot」: they own the
    // group, the Main Bot runs it. `answerable[0]` was neither: it is whichever member the Hub lists
    // first (`memberships ORDER BY joined_at`), so an ordinary Bot that joined earlier took the
    // admin role from the Main Bot. Here that looked like "the admin disappeared", because the tag
    // sat on a Bot the user never chose.
    //
    // A Hub *person* is never the admin, and that part is this domain's own: `usr_…` cannot answer
    // on this machine, so `mode: 'admin'` would call nobody at all — the bug that made every round
    // silent before the roster was projected. The user is the group's OWNER (`role === 'owner'`,
    // shown as 群主 by the roster), which the Hub tracks and this rule leaves alone.
    const answerable = next.filter(member => member.kind === 'localBot')

    // WHO LEADS THIS WORKGROUP — THE OWNER'S MAIN BOT, AND THE SAME ON EVERY MACHINE.
    //
    // The original computes this locally (`defaultAdmin`, src/host/roster.js:332):
    // `members.includes(createdBy) ? createdBy : members.find(rt.isMain) ?? null`. That is right for
    // a LOCAL group, whose members are all one team's Bots: `rt.isMain` asks about ONE `mainBotIds`.
    //
    // A workgroup spans accounts, and the admin is the GROUP OWNER's Main Bot — the user's own words:
    // 「工作群的 Main Bot 是群主的管理员/Main Bot」. Every machine computing `rt.isMain` answers about
    // ITSELF, so Alice's machine picked Alice's Main Bot and Bob's machine picked Bob's, and the same
    // group had two different admins. The two machines then ran `mode: 'admin'` rounds that asked
    // different members.
    //
    // So the Hub's answer is used when there is one: `leadMembershipId` is chosen once by the owner's
    // machine (which is the only place that knows which of its Bots is its Main) and read back here.
    //
    // The fallbacks below are unchanged and still matter: a group made before this field existed has
    // no lead on the Hub, and a group whose lead has left (the column is `ON DELETE SET NULL`) must
    // still have somebody asked first.
    const hubLead = leadMembershipId === undefined || leadMembershipId === null
      ? undefined
      : next.find(member => member.membershipId === leadMembershipId)
    // This machine's Main Bot. Still the right answer when the lead IS one of ours: it is the Bot the
    // owner of this machine calls their chief.
    const mainBot = answerable.find(member => member.botId !== undefined && rt.isMain?.(member.botId) === true)
    // THE OWNER'S OWN BOT, now that the comparison can actually hold.
    //
    // The old test was `owner.memberType !== 'botEndpoint'`: `owner` is the roster's PERSON row
    // (`role === 'owner'`), which is always `memberType: 'user'`, so `ownerMember` was ALWAYS
    // `undefined` and this fallback never ran. The owner's endpoint membership is a SEPARATE row that
    // carries `ownerUserId`, so that is what to look for.
    const ownerUserId = roster.find(member => member.role === 'owner')?.userId
    const ownerMember = ownerUserId === undefined
      ? undefined
      : answerable.find(member => member.ownerUserId === ownerUserId)
    // The Hub's chosen lead, then the owner's own Bot, then this machine's Main Bot, then the first
    // answerable member, then whoever led before rather than dropping to nobody on a bad sync.
    const adminId = hubLead?.id ?? ownerMember?.id ?? mainBot?.id ?? answerable[0]?.id ?? (room.adminId ?? null)

    // Written only when it changed: every event would otherwise touch state.json, and a group with
    // traffic would rewrite the file on each message.
    //
    // The comparison has to cover EVERY field the roster supplies, not just the three it draws.
    // `membershipId` is what the Hub is asked to remove a member by, and it arrives on the same
    // response as the name; a Bot added in this session looked identical to the already-recorded
    // roster under the old three-field test, so the early return kept a record with no
    // `membershipId` — and 「移除成员」 then had no id to send.
    // EVERY FIELD THE ROSTER SUPPLIES, compared — including the ones added for the owner tag and the
    // appearance. A field left out of this list is a field whose change the next roster read throws
    // away: the record looks "the same" and the early return keeps the stale one, which is how a Bot
    // wearing the wrong character would stay wrong forever.
    const sameAppearance = (mine, theirs) => JSON.stringify(mine ?? null) === JSON.stringify(theirs ?? null)
    const same = (room.members ?? []).length === next.length
      && (room.members ?? []).every((member, index) => member.id === next[index]?.id
        && member.name === next[index]?.name
        && member.kind === next[index]?.kind
        && member.botId === next[index]?.botId
        && member.endpointId === next[index]?.endpointId
        && member.membershipId === next[index]?.membershipId
        && member.role === next[index]?.role
        && member.hubUserId === next[index]?.hubUserId
        && member.ownerUserId === next[index]?.ownerUserId
        && member.mine === next[index]?.mine
        && sameAppearance(member.avatar, next[index]?.avatar)
        && member.color === next[index]?.color)
      && room.adminId === adminId
    // WHO ANSWERS A PLAIN MESSAGE — the group's setting, not this machine's.
    //
    // The original keeps this on the room (`buildRoom`: `mode: 'admin'`), and its round reads it in
    // `openingSpeakers`: `room.mode === 'admin'` asks the admin alone, `everyone` asks all of them.
    // A workgroup's round IS that code, so the only thing missing was for the value to be the SAME
    // on both machines — it lived only in this machine's state file, so the colleague's machine kept
    // its own default and answered the same message with a different member.
    //
    // Read BEFORE the early return below, because a settings change arrives with an unchanged
    // member list: the roster is identical, only `replyMode` moved. Returning early first would
    // drop exactly the change this line exists for.
    //
    // Only applied when the Hub actually sent one: an older Hub, or a roster applied from a create
    // response, leaves the local value alone instead of resetting it to a default.
    const modeChanged = WG_ROOM_MODES.includes(replyMode) && room.mode !== replyMode
    // THE GROUP'S SHARED PERMISSION PRESET, taken from the Hub the way the name and the notice are.
    //
    // `undefined` from the Hub means "the Hub has no opinion" (an older Hub, or a create response) —
    // that leaves the local value alone. `null` means "each member uses its own again", which is the
    // original's own representation (`src/host/permissions.js`: `delete room.permission`), so it must
    // CLEAR the local field rather than be ignored.
    //
    // Read before the early return, like the reply mode and for the same reason: a permission change
    // arrives with an unchanged member list.
    let permissionChanged = false
    if (permission !== undefined && (room.permission ?? null) !== permission) {
      if (permission === null || permission === '') delete room.permission
      else room.permission = String(permission)
      permissionChanged = true
      // Apply it to the member Sessions that already exist here, exactly as the original's
      // `setRoomPermission` does: a member with no Session yet picks it up when its first turn makes
      // one (`applyMemberSettings` reads `room.permission`).
      await rt.setRoomPermission?.(room, room.permission ?? null)
        ?.catch?.(error => rt.warn('ds-bot: permission for %s not applied: %s', room.name, error))
    }
    if (same && !modeChanged && !permissionChanged && !changedByRoster) return room
    if (modeChanged) room.mode = replyMode
    if (same) {
      if (changedByRoster) await retitleWorkgroup(room)
      await wg.save({ workgroupId: room.hubWorkgroupId, roomId: room.id, kind: 'settings' })
      return room
    }
    const previous = room.members ?? []
    room.members = next
    room.adminId = adminId
    // A member's group Session and read cursor are keyed by its MEMBER ID
    // (`room.sessions[member.id]`, `room.seen[member.id]`), and that id just changed for this
    // machine's own Bots: the Hub's `ep_…` became the Bot's own id. Without this the machine kept
    // an owned Session nothing pointed at (`registerSessionOwner` still lists it, so it is not even
    // reclaimable) and the member started a second one on its next turn, losing what it had read.
    // Matched on `endpointId`, the one field that is stable across both shapes.
    const before = new Map()
    for (const member of previous) if (member?.endpointId !== undefined) before.set(member.endpointId, member.id)
    for (const member of next) {
      const was = member.endpointId === undefined ? undefined : before.get(member.endpointId)
      if (was === undefined || was === member.id) continue
      for (const key of ['sessions', 'seen']) {
        const map = room[key]
        if (map?.[was] === undefined || map[member.id] !== undefined) continue
        map[member.id] = map[was]
        delete map[was]
      }
    }
    await wg.save({ workgroupId: room.hubWorkgroupId, roomId: room.id, kind: 'roster' })
    // THE GROUP OPENS ITSELF AS SOON AS IT HAS SOMEBODY TO SPEAK.
    //
    // `createWorkgroup` greets immediately, which is right for a group made with members already in
    // it. A group made on the Hub is not: `ensureLinkedGroup` creates the room with NO members,
    // because the Hub owns the roster, so `adminId` is null and the greet returns early. Nothing
    // greeted it afterwards either — the roster arrived later and no one asked again — so a
    // workgroup created while signed in opened as a blank page, with no greeting and no
    // introduction, while the identical local group opened properly.
    //
    // This is the first moment a Hub group can speak at all, so it is where the greeting belongs.
    // `greeted` makes it happen exactly once, even though the roster is re-applied on every change.
    if (room.greeted !== true && (room.adminId ?? null) !== null) {
      void greetWorkgroup(room.id).catch(error => rt.warn('ds-bot: workgroup "%s" could not open its chat: %s', room.name, error?.message ?? error))
    }
    return room
  }
  wg.applyRoster = applyRoster

  // Merges the Hub's roster into a local room without needing the full payload: used after a create
  // and after an invite, where the caller has only an id.
  async function syncRoster({ hubWorkgroupId }) {
    if (hubWorkgroupId === undefined) return undefined
    const answer = await wg.hub?.workgroup?.(hubWorkgroupId).catch(() => undefined)
    if (answer === undefined || Array.isArray(answer.members) === false) return undefined
    // A GROUP MADE BEFORE THE LEAD FIELD EXISTED STILL GETS ITS LEAD.
    //
    // Creating a group names the lead (`channel.js`) and changing the admin names it again
    // (`updateWorkgroup`). A group that already existed when the column arrived did neither, so it
    // keeps `lead_membership_id = null` forever, every machine falls back to its own `rt.isMain`,
    // and the divergence the field removes is still there.
    //
    // The owner's machine is the only one that can answer: `mainBotIds` is a per-machine fact, and
    // only the owner's list describes the OWNER's Main Bot. So that machine fills the gap on the next
    // roster read. This is the same condition as create, not a new rule.
    //
    // One attempt, no polling: after success the Hub has an answer and this test is false. Best
    // effort by construction — a failed write is reported and the roster still applies with the
    // original fallbacks, because a chat that cannot sync is worse than a lead that needs another
    // try on the next sync. `applyRoster` deliberately stays free of network writes.
    let resolvedLeadMembershipId = answer.leadMembershipId
    if (answer.leadMembershipId === null) {
      const hubUserId = wg.hub?.account?.hubUserId
      const mainBotId = (rt.state?.mainBotIds ?? [])[0]
      const mainMembership = mainBotId === undefined
        ? undefined
        : answer.members.find(member => member.memberType === 'botEndpoint'
          && member.ownerUserId === hubUserId
          && wg.bridge?.endpointBots?.()?.[member.endpointId] === mainBotId)
      if (hubUserId !== undefined && answer.ownerUserId === hubUserId && mainMembership !== undefined) {
        const written = await wg.bridge?.updateGroupSettings?.({ workgroupId: hubWorkgroupId, leadMembershipId: mainMembership.membershipId })
          .then(() => true)
          .catch(error => {
            rt.warn?.('ds-bot: the lead of workgroup %s was not backfilled: %s', hubWorkgroupId, error?.message ?? error)
            return false
          })
        // The current response predates the write. Use its own membership id locally so this
        // roster read resolves the admin it just named; the next read gets the same answer from
        // the Hub.
        if (written === true) resolvedLeadMembershipId = mainMembership.membershipId
      }
    }
    return applyRoster({
      hubWorkgroupId,
      members: answer.members,
      replyMode: answer.replyMode,
      permission: answer.permission,
      leadMembershipId: resolvedLeadMembershipId,
      // The whole group answer is authoritative for these two as well. Dropping them here was why
      // a Hub settings notification re-read the roster but left the open room's title/notice stale.
      name: answer.name,
      notice: answer.notice,
      // The version that answer was read at. `applyRoster` refuses to let an older answer overwrite
      // a newer room, and every settings write sends this version back as its compare token.
      configVersion: answer.configVersion,
    })
  }
  wg.syncRoster = syncRoster

  // Every Hub group this account is in becomes a local room, so a group can be FOUND and not only
  // received.
  //
  // Why this exists: a machine only ever learned about a group it had not created when an event for
  // it arrived (`bridge.js` `ensureRoom`) or when it accepted an invitation in this process. Both
  // are one-shot. A colleague who accepted an invitation, then restarted, restarted into a list that
  // no longer mentioned the group — the Hub row was still there, but nothing on this machine turned
  // it into something the sidebar could draw, so there was nothing to click and no messages to read.
  //
  // Idempotent by construction: `ensureLinkedGroup` returns the existing room for a known Hub group,
  // so this only ever adds what is missing. A Hub that is down answers `undefined`/throws, and the
  // whole step is skipped rather than failing the state read — the group list must still render.
  async function adoptHubGroups() {
    // Throttled: `state` is polled (the panel's connection line asks every 5 seconds), and each
    // miss would otherwise be a Hub round trip. A minute is far below the time it takes a person to
    // notice a group is missing, and it keeps a poll from becoming Hub traffic.
    const now = Date.now()
    if (now - (wg.lastAdoptAt ?? 0) < WG_ADOPT_INTERVAL_MS) return 0
    wg.lastAdoptAt = now
    const groups = await wg.hub?.workgroups?.().catch(() => undefined)
    if (!Array.isArray(groups) || groups.length === 0) return 0
    let added = 0
    for (const group of groups) {
      const workgroupId = group?.workgroupId
      if (typeof workgroupId !== 'string' || workgroupId === '') continue
      if (roomOfHubGroup(workgroupId) !== undefined) continue
      const room = await ensureLinkedGroup({
        hubWorkgroupId: workgroupId,
        name: group.name,
        notice: group.notice ?? '',
      }).catch(() => undefined)
      if (room === undefined) continue
      added += 1
      // A freshly adopted room has no members and no log — `ensureLinkedGroup` deliberately starts
      // it empty, because the Hub owns both. Filling them here is what makes the adopted group as
      // usable as one this machine created: without the roster the member list is empty, and
      // without the pull the group opens blank even though the Hub has the conversation.
      await wg.syncRoster?.({ hubWorkgroupId: workgroupId }).catch(() => {})
      await wg.bridge?.sync?.(workgroupId).catch(() => {})
    }
    return added
  }
  wg.adoptHubGroups = adoptHubGroups

  // Rename, notice, admin and membership changes. The original does this in
  // roster.js's planRoomChange/updateRoom; here it is one small function because a
  // Workgroup's members come from the Hub later (G4) and are not local Bots.
  // A member record built from an id the composer sent.
  //
  // `kind` IS NOT OPTIONAL, and the composer only ever sends an id. A plain `{ id, name }` record
  // fails every `kind` test in this file: `sessionFor` returns `undefined` for anything that is not
  // `'localBot'` (plan §8.3's no-fake-remote-Session rule), and the round hands such a member to
  // `wg.deliverRemote` instead of running its turn here. So a Bot added through 「添加成员」 became a
  // member the group could @ but never answer with: the round posted "you were named" at the Hub and
  // nothing came back, while the same Bot added at CREATE time talked normally. That is
  // 「先建群后邀请新的 Bot 进群，管家无法调用和对话这个新 Bot」.
  //
  // A local Bot when this machine has it, otherwise a Hub person. A stranger's Bot is never added
  // here: only its owner may put it in a group, and that happens on the Hub.
  const localMember = (id, given) => {
    const record = given !== null && typeof given === 'object' ? { ...given } : { id }
    const known = rt.botOf?.(id)
    if (record.name === undefined && known !== undefined) record.name = known.name
    if (record.kind === undefined) record.kind = known !== undefined ? 'localBot' : 'user'
    if (record.kind === 'localBot' && record.botId === undefined) record.botId = id
    return record
  }

  // Takes members off a HUB group's roster, and refuses rather than pretending.
  //
  // `applyRoster` replaces `room.members` from the Hub whenever the roster is read, so deleting a row
  // only on this machine is undone by the next read: 「移除成员，过一会又回来了」. The mirror of
  // `joinWithPrimaryBot`, and it has to exist for the same reason — an add that reaches the Hub and a
  // remove that does not is a group whose member list only ever grows.
  //
  // The throw is deliberate. A Hub refusal leaves the local list exactly as it was, so the settings
  // form can say what happened; deleting here first and failing later would show a member gone from a
  // group they are still in.
  const removeFromHub = async (room, members) => {
    if (room.hubWorkgroupId === undefined) return
    for (const member of members) {
      if (member === undefined) continue
      // Only a Bot of this team: a Hub person leaves with their own account, and another team's Bot
      // belongs to its owner. `leaveMember` enforces the same rule on the Hub's side.
      if (member.kind !== 'localBot' || member.membershipId === undefined) continue
      const failed = await wg.bridge?.leaveMember?.({ workgroupId: room.hubWorkgroupId, membershipId: member.membershipId })
        .then(() => undefined)
        .catch(error => error)
      if (failed !== undefined) {
        throw new Error(`"${room.name}" lives on the Hub, and ${member.name} was not removed there: ${failed?.message ?? failed}. Try again when the Hub is reachable.`)
      }
    }
  }

  async function updateWorkgroup(roomId, patch = {}, actorId) {
    await wg.load()
    const room = wg.workgroupOf(roomId)
    if (room === undefined) throw new Error('Unknown workgroup')
    // Only the user (actorId undefined) or the group's admin may change it, the same
    // rule the original applies to a local group.
    if (actorId !== undefined && room.adminId !== actorId) {
      throw new Error(`Only the user or the admin of "${room.name}" can change it`)
    }
    // The settings as they were before this call, so the Session title can be brought in line with
    // the record afterwards (COPY OF the original, roster.js:445,459) and so only what actually moved
    // is pushed to the Hub. A snapshot rather than the name alone: the reply mode is pushed by the
    // same path, and it needs the same "did it change" test.
    const before = { name: room.name, mode: room.mode, permission: room.permission ?? null, lead: room.adminId ?? null }
    if (patch.name !== undefined) {
      const clean = String(patch.name).trim().slice(0, 60)
      // A custom name must be unique (the original's cleanRoomName rule); an empty one
      // means "derive it from the members", which is how a group returns to its
      // automatic name. Automatic names may repeat — two groups over the same Bots are
      // the same name by definition.
      if (clean !== '') {
        // A custom name is a label, not an identity: duplicates are allowed (the id is
        // what distinguishes two groups).
        room.name = clean
        room.named = true
      } else {
        room.name = autoWorkgroupName(room.members, room.createdAt ?? Date.now())
        delete room.named
      }
    }
    if (patch.notice !== undefined) room.notice = String(patch.notice ?? '').slice(0, 2000)
    // COPY OF THE ORIGINAL (`planRoomChange`, src/host/roster.js:392): the reply mode is
    // one of the two the original accepts. Before this, the settings form offered "Who
    // answers" and the choice was dropped on the floor — `room.mode` stayed 'admin' while
    // the form's own optimistic frame showed the switch moved, so the page looked saved
    // and reverted on the next read.
    if (patch.mode !== undefined) {
      if (!WG_ROOM_MODES.includes(patch.mode)) throw new Error(`Reply mode must be one of ${WG_ROOM_MODES.join(', ')}`)
      room.mode = patch.mode
    }
    // COPY OF THE ORIGINAL (`updateRoom`, src/host/roster.js:409,440): the one folder
    // every member of this group works in. `cleanWorkDir` is the original's own guard, so
    // a workgroup cannot point its members at DSH's data either. An empty value means
    // "each member in its own folder again", which is what an absent `workDir` means.
    if (patch.workDir !== undefined) {
      const workDir = await rt.cleanWorkDir(patch.workDir ?? '')
      if (workDir === undefined) delete room.workDir
      else room.workDir = workDir
    }
    if (patch.adminId !== undefined) {
      if (patch.adminId !== null && !room.members.some(member => member.id === patch.adminId)) {
        throw new Error('The admin must be a member of the workgroup')
      }
      // Groups that share a name cannot have their admin changed: with two rows reading
      // the same, a change is not safely attributable to one of them. The user's rule —
      // "同名的群聊之间禁止修改管理员，需要改就先改群名" — so the fix is to give this group
      // its own name first, then change the admin.
      const sameName = Object.values(wg.state.workgroups).filter(other => other.name === room.name).length
      if (sameName > 1) {
        throw new Error(`"${room.name}" is also the name of another group; rename this one before changing its admin`)
      }
      room.adminId = patch.adminId
    }
    // COPY OF THE ORIGINAL (`updateRoom`, src/host/roster.js:396,456): the group's own
    // preset, and the user's alone to set. `setRoomPermission` writes `room.permission`
    // itself and walks the members' Sessions that already exist here, the way the
    // original does for a local group's.
    if (patch.permission !== undefined) {
      if (actorId !== undefined) throw new Error(`Only the user can set the permissions of "${room.name}"`)
      await rt.setRoomPermission(room, patch.permission)
    }
    // COPY OF THE ORIGINAL (`planRoomChange`, src/host/roster.js:381): the member list is
    // validated BEFORE it is written, so a refused change leaves the record untouched. The
    // original computes the prospective list, checks it, and only then assigns.
    const changesMembers = Array.isArray(patch.members) || Array.isArray(patch.add) || Array.isArray(patch.remove)
    if (changesMembers) {
      const next = Array.isArray(patch.members)
        ? patch.members.map(member => (member !== null && typeof member === 'object' ? member.id : member)).filter(id => id !== undefined && id !== null)
        : [
            ...room.members.map(member => member.id),
            ...(patch.add ?? []).map(member => (member !== null && typeof member === 'object' ? member.id : member)).filter(id => id !== undefined && id !== null),
          ].filter(id => !(patch.remove ?? []).includes(id))
      checkMembers([...new Set(next)])
    }
    // COPY OF THE ORIGINAL (`members`): the whole list at once, in place of add/remove.
    // A workgroup member carries its own record (kind, name) and may be remote later
    // (G4), so an id already on the record keeps that record rather than being rebuilt
    // from the id alone.
    if (Array.isArray(patch.members)) {
      const kept = []
      for (const member of patch.members) {
        const id = member !== null && typeof member === 'object' ? member.id : member
        if (id === undefined || id === null || kept.some(other => other.id === id)) continue
        // The same `kind` gap `add` has: a bare id here used to become `{ id }`, which no `kind`
        // test in this file accepts as a local Bot. `localMember` fills it in one place.
        kept.push(room.members.find(other => other.id === id) ?? localMember(id, member))
      }
      // A member taken off the list loses its Session, the way `remove` below does it — and, for a
      // Hub group, loses its membership on the Hub too, or `applyRoster` puts it back.
      const gone = room.members.filter(member => !kept.some(other => other.id === member.id))
      await removeFromHub(room, gone)
      for (const member of gone) {
        const sessionId = room.sessions?.[member.id]
        if (sessionId !== undefined) {
          wg.releaseSessionOwner(sessionId)
          void ctx.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true })?.catch?.(() => {})
          delete room.sessions[member.id]
        }
        delete room.seen[member.id]
      }
      room.members = kept
      if (room.adminId !== null && !kept.some(member => member.id === room.adminId)) room.adminId = kept[0]?.id ?? null
    }
    // COPY OF THE ORIGINAL (`updateRoom`, src/host/roster.js:377). `add` and `remove` take
    // member IDS, exactly as the original's do — the settings form is the original form
    // and sends `{ add: [id] }`. This used to read `member.id` off each entry, so a plain
    // id added nobody and the member row the form drew was a phantom.
    //
    // A member of a HUB group is removed on the Hub as well, and that is not symmetric decoration:
    // `applyRoster` replaces `room.members` from the Hub on every membership change, so a row deleted
    // only here came back on the next read — 「移除成员，过一会又回来了」. The Hub call goes FIRST so its
    // refusal leaves the local list untouched, instead of deleting here and silently reverting later.
    await removeFromHub(room, (patch.remove ?? []).map(memberId => room.members.find(other => other.id === memberId)))
    for (const memberId of patch.remove ?? []) {
      const at = room.members.findIndex(member => member.id === memberId)
      if (at === -1) continue
      const sessionId = room.sessions?.[memberId]
      if (sessionId !== undefined) {
        wg.releaseSessionOwner(sessionId)
        void ctx.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true })?.catch?.(() => {})
        delete room.sessions[memberId]
      }
      room.members.splice(at, 1)
      delete room.seen[memberId]
      if (room.adminId === memberId) room.adminId = room.members[0]?.id ?? null
    }
    const addedToHub = []
    // What the member list looked like before this call, so a Hub refusal can put it back exactly.
    const membersBeforeAdd = room.members.map(member => ({ ...member }))
    for (const member of patch.add ?? []) {
      // An id, as the original takes it, OR a record, which is what the composer sends.
      const id = member !== null && typeof member === 'object' ? member.id : member
      if (id === undefined || id === null) continue
      if (room.members.some(other => other.id === id)) continue
      // `kind` IS NOT OPTIONAL, and the composer only ever sends an id — see `localMember`.
      const record = localMember(id, member)
      room.members.push(record)
      // A group that lives on the Hub keeps its roster there. Recording the member only here left
      // the added Bot in a roster no other machine had — and the next roster read (`applyRoster`)
      // replaced `room.members` wholesale, so the Bot vanished even from here.
      if (room.hubWorkgroupId !== undefined && record.kind === 'localBot') addedToHub.push(String(id))
    }
    // COPY OF THE ORIGINAL (`followMemberNames`, src/host/roster.js:303): a group the user
    // did NOT name is named after its members, so it follows them. The original skips a
    // named group (`if (room.named) continue`), and so does this: a name the user chose is
    // theirs, and must not quietly change when a member comes or goes.
    //
    // This runs BEFORE the rename check below so a member-driven name change is retitled
    // by the same step, exactly as the original's two call sites do.
    if (!room.named && (patch.members !== undefined || patch.add !== undefined || patch.remove !== undefined)) {
      room.name = autoWorkgroupName(room.members, room.createdAt ?? Date.now())
    }
    await wg.save()
    // The Hub learns about the Bots added here, one publish-and-add per Bot.
    //
    // A Hub group's roster comes FROM the Hub: `applyRoster` replaces `room.members` on every
    // membership change, so a member recorded only here is a member that disappears the moment the
    // roster is next read. Adding it on the Hub is what makes it real for everyone, this machine
    // included.
    //
    // So a refusal UNDOES the local edit and is reported. Keeping the member locally would be the
    // worse answer: the Bot would work until the next sync and then silently vanish, which is the
    // 「加了 Bot 但管家还是叫不动」 symptom with no explanation attached.
    if (addedToHub.length > 0) {
      const asked = await wg.bridge?.joinWithPrimaryBot?.({ workgroupId: room.hubWorkgroupId, botIds: addedToHub })
        .then(added => ({ added: added ?? [] }))
        .catch(error => ({ error }))
      const failed = asked?.error ?? ((asked?.added ?? []).length === addedToHub.length
        ? undefined
        : new Error('the Hub did not accept every Bot'))
      if (failed !== undefined) {
        room.members = membersBeforeAdd
        await wg.save().catch(() => {})
        throw new Error(`"${room.name}" lives on the Hub, and the Hub did not accept ${addedToHub.length > 1 ? 'those Bots' : 'that Bot'}: ${failed?.message ?? failed}. Connect to the Hub and try again.`)
      }
    }
    // COPY OF THE ORIGINAL (`updateRoom`, src/host/roster.js:459): "if (room.name !==
    // before) { changes.push(`renamed it …`); await retitleRoom(room) }".
    //
    // The report 「@的时候，显示的群名称不对」is this line missing. A workgroup IS a
    // Session (`createWorkgroup` copies the original's `createSession(title)`), so the
    // Session carries a title of its own. Nothing renamed it, so it kept whatever it was
    // created with — the screen showed the "@" menu offering "You, Chief, 阿三大苏打"
    // for a group called 阿松大, because that was the Session's title, not the group's
    // name. The original keeps the two in step on every rename; so does this now.
    if (room.name !== before.name) await retitleWorkgroup(room)
    // THE HUB LEARNS THE NAME AND THE NOTICE, because they are the two settings it stores.
    //
    // A workgroup's title and notice live on the Hub (`workgroups.name` / `workgroups.notice`), and
    // `ensureLinkedGroup` copies them onto every other machine — that is how two people see the same
    // group title. But nothing ever wrote them BACK: a rename or a new notice changed this machine's
    // record, the Hub kept the old value, and the next roster read (or the next start) put the old
    // one straight back. That is what 「设置改了又变回去」 is.
    //
    // WHICH SETTINGS TRAVEL. A workgroup is one group with several people in it, so a setting that
    // decides what happens in the group has to be the same everywhere — otherwise the two machines
    // take different decisions about the same message:
    //   * `name` and `notice` — the title and the shared instruction;
    //   * `mode` (reply mode) — who answers a plain message. This is the one the user reported
    //     (「没有点名 @ 其他同事的 bot，跟原群聊一样由管理员接待」): a local-only value meant the
    //     colleague's machine kept its own default and the admin never received the message there.
    // The rest — admin, folder, permission — stay local: each machine runs its own Bots with its own
    // folders and its own capability presets, and a shared folder would be a path the Hub must never
    // learn (plan §13.2). `SETTINGS_FIELDS` on the Hub refuses anything else by name.
    const modeChanged = patch.mode !== undefined && room.mode !== before.mode
    // The group's permission preset is sent whenever the caller touched it, INCLUDING when it was
    // switched off: `null` is the value that means "each member uses its own again", and skipping it
    // would leave the old preset on the Hub for every other machine to keep applying.
    // WHO LEADS THIS GROUP, SENT TO THE HUB.
    //
    // `room.adminId` is the original's field and `patch.adminId` above writes it; what is new is that
    // the choice now TRAVELS. The original computes the admin locally (`defaultAdmin`:
    // `members.find(rt.isMain)`), which is right for a local group because `rt.isMain` asks about one
    // team's `mainBotIds`. A workgroup spans accounts and its admin should be the GROUP OWNER's Main
    // Bot (「工作群的 Main Bot 是群主的管理员/Main Bot」), so each machine computing it from its own
    // team produced a different admin and `mode: 'admin'` rounds asked different members.
    //
    // So whichever member this room now calls the admin is named to the Hub as `leadMembershipId`,
    // and every other machine reads that instead of deriving one. `patch.lead` is accepted as an alias
    // because the settings form speaks in member ids.
    let leadTouched = false
    // `patch.lead === null` is an INTENT, recorded before the re-resolution below overwrites
    // `adminId`: "clear the Hub's choice", not "the new choice is the re-resolved member".
    let leadCleared = false
    if (patch.lead !== undefined) {
      if (patch.lead !== null && !room.members.some(member => member.id === patch.lead)) {
        throw new Error(`"${patch.lead}" is not a member of "${room.name}"`)
      }
      if ((room.adminId ?? null) !== (patch.lead ?? null)) {
        room.adminId = patch.lead
        leadTouched = true
        if (patch.lead === null) leadCleared = true
      }
    }
    // An admin change made through the ORIGINAL field (`patch.adminId`, which the settings form sends
    // as `admin`) travels to the Hub the same way. Read AFTER the re-resolution below would be wrong —
    // that would report a change the caller never asked for — so it is compared against `before` here.
    if (patch.adminId !== undefined && room.adminId !== before.lead) leadTouched = true
    // A CLEARED LEAD IS RE-RESOLVED HERE, because nothing else will do it in this call.
    //
    // `applyRoster` only recomputes `adminId` when it decides the roster "changed"; a group whose lead
    // was just cleared has an unchanged member list, so on the next read it would keep the admin that
    // was un-chosen. Clearing the choice has to mean "go back to the rule", not "have nobody".
    //
    // The rule is the same one `applyRoster` uses for a group with no lead: this team's Main Bot if it
    // is here, else the first member that can answer.
    if (room.adminId === null) {
      const answerable = (room.members ?? []).filter(member => member.kind === 'localBot')
      const mainBot = answerable.find(member => member.botId !== undefined && rt.isMain?.(member.botId) === true)
      room.adminId = mainBot?.id ?? answerable[0]?.id ?? null
    }
    const permissionTouched = patch.permission !== undefined
    if (room.hubWorkgroupId !== undefined
      && (room.name !== before.name || patch.notice !== undefined || modeChanged || permissionTouched || leadTouched)) {
      const pushed = await Promise.resolve()
        .then(() => wg.bridge.updateGroupSettings({
          workgroupId: room.hubWorkgroupId,
          // Compare-and-apply: the Hub refuses this if the group moved since the local room last
          // read it. The caller then re-reads rather than overwriting a newer value.
          ...(room.hubConfigVersion === undefined ? {} : { configVersion: room.hubConfigVersion }),
          ...(room.name !== before.name ? { name: room.name } : {}),
          ...(patch.notice !== undefined ? { notice: room.notice ?? '' } : {}),
          ...(modeChanged ? { replyMode: room.mode } : {}),
          ...(permissionTouched ? { permission: room.permission ?? null } : {}),
          // The membership id this room resolved the chosen member to. `null` clears it on the Hub, so
          // every machine goes back to its local rule instead of keeping a lead nobody chose.
          // The MEMBERSHIP this room resolved its admin to, or `null` when there is none. Sent by
          // membership id because that is the identity both machines agree on: the same Bot is a local
          // id on its owner's machine and an `ep_…` on everybody else's.
          ...(leadTouched
            ? {
                leadMembershipId: leadCleared
                  ? null
                  : (room.members ?? []).find(member => member.id === room.adminId)?.membershipId ?? null,
              }
            : {}),
        }))
        .then((answer) => {
          // The write names the version it produced. Advancing the local fence now lets several
          // edits in a row work without waiting for a roster notification between each one.
          const version = answer?.workgroup?.configVersion ?? answer?.configVersion
          if (Number.isFinite(version)) room.hubConfigVersion = version
          return undefined
        })
        .catch(error => error)
      // Reported, never silently swallowed. The local change is already saved and the next roster
      // read adopts the Hub's value, so a failure here means the change will REVERT — the settings
      // page has to say so rather than let the user watch it undo itself.
      if (pushed !== undefined) {
        throw new Error(`"${room.name}" was changed here, but the Hub did not accept the change: ${pushed?.message ?? pushed}. It would revert on the next sync, so connect to the Hub and try again.`)
      }
    }
    return room
  }
  wg.updateWorkgroup = updateWorkgroup

  async function deleteWorkgroup(roomId) {
    await wg.load()
    const room = wg.workgroupOf(roomId)
    if (room === undefined) throw new Error('Unknown workgroup')
    // THE HUB FIRST, THE LOCAL ROOM SECOND.
    //
    // A workgroup lives on the Hub, and this only ever deleted the local record. The next start runs
    // `adoptHubGroups`, which lists the account's groups and makes a local room for each one without
    // a room — so the group the person had just deleted came back, every time (「删除工作群，采取本应用
    // 后又出现了，反而本地群不会」; a local group never returns because nothing outside holds it).
    //
    // Ordered this way because the two failures are not equal: if the Hub refuses, nothing local has
    // changed yet and the group is still usable; if the Hub succeeds and this machine then failed to
    // save, the next start would simply re-adopt a group that had already been deleted — visible, and
    // not data loss. The reverse order loses the local record for a group that still exists.
    //
    // A group that exists only here (no `hubWorkgroupId`) has nothing to tell the Hub, and that is
    // the local-group case, unchanged.
    const onHub = room.hubWorkgroupId
    if (onHub !== undefined) {
      await wg.hub?.deleteWorkgroup?.(onHub).catch((error) => {
        throw new Error(error?.message ?? String(error))
      })
    }
    // A deleted group's knowledge must not survive as a local folder that a later room with the
    // same id could read. The original `deleteRoom` archives group memory for exactly this reason
    // (`src/host/roster.js:484`); this copy was missing that call. It runs before the member
    // Sessions leave the record, because the archive reads their snapshots.
    await Promise.resolve(rt.archiveGroupMemory?.(room))
      .catch(error => rt.warn('ds-bot: memory of workgroup %s not archived: %s', room.name, error?.message ?? error))
    // A member's Session is released with the group, and archived the way the
    // original does it, so no turn goes on working for a group that is gone.
    for (const sessionId of Object.values(room.sessions ?? {})) {
      wg.releaseSessionOwner(sessionId)
      void ctx.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true })?.catch?.(() => {})
    }
    dropLines(roomId)
    wg.roomInbox.delete(roomId)
    for (const [callId, round] of wg.roomProgress) if (round.roomId === roomId) wg.roomProgress.delete(callId)
    // A deleted group has nobody left to continue a recovered round. Removing the projections with
    // the room keeps a later `reconcileRounds` from finding an obligation for a group that is gone.
    for (const [roundId, record] of Object.entries(wg.state.rounds ?? {})) {
      if (record.roomId === roomId) delete wg.state.rounds[roundId]
    }
    delete wg.state.workgroups[roomId]
    wg.releaseSessionOwner(roomId)
    await wg.save()
    // COPY OF THE ORIGINAL (`deleteRoom`, src/host/roster.js:477): the group's OWN Session
    // is archived after the record is gone. The loop above archives its MEMBERS' Sessions
    // and this one was left out, so a deleted workgroup's own Session lived on in the
    // shell's Session list — which is where the "@" menu gets its conversations. That is
    // the report 「右键菜单删除的群聊，@的时候还存在」: the group was gone from the panel
    // and its Session was still offered as something to mention.
    //
    // Archiving stops its activity too, so an armed scheduled task cannot keep delivering
    // into a workgroup that no longer exists — the same reason the original gives.
    await ctx.workspaceRegistry?.archiveSession?.(roomId, { stopActivity: true })
      ?.catch?.(error => rt.warn('ds-bot: workgroup %s not archived: %s', room.name, error))
  }
  wg.deleteWorkgroup = deleteWorkgroup

  // A workgroup deleted by a build that did not archive its own Session left that Session
  // behind, and the "@" menu — which lists every Session not known to be part of the team
  // — kept offering it as a conversation to reference. That is the second half of the
  // report 「右键菜单删除的群聊，@的时候还存在」.
  //
  // `deleteWorkgroup` archives its Session now, so this only ever has work to do once: it
  // looks for Sessions this domain still owns whose group no longer exists, and archives
  // them. Once they are gone the set is empty, which is why it can run on every state read
  // for the price of one comparison per group.
  async function adoptOrphans() {
    const groups = wg.state?.workgroups ?? {}
    // Only a GROUP's own Session: `owner.botId === undefined` is what tells it apart from a
    // member's (a member's Session always names the Bot it speaks for). A member's Session
    // whose group is gone is released by `deleteWorkgroup`/`updateWorkgroup` when the member
    // leaves; treating one as an orphan here would archive a Session in use.
    const orphans = [...wg.sessionOwners.entries()]
      .filter(([sessionId, owner]) => owner?.botId === undefined && groups[sessionId] === undefined)
      .map(([sessionId]) => sessionId)
    for (const sessionId of orphans) {
      wg.releaseSessionOwner(sessionId)
      await ctx.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true })
        ?.catch?.(error => rt.warn('ds-bot: leftover workgroup Session %s not archived: %s', sessionId, error))
    }
    if (orphans.length > 0) {
      await wg.save()
      rt.warn('ds-bot: archived %d workgroup Session(s) left behind by a deleted group', orphans.length)
    }
  }
  wg.adoptOrphans = adoptOrphans

  // A member's Session in this workgroup. Created on first turn, owned by this
  // domain, and never registered in the original's groupOwners.
  //
  // COPY OF THE ORIGINAL (`groupSessionFor`, src/host/groups.js:184-214), including the
  // five things it does to a member's Session after creating it. This copy skipped ALL
  // five, which is why a workgroup member was not the same Bot as in a local group:
  //
  //   1. `desiredModel` -> `selectSessionModel`: the Session runs the Bot's own model.
  //   2. `applyPermission`: the Session runs under the Bot's (or the group's) preset.
  //      Without it the gate's "未授权工具拒绝" and "撤权" have nothing to stand on in a
  //      workgroup — a revoked tool stayed usable there.
  //   3. `ensureCapabilities`: the Bot's tools and MCP servers are mounted.
  //   4. `ownChatBrief`: the first turn starts with a brief of the Bot's own chat.
  //   5. `delete room.seen[member.id]`: the new Session is shown the whole log.
  //
  // The room is passed to `applyPermission` EXPLICITLY, and that is not cosmetic:
  // `applyPermission`'s default is `roomOfSession(sessionId)`, which reads
  // `rt.groupOwners` (src/host/permissions.js:21,30-32) — an index this domain never
  // writes. Left to its default it silently falls back to `bot.permission`, so a
  // workgroup's own preset would never apply and the failure would be invisible: no
  // error, no log. Passing the record makes the group preset real.
  async function sessionFor(room, member) {
    await wg.load()
    room.sessions ??= {}
    const known = room.sessions?.[member.id]
    if (known !== undefined) {
      // The Bot's capabilities may have been granted since this Session was made.
      await rt.ensureCapabilities(known)
      return { id: known, brief: undefined }
    }
    // A remote member speaks through the Hub, not a local Session (plan §8.3). Returning
    // `undefined` — rather than throwing — is what "there is no local Session for this member"
    // means everywhere else in this file, and it is what lets `runRound` hand the turn to the
    // bridge instead of reporting a failed Bot to the user.
    if (member.kind !== 'localBot') return undefined
    // The BOT a member stands for. A local group's `member` IS the Bot's id, so the
    // original hands `member` straight to the five steps below; a Workgroup member is an
    // identity record (`{id, kind, name}`), and handing THAT to them would read
    // `member.model`, `member.permission`, `member.workDir` and find nothing — every step
    // would run against an object with no model, no preset and no folder, and silently do
    // nothing instead of failing. `botId` is used when a remote member carries one.
    const botId = member.botId ?? member.id
    const bot = rt.botOf(botId)
    // COPY OF THE ORIGINAL: the Session starts in the Bot's working folder (the group's
    // there, else its own), not in the team workspace.
    const sessionId = await rt.createSession(`${member.name} · ${room.name}`, { dir: rt.workDirOf({ botId, roomId: room.id }) })
    // The member may have left, or the group been deleted, while the Session was made.
    if (wg.workgroupOf(room.id) !== room || !room.members.some(other => other.id === member.id)) {
      void ctx.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true })?.catch?.(() => {})
      return undefined
    }
    // Ownership first, then the room record: a Session that exists but is unowned is
    // exactly the window the strict resolver must never see (P0-5).
    wg.registerSessionOwner(sessionId, { kind: 'workgroup', workgroupId: room.id, botId, name: member.name })
    room.sessions[member.id] = sessionId
    delete room.seen[member.id]
    // COPY OF THE ORIGINAL order: model, then permission, then save, then capabilities.
    const ref = await rt.desiredModel(bot ?? { name: member.name })
    if (ref !== undefined) {
      await rt.selectSessionModel(sessionId, splitRef(ref))
        .catch(error => rt.warn('ds-bot: model for %s in %s not applied: %s', member.name, room.name, error))
    }
    // The room record adapted to the one field `applyPermission` reads (`permission`), so
    // this domain keeps its own record shape and the original keeps its own signature.
    await rt.applyPermission(bot ?? { id: botId }, sessionId, { permission: room.permission })
      .catch(error => rt.warn('ds-bot: permission for %s in %s not applied: %s', member.name, room.name, error))
    await wg.save()
    await rt.ensureCapabilities(sessionId)
    // `ownChatBrief` reads the member's Bot id, which a Workgroup member record carries.
    return { id: sessionId, brief: await rt.ownChatBrief(bot ?? { id: botId, name: member.name }) }
  }
  wg.sessionFor = sessionFor

  // Deliver a member's turn into its own workgroup Session. `wg.deliver` is the one
  // seam the remote bridge replaces in G4; it is a separate function so the
  // original rt.deliver (already wrapped by ../../host/resume.js) is never touched.
  async function deliver({ sessionId, text, exchangeId, role = 'room', roomId, note, taskId, senderName = 'You', files }) {
    const agent = await rt.resolveAgent(sessionId)
    if (agent === undefined) throw new Error(`ds-bot: no Session ${sessionId} for this workgroup`)
    const message = createUserMessage({
      // A file posted in the group travels with the line it belongs to, as a file block
      // DSH turns into a read-only path the member's tools can read.
      content: [{ type: 'text', text }, ...(files ?? []).map(attachment => ({ type: 'file', attachment }))],
      // `role` is a PARAMETER because the original's is (src/host/delivery.js:48 takes `role`), and
      // this copy had it hard-coded to 'room'. That made the seam usable for exactly one kind of
      // message: a group round. A delegated task is the same delivery with `role: 'task'`, and the
      // workgroup turn machinery already ignores any role other than room/post/kickoff, so a task
      // Session's line starts no round (groups.js:1462, :1931, :2063).
      source: {
        kind: WG_SOURCE_KIND,
        form: 'relay',
        role,
        exchangeId,
        ...(roomId === undefined ? {} : { roomId }),
        ...(note === undefined ? {} : { note }),
        ...(taskId === undefined ? {} : { taskId }),
        senderName,
      },
    })
    if (typeof agent.followup === 'function') agent.followup(message)
    else await ctx.sessionController.prompt({ sessionId, mode: 'queue', content: message.content, source: message.source })
    await ctx.sessions?.flush?.(agent.session)
    return exchangeId
  }
  wg.deliver = deliver

  // COPY OF THE ORIGINAL (`postToRoom`, src/host/groups.js:687): a member's message is
  // delivered into the GROUP'S OWN Session, so the group conversation is where it is
  // read. Without this the group's Session held only the user's own messages, and the
  // replies stayed in the domain's log — the chat the user entered looked empty.
  //
  // The source kind is `WG_SOURCE_KIND`, not the original's `'bot'`, so the original
  // turns/handoff listeners never treat it as theirs (P0-3). `senderSessionId` is the
  // member's Bot id — the same id the client keeps in `members` — because that is what
  // the chat looks up to draw the avatar and the name.
  async function postToGroupSession(room, member, text, extra = {}) {
    if (text === '') return
    // COPY OF THE ORIGINAL (`postToRoom`, src/host/groups.js:696-719): while a round runs, the
    // post goes into the group's log and that round's replies at once, so it is not held back
    // until the round ends; the relay it still opens does not write it again (`extra.logged`).
    //
    // This was missing, and it is why a member's late result never appeared. A member that
    // outlived its slot ends its turn after the round let go of it, so there was no round to
    // add a reply to — and nothing else in this domain writes the log. The line reached the
    // group's Session (the relay path) but not the log the chat draws from, so the group looked
    // as if the member never finished. A local group never had this problem: `postToRoom`
    // always wrote the log line for a post.
    // A LINE THAT CROSSED THE HUB IS ALREADY IN THE LOG.
    //
    // `receiveRemote` appended it before calling here, so entering the round bookkeeping below would
    // append it a second time (and mirror it back to the Hub, around the loop). `remote` is that
    // fact, and it short-circuits every local-write step while keeping the Session write.
    const fromHub = extra.remote === true
    let logged
    const running = fromHub ? undefined : [...wg.roomProgress.values()].find(round => round.roomId === room.id)
    // A result that came back after the round let go of its member (`extra.late`) has no round
    // to join, and in a workgroup nothing else is guaranteed to run afterwards: the relay only
    // fires when the user or a member posts. The original leaves such a line to the next relay;
    // here it would sit invisible until the user happened to speak, which is exactly what "it
    // stopped responding" looked like. So a late line is written straight into the log.
    if (running === undefined && extra.late === true && text !== '') {
      appendLine(room, { who: member.name, memberId: member.id, text })
      mirrorLine(room, room.log.at(-1))
      await wg.save().catch(() => {})
      logged = room.seq
    }
    if (running !== undefined) {
      if (extra.failed !== undefined) {
        // A failed model call is an event of the round only: no log line, as the relay does it.
        const { code, status, message } = extra.failed
        running.failed.push(member.name)
        running.replies.push({ kind: 'failed', botId: member.id, name: member.name, code, ...(status ? { status } : {}), text: message, time: Date.now() })
        logged = true
      } else if (extra.resumed === true || extra.stopped === true || extra.done === true) {
        const kind = extra.done === true ? 'done' : extra.stopped === true ? 'stopped' : extra.again === true ? 'cut' : 'resumed'
        appendLine(room, { who: member.name, memberId: member.id, kind, text: '' })
        running.replies.push({ kind, botId: member.id, name: member.name, time: Date.now() })
        logged = room.seq
      } else {
        appendLine(room, { who: member.name, memberId: member.id, text })
        mirrorLine(room, room.log.at(-1))
        running.replies.push({ botId: member.id, name: member.name, text, time: Date.now() })
        logged = room.seq
      }
      await wg.save().catch(() => {})
    }
    const agent = await rt.resolveAgent(room.id)
    if (agent === undefined) return
    const message = createUserMessage({
      content: [{ type: 'text', text: `[Workgroup post from ${member.name}]\n${text}` }],
      // `role` comes from the caller when it says so: a line that crossed the Hub is `remote`, which
      // the relay hook must not read as a cue (see `receiveRemote`). Everything else is a `post`.
      source: { kind: WG_SOURCE_KIND, form: 'relay', ...extra, role: extra.role ?? 'post', exchangeId: randomUUID(), senderName: member.name, senderSessionId: member.id, roomId: room.id, ...(logged !== undefined || fromHub ? { logged: true } : {}) },
    })
    if (typeof agent.followup === 'function') agent.followup(message)
    else await ctx.sessionController.prompt({ sessionId: room.id, mode: 'queue', content: message.content, source: message.source })
    await ctx.sessions?.flush?.(agent.session)
  }
  wg.postToGroupSession = postToGroupSession

  // Calls this machine has already run a turn for, so a Hub replay of the same call does not
  // produce a second turn. Bounded the way `stoppedExchanges` is: a call older than this is far
  // outside any replay window the Hub keeps.
  const calledEvents = new Set()
  const CALLED_KEPT = 200

  // A CALL FROM ANOTHER MACHINE'S ROUND: one of THIS machine's Bots was asked to answer.
  //
  // This is the missing half of cross-user conversation. `deliverRemote` used to post
  // "「Name」, you were called in this round" up to the Hub as an ordinary `chat.message` — and
  // nothing anywhere turned it into a turn. On the called member's machine it landed in
  // `receiveRemote`, which deliberately keeps Hub lines OUT of the group's Session (so a second
  // machine does not answer the same conversation twice), and that is right for a line somebody
  // SAID and wrong for an instruction. So the colleague's butler Bot received an "@" and never ran.
  // A local group never had this problem: the round calls every member's Session itself.
  //
  // The split is by AUTHORSHIP, which is the rule the rest of this file already follows: a line a
  // member said is the Hub's copy of something this machine cannot re-derive, and a call is not
  // something anybody said — it is this machine's own turn to run, addressed to this machine.
  //
  // Only the machine that owns the endpoint answers. Every member of the group receives the same
  // event, so the guard is what keeps a call with `endpointId: ep_bob` from being run by Alice as
  // well; `endpointBots` is this machine's own publish map, and a Bot missing from it is not ours.
  async function receiveCall({ room, call, event }) {
    const endpointId = typeof call?.endpointId === 'string' ? call.endpointId : undefined
    if (endpointId === undefined) return false
    const localBotId = wg.bridge?.endpointBots?.()?.[endpointId] ?? wg.state?.endpointBots?.[endpointId]
    // Not ours, or no longer a Bot of this team: either way this machine has no turn to run.
    if (localBotId === undefined || rt.botOf(localBotId) === undefined) return false
    const member = (room.members ?? []).find(other => other.id === localBotId || other.botId === localBotId)
    // The roster has not caught up (a Bot just added, or a signal from before the sync): a turn for
    // a member this room does not list would post under a name nobody can @, so it waits for the
    // roster instead. The next call arrives once `applyRoster` has run.
    if (member === undefined) return false
    // A replay of a call already answered must not run a second turn for it.
    if (event?.eventId !== undefined && calledEvents.has(event.eventId)) return false
    if (event?.eventId !== undefined) {
      if (calledEvents.size >= CALLED_KEPT) calledEvents.delete(calledEvents.values().next().value)
      calledEvents.add(event.eventId)
    }
    // THE TURN RUNS OFF THE HUB'S PATH. `receiveRemote` is awaited by the bridge's pull, which holds
    // the group's cursor until it returns; waiting here for a model turn would stop this machine
    // from receiving anything else in the group for as long as the called Bot works. The round the
    // caller is running does not wait for it either — a remote member's answer arrives later, as an
    // ordinary line, exactly as it does for a local member that outlived its slot.
    void runCall(room, member, call).catch(error => rt.warn('ds-bot: called Bot %s in "%s" failed: %s', member.name, room.name, error?.message ?? error))
    return true
  }
  wg.receiveCall = receiveCall

  // The turn itself, for one Bot called from another machine's round.
  async function runCall(room, member, call) {
    // The same Session a local round would use, so the member's memory of this group is the one it
    // already has rather than a fresh one per call.
    const session = await sessionFor(room, member)
    if (session === undefined) return
    await loadLines(room)
    // The prompt is assembled here rather than taken from the caller, because only this machine
    // knows the member's Session, its `seen` cursor and the group's log. It is the same shape a
    // local member's round prompt has: who else is in the group, what was said since it last
    // spoke, and what it was called for.
    const note = typeof call?.note === 'string' && call.note !== '' ? call.note : `you were called in this round of "${room.name}"`
    const from = typeof call?.fromName === 'string' && call.fromName !== '' ? call.fromName : undefined
    const round = { roomId: room.id, members: room.members, startSeq: room.seq + 1, slots: [], replies: [], passed: [], failed: [], started: [], speaking: null, turns: 0 }
    // Registered while it runs, so 「停止」 stops this turn too — on the machine whose Bot is
    // actually working, which is the only machine where stopping it means anything.
    const callId = `call-${randomUUID()}`
    // `roomTurn` keeps a reply timer alive until its signal aborts or the turn answers. A call has
    // no outer round signal, so it needs its own: keeping the controller (rather than passing
    // `new AbortController().signal` inline) is what lets `stopRound` end this work and release the
    // timer when the group is stopped or its runtime is disposed.
    const controller = new AbortController()
    round.signal = controller.signal
    round.abort = () => controller.abort()
    wg.roomProgress.set(callId, round)
    try {
      const lines = unseenLines(room, member.id)
      const peers = (room.members ?? []).filter(other => other.id !== member.id && other.kind !== 'user').map(other => other.name)
      const text = [
        `Members: the user${peers.length ? `, ${peers.join(', ')}` : ''} and you.`,
        room.notice ? `Group notice (shared instructions for every member):\n${room.notice}` : '',
        lines.length ? `Since your last message in the group (oldest first):\n${transcript(lines, memberText(room))}` : '',
        from === undefined ? `You were called: ${note}` : `${from} called you: ${note}`,
        ROOM_REPLY,
      ].filter(Boolean).join('\n\n')
      // `role: 'room'` is what `turn/end` reads to route the result: the answer is posted with
      // `postInRound`, which mirrors it to the Hub, and the caller's machine draws it through the
      // ordinary `receiveRemote` path. That is the whole return journey.
      // USE THE CALLER'S EXCHANGE, NOT A FRESH ONE.
      //
      // `roomTurn` normally mints an exchange id because a local round owns both ends of it. Here
      // the other end is on another machine, and the caller's round is waiting for that exact id.
      // A fresh id would make the answer an unrelated post: the caller could not match it to the
      // slot that asked, so `openingSpeakers` would choose from a new opener and the workgroup's
      // order would drift from the original group's.
      const exchangeId = typeof call?.exchangeId === 'string' && call.exchangeId !== ''
        ? call.exchangeId
        : undefined
      const reply = await roomTurn(
        room, member, session.id, { text, files: [] }, note, controller.signal, round, undefined, [], exchangeId,
      )
      if (typeof reply === 'string' && !isPass(reply) && reply.trim() !== '') {
        postInRound(room, round, member, reply.trim(), { exchangeId })
      }
    } finally {
      wg.roomProgress.delete(callId)
      await wg.save().catch(() => {})
    }
  }
  wg.runCall = runCall

  // A message that came from another device, in through the bridge (host/bridge.js).
  //
  // Three things happen, in the order the local path does them:
  //   1. the line joins this group's log, attributed to the member the Hub named;
  //   2. it is posted into the group's own Session, so the group chat shows it where the user
  //      is reading (`postToGroupSession`, the same call a local member's line makes);
  //   3. the group is saved.
  //
  // The sender is never resolved to a local Bot: a remote line is another person's, and
  // `senderSessionId` is left to the member id the Hub assigned so the avatar and the name
  // are the ones the member list already shows.
  async function receiveRemote({ workgroupId, event, mine = false, reconcile = false }) {
    await wg.load()
    const room = roomOfHubGroup(workgroupId) ?? wg.workgroupOf(workgroupId)
    if (room === undefined) return false
    // Durability of the dedup: the bridge's in-memory set of seen ids dies with the process, but the
    // log's own `hubEventId` does not. A replay after a restart therefore lands on a room that
    // already has this event and is refused here, which is what makes "at least once" invisible.
    if (event?.eventId !== undefined && (room.log ?? []).some(line => line.hubEventId === event.eventId)) return false
    const payload = event?.payload ?? {}
    // A CALL, NOT A LINE. Another machine's round called one of THIS machine's Bots: the message
    // carries `call` and no text, and it never becomes a log line — it becomes that Bot's turn.
    if (payload.call !== undefined) return receiveCall({ room, call: payload.call, event })
    const text = typeof payload.text === 'string' ? payload.text : ''
    const files = Array.isArray(payload.attachments) ? payload.attachments : []
    if (text === '' && files.length === 0) return false

    // Who said it. The Hub's sender is a Hub user; the member list carries the same id on the
    // member record, so the name in the log is the one the group already shows.
    const senderId = event?.sender?.userId
    const senderEndpointId = event?.sender?.botEndpointId
    // A BOT'S LINE. A Bot speaks through a device its owner signed in on, so the Hub records the
    // person as the sender and the endpoint as `botEndpointId`. Attributing by user alone drew the
    // colleague's butler Bot's answers under the colleague's own name — the group showed one
    // participant where there were two, and calling the Bot by @ in that name reached nobody.
    const member = senderEndpointId === undefined
      ? (room.members ?? []).find(other => other.hubUserId === senderId || other.id === senderId)
      : (room.members ?? []).find(other => other.endpointId === senderEndpointId)
    // A Hub endpoint may speak as itself; the payload's own name is the next best answer because the
    // sender published it. "A member" is the last resort, and it is a bug when it shows: the roster
    // sync (`applyRoster`) is what normally prevents it.
    // A LINE WITH AN ENDPOINT IS A BOT, EVEN IF THE ROSTER HAS NOT CAUGHT UP.
    //
    // Falling back to the sender's account id made the line's author a person: the UI then drew the
    // owner's row (and, for an unresolved person, a masked phone) and `@` resolved to an account
    // that runs no turn. The wire already says which Bot spoke; keep that endpoint as the member id
    // and use the published Bot name, so the only unknown is the name, never the kind.
    const fromBot = senderEndpointId !== undefined || member?.kind === 'remoteBot'
    const name = fromBot
      ? member?.name ?? payload.senderName ?? payload.endpointName ?? senderEndpointId ?? 'Bot'
      : member?.name ?? payload.senderName ?? payload.endpointName ?? 'A member'
    const memberId = member?.id ?? (fromBot ? (senderEndpointId ?? senderId ?? 'remote') : senderId ?? 'remote')
    const displayText = files.length === 0
      ? text
      : text === ''
        ? `[${files.map(file => file.name).join(', ')}]`
        : `${text}
[${files.map(file => file.name).join(', ')}]`

    appendLine(room, {
      who: name,
      memberId,
      text: displayText,
      // Marked so the UI and a later phase can tell a line that crossed the Hub from one this
      // machine produced. It is a display fact, not a permission.
      via: 'hub',
      hubEventId: event.eventId,
      hubSeq: event.seq,
      // The files travel with the line so a reader can fetch them later. Only the metadata the Hub
      // handed out — an id, a name, a size, a mime, a hash — never a location.
      ...(files.length === 0 ? {} : {
        attachments: files.map(file => ({
          attachmentId: file.attachmentId,
          name: file.name,
          mime: file.mime,
          size: file.size,
          sha256: file.sha256,
        })),
      }),
      // Which round exchange this line answers, when it crossed the Hub as a remote member's
      // reply. The caller uses it to close the exact slot that called this Bot.
      ...(typeof payload.exchangeId !== 'string' || payload.exchangeId === ''
        ? {}
        : { exchangeId: payload.exchangeId }),
    })
    // A line from ANOTHER machine stays out of the group's own Session, and that is deliberate.
    //
    // `postToGroupSession` writes a `role: 'post'` workgroup message, which the relay hook consumes
    // to start a round — that is exactly right for a LOCAL member, whose words this machine's model
    // produced. For a line that already came from another machine over the Hub it would start a
    // second round here, which is the same conversation answered twice by two machines. The log is
    // the record; the round is what turns a message into work, and only the machine the message was
    // sent from should start one.
    //
    // BUT THIS MACHINE'S OWN LINE MUST START ONE — `mine`. A workgroup's composer sends through the
    // Hub (`send-hub`), and the Hub does not echo an event back to the device that sent it, so the
    // sender's line comes back through `apply` on its ack. Keeping it out of the group's Session, as
    // the rule above says for foreign lines, therefore meant that a message typed into a workgroup
    // started NO round at all: nothing was ever asked to answer — the state the user described as
    // 「后加入的 Bot 还是不会回应和执行，历史 @ 也不行，原版群聊却可以」. The original local group works
    // precisely because its composer prompts the group's own Session directly (`postToSession`), with
    // no Hub in between; for a Hub group this is that same prompt, one ack later.
    // A RECONCILED LINE IS HISTORY, NOT A NEW CONTRIBUTION.
    //
    // The answer is already in the Hub log; replaying it must not enqueue a relay turn on this
    // machine. The ordinary remote-Bot branch does exactly that (`role: 'post', member: true`) and
    // can open a second round if the group Session is idle. Reconciliation suppresses that branch
    // entirely; the log line and the slot close are the whole effect it may have.
    if (mine === true && senderEndpointId === undefined && reconcile !== true) {
      // Attributed to the user and queued through the same door the local composer uses, so the
      // round this starts is the one `openingSpeakers` already knows how to pick members for.
      await wg.postToSession?.(room, text, {
        ...(files.length === 0 ? {} : { files }),
        logged: room.seq,
      })
    } else if (reconcile !== true) {
      // ANY OTHER CROSS-MACHINE LINE IS SHOWN, NOT RE-PLAYED.
      //
      // The conversation the user opens is the group's own Session, not this domain's log, so a
      // line from another machine must be written there to be readable. A PERSON runs no turn, and
      // a MATCHED Bot answer is already being continued by the caller's `runRound`; posting either
      // as a `post` cue would ask the relay to open a second round for the same words. An ordinary
      // Bot post with no waiter keeps `post` + `member: true`, which is the original member-opener
      // rule that lets its `@Name` call the next speaker.
      const closesSlot = fromBot
        && typeof payload.exchangeId === 'string' && payload.exchangeId !== ''
        && [...wg.roomProgress.values()].some(round => round.roomId === room.id
          && round.remoteWaiters?.has(payload.exchangeId))
      const displayOnly = !fromBot || closesSlot
      if (displayOnly) {
        await postToGroupSession(room, { id: memberId, name }, displayText, {
          remote: true,
          form: 'remote',
          role: 'remote',
          ...(files.length === 0 ? {} : { files }),
        }).catch(error => rt.warn('ds-bot: line from %s not shown in %s: %s', name, room.name, error?.message ?? error))
      } else {
        await postToGroupSession(room, { id: memberId, name }, displayText, {
          remote: true,
          form: 'remote',
          role: 'post',
          // A member's post only calls the members it NAMES. Without this flag `openingSpeakers`
          // reads the opener as the user speaking and `admin` mode asks the admin for a line that
          // merely answered somebody else — the duplicate/hand-off drift the original never has.
          member: true,
          ...(files.length === 0 ? {} : { files }),
        }).catch(error => rt.warn('ds-bot: line from %s not shown in %s: %s', name, room.name, error?.message ?? error))
      }
    }
    // A REMOTE ANSWER CLOSES THE SLOT THAT CALLED IT.
    //
    // `runRound` registered a waiter under the exchange it put in the call. The line just entered
    // the log with the same exchange, so this is where the caller's loop learns the answer without a
    // second opener and without polling the Hub. A mismatched/absent exchange is an ordinary line
    // and changes no round; a replay is already refused by `hubEventId` above.
    if (typeof payload.exchangeId === 'string' && payload.exchangeId !== '') {
      for (const round of wg.roomProgress.values()) {
        if (round.roomId !== room.id) continue
        const waiter = round.remoteWaiters?.get(payload.exchangeId)
        if (waiter === undefined || waiter.memberId !== memberId) continue
        round.replies.push({ botId: memberId, name, text, time: Date.now() })
        // The answer is now on disk in the log above; the projection must say the same thing. A
        // restart between this line and the loop's next `persist` would otherwise recover the slot as
        // still waiting even though its answer has already arrived.
        waiter.slot.status = 'posted'
        wg.persistRound(round)
        waiter.resolve({ text })
        break
      }
    }
    // A RECOVERED OBLIGATION IS CLOSED BY THE ORDINARY ANSWER PATH.
    //
    // After a restart there is no live `remoteWaiters`, but the persisted record may still say this
    // exact exchange is remote. The line above is the authority; mark that slot posted here so a
    // later reconciler does not re-deliver the same answer. Only an open record is touched: a stopped
    // one stays terminal.
    if (reconcile !== true && typeof payload.exchangeId === 'string' && payload.exchangeId !== '') {
      for (const record of Object.values(wg.state.rounds ?? {})) {
        if (record.roomId !== room.id || record.state !== 'open') continue
        const slot = (record.slots ?? []).find(entry => entry.exchangeId === payload.exchangeId)
        if (slot === undefined || slot.status !== 'remote') continue
        slot.status = 'posted'
        wg.persistRound(record)
      }
    }
    // Name the group in the save notification so an open window can re-read just this room. The
    // line may have arrived while the panel was idle; this is what turns the Hub event into a UI
    // refresh without waiting for the 700 ms poll.
    await wg.save({ workgroupId, roomId: room.id, kind: 'message' })
    return true
  }
  wg.receiveRemote = receiveRemote

  // THE USER'S OWN MESSAGE INTO A WORKGROUP, the original way.
  //
  // A local group's composer does not queue anything: it prompts the group's own Session
  // with an ordinary user message (`actions.send(room.id, text)`), and that Session's
  // relay answers it. The same happens here, so the message is both visible in the group
  // chat and handed to the relay. The `user/message` listener queues it for the round.
  async function postToSession(room, text, extra = {}) {
    const agent = await rt.resolveAgent(room.id)
    if (agent === undefined) throw new Error('ds-bot: this workgroup has no Session to post into')
    const message = createUserMessage({
      // A file or a picture the user attaches travels with the message, exactly as the
      // original composer sends it: DSH keeps them on the user/message event, where this
      // domain's own listener queues them for the round.
      content: [
        { type: 'text', text },
        ...(extra.files ?? []).map(attachment => ({ type: 'file', attachment })),
        ...(extra.images ?? []).map(attachment => ({ type: 'image', attachment })),
      ],
      source: {
        kind: 'user',
        ...(extra.logged === undefined ? {} : { logged: extra.logged }),
      },
    })
    if (typeof agent.followup === 'function') agent.followup(message)
    else await ctx.sessionController.prompt({ sessionId: room.id, mode: 'queue', content: message.content, source: message.source })
    await ctx.sessions?.flush?.(agent.session)
  }
  wg.postToSession = postToSession

  // COPY OF THE ORIGINAL (`greetRoom`, src/host/groups.js:812): a group the user just made
  // opens with its admin asking what the group is for. Without it a new workgroup's chat
  // is a blank page, and the relay stream has nothing to relay — the user's "进不去".
  //
  // The kickoff is a `role: 'kickoff'` post into the group's own Session, which the
  // `llm/stream` hook then turns into a relay. The source kind is this domain's own, so
  // the original's listeners never see it (P0-3).
  async function greetWorkgroup(roomId) {
    const room = wg.workgroupOf(roomId)
    if (room === undefined || (room.adminId ?? null) === null) return
    // A group is greeted ONCE. The Hub's roster arrives after the room is made, so the first
    // greetable moment is not the create — see `greetOnce` and its caller in `applyRoster`. The
    // marker is persisted so a restart does not greet the same group again.
    if (room.greeted === true) return
    room.greeted = true
    await wg.save().catch(() => {})
    const agent = await rt.resolveAgent(room.id)
    if (agent === undefined) return
    const message = createUserMessage({
      content: [{ type: 'text', text: '[Workgroup created]' }],
      source: { kind: WG_SOURCE_KIND, form: 'relay', role: 'kickoff', exchangeId: randomUUID(), senderName: 'You', roomId: room.id },
    })
    if (typeof agent.followup === 'function') agent.followup(message)
    else await ctx.sessionController.prompt({ sessionId: room.id, mode: 'queue', content: message.content, source: message.source })
    await ctx.sessions?.flush?.(agent.session)
  }
  wg.greetWorkgroup = greetWorkgroup

  // The instruction the group's own Session runs on, copied from the original's
  // `promptFor` room branch (src/host/prompt.js:52-61). A group Session is only the
  // relay: it never answers as itself, it hands each new message to the round tool.
  //
  // This was the other missing piece: a workgroup Session had no identity section at
  // all, so the model answered in its own voice instead of relaying.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'workgroup-relay',
    order: 641,
    interpolate: false,
    text: (context) => {
      const owner = wg.sessionOwners.get(context?.agent?.id)
      // `kind` is 'workgroup' for a member's Session too, so it only says "this domain";
      // `isGroupSession` is what says "the group's own relay Session" (see its note).
      if (owner === undefined) return ''
      if (isGroupSession(owner) && owner.workgroupId === context?.agent?.id) {
        return [
          '# Workgroup relay',
          'This conversation is a workgroup between the user and several Bots. You are only the relay, not a participant.',
          `For every new user message: call ${WG_TOOLS.relay} exactly once with no arguments, then end your turn with an empty reply. Never add your own text.`,
        ].join('\n')
      }
      // A MEMBER's Session in a group is that Bot's own turn, so it carries the member's
      // identity — exactly as the original renders a group member Session with the
      // member's own prompt and tools (`room.sessions[botId]` uses the same system
      // prompt as the Bot's chat). Only the GROUP's own Session is the relay.
      //
      // Without this the member was told "# Workgroup relay … Never add your own text."
      // and dutifully answered with an empty message: every round ended with nothing
      // posted, which is the reported "没有初始化、@Bot 和对话都没回复".
      //
      // G2 note — WHY THE HEADER IS NO LONGER WRITTEN HERE. `src/host/prompt.js` builds
      // "# Your identity" from `rt.selfOf`, and G2 extended `selfOf` so a workgroup member
      // resolves to its Bot (the capability mount and the permission propagation both need
      // that). `prompt.js` therefore renders the member's identity now, and this section
      // writing a second one gave the model the same opening line TWICE, in two blocks
      // that described the conversation differently. A local group's member gets exactly
      // one, and so must this domain's (test/workgroup-prompt.test.js pins it).
      //
      // So this section now contributes only what `prompt.js` cannot know: that the turn
      // is happening in a workgroup. The identity itself is left to the one module that
      // owns it — with the one exception below, for a Bot that no longer exists.
      if (owner.botId !== undefined) {
        const bot = rt.botOf?.(owner.botId)
        if (bot !== undefined) {
          // Told what a group is, never told to stay silent. The round prompt that
          // accompanies the message already says "Reply [PASS] to stay silent".
          return [
            'You are answering in a workgroup: the user and several Bots talk there, one at a time.',
            'Answer with your message for the group.',
          ].join('\n')
        }
        // A member whose Bot was DELETED gets a usable identity line rather than an empty
        // prompt: `prompt.js` renders nothing without a Bot, and an empty prompt means the
        // Session answers with nothing, which is indistinguishable from the group being
        // broken. This is the only path on which this section writes the header.
        const name = owner.name
        if (name === undefined || name === '') return ''
        return [
          '# Your identity',
          `You are ${name}, a Bot on the user's team in DS Bot.`,
          '',
          'You are answering in a workgroup: the user and several Bots talk there, one at a time.',
          'Answer with your message for the group.',
        ].join('\n')
      }
      return ''
    },
  }), 'ds-bot: workgroup relay section')

  // COPY OF THE ORIGINAL (`roomPrompt`, src/host/groups.js:219). The original's prompt is
  // what makes a round legible to a member: who else is in it, who spoke before, where in
  // the speaking order it is, and what to do with "@Name". The earlier version kept only
  // three of those lines and dropped the kickoff text entirely, so the very first round
  // showed a member "User: " with nothing after it and every member answered nothing,
  // which is exactly the reported "没有初始化".
  //
  // Lines from before the round's opening message are kept apart from this round, so an
  // earlier round never reads as part of the current one.
  function roomPrompt(room, member, round) {
    const peers = room.members.filter(other => other.id !== member.id).map(other => `${other.name}${other.id === room.adminId ? ' (admin)' : ''}`)
    const leads = room.adminId !== undefined && room.adminId !== null && room.adminId === member.id
    const lines = unseenLines(room, member.id)
    const earlier = lines.filter(line => line.seq < round.startSeq).slice(-WG_DELTA_MAX)
    const current = lines.filter(line => line.seq >= round.startSeq)
    const spokeThisRound = (room.seen[member.id] ?? 0) >= round.startSeq
    const index = round.slots.findIndex(slot => slot.status === 'speaking')
    const before = index
    const after = round.slots.length - index - 1
    const members = `Members: the user${peers.length ? `, ${peers.join(', ')}` : ''} and you${leads ? ' (admin)' : ''}. Members speak one at a time; each message is posted before the next speaker starts. ${ROOM_CALLS}`
    const notice = room.notice ? `Group notice (shared instructions for every member):\n${room.notice}` : ''
    if (round.kickoff) {
      return { text: [members, notice, leads ? adminNote(room) : '', roomKickoff(rt.uiLanguage?.())].filter(Boolean).join('\n\n'), files: [] }
    }
    const text = [
      members,
      notice,
      leads ? adminNote(room) : '',
      earlier.length ? `Earlier in the group, before this round (context only):\n${transcript(earlier, memberText(room))}` : '',
      current.length
        ? `This round so far${spokeThisRound ? ', since your last message' : ', starting with the new message'} (oldest first):\n${transcript(current, memberText(room))}`
        : 'Nothing new in this round since your last message.',
      // COPY OF THE ORIGINAL (`groups.js:242`): a member that has not been shown the
      // conversations the user referenced gets them, once.
      round.shown?.includes(member.id) ? '' : referenceNote(round.references),
      // COPY OF THE ORIGINAL: a member still busy from an earlier call says so, so the
      // others know why its words have not arrived yet.
      workingIn(room).filter(item => item.member.id !== member.id).length > 0
        ? `Still at work on what they were asked; each posts here when done: ${workingIn(room).filter(item => item.member.id !== member.id).map(item => `${item.member.name} (${minutesSince(item.since)} min)`).join(', ')}.`
        : '',
      index === -1 ? '' : `Speaking order for this round: ${round.slots.map(slotLabel).join(' -> ')}.`,
      index === -1 ? '' : `You are number ${index + 1} of ${round.slots.length}. ${before === 0 ? 'Nobody spoke before you' : `${before} went before you`}${after === 0 ? ', and you are the last.' : `; ${after} after you will see your message.`}`,
      ROOM_REPLY,
    ].filter(Boolean).join('\n\n')
    // A file stays with its line and reaches each member the line is shown to
    // (COPY OF THE ORIGINAL, src/host/groups.js:248).
    return { text, files: [...earlier, ...current].flatMap(line => line.files ?? []) }
  }

  // A tool call some models write into their text instead of making it. Copied from
  // `../../host/turns.js` rather than imported: importing that module would pull the whole
  // original delivery stack into this domain, which is exactly the coupling the domain
  // split exists to prevent (and it fails: it is not on this domain's import path).
  const stripWrittenCalls = text => text
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
    .replace(/<function=[\w.-]+>[\s\S]*?(?:<\/function>|$)/g, '')
    .trim()

  // What each member Session is doing right now: the turn it runs, since when, and the
  // newest call of that turn. Process-local, rebuilt from events, never saved — the same
  // thing the original keeps in `rt.live`.
  //
  // It has to be this domain's OWN map. The original's `live` never holds a workgroup
  // member: its listener drops every Session that is neither a Bot's own chat nor a local
  // group's (`!rt.isBotSession(id) && !rt.roomOf(id)`, src/host/turns.js:352), and a
  // workgroup member Session is neither. Putting them into `rt.groupOwners` instead would
  // make the original group modules act on this domain's turns — the cross-domain claim
  // P0-3 forbids. Reading `rt.live` from here therefore always found nothing, which is why
  // a member at work showed neither in the round's typing line nor in the activity capsule,
  // and why the round never saw a member as still busy with earlier work.
  const live = new Map()
  wg.live = live
  const liveOf = (sessionId) => {
    let entry = live.get(sessionId)
    if (entry === undefined) live.set(sessionId, entry = {})
    return entry
  }
  // What a running turn's newest call does, worded the way the original words it
  // (COPY OF `doingOf`, src/host/turns.js:266), so the client's activity capsule reads the
  // same for a workgroup member as for a Bot in a local group.
  const doingOf = (entry) => {
    if (entry.tool === undefined) return {}
    const said = entry.step?.replace(/\s+/g, ' ').trim().slice(0, 160)
    let args
    try { args = JSON.parse(entry.args || '{}') } catch { args = {} }
    const first = keys => keys.map(key => args?.[key]).find(value => typeof value === 'string' && value.trim() !== '')?.replace(/\s+/g, ' ').trim()
    const note = first(['description', 'justification'])
    const path = first(['file_path', 'path'])
    const url = first(['url'])
    let site
    try { site = url && new URL(url).host } catch { site = undefined }
    const target = path?.split(/[\\/]/).filter(Boolean).at(-1) ?? first(['query', 'pattern']) ?? site
    return { tool: entry.tool, ...(said ? { said } : {}), ...(note ? { note: note.slice(0, 120) } : {}), ...(target ? { target: target.slice(0, 80) } : {}) }
  }
  // What the members of one workgroup are doing, keyed by Bot id — the shape the client's
  // member capsule reads (`work.rooms[roomId]`), and a copy of the original `roomWorkView`.
  wg.roomWorkView = (roomId) => {
    const room = wg.workgroupOf(roomId)
    if (room === undefined) return []
    const speaking = room === undefined ? undefined : [...wg.roomProgress.values()].find(round => round.roomId === roomId)?.speaking ?? null
    return (room.members ?? []).flatMap((member) => {
      const sessionId = room.sessions?.[member.id]
      const entry = sessionId === undefined ? undefined : live.get(sessionId)
      if (entry?.turn === undefined) return []
      const doing = doingOf(entry)
      return [{ botId: member.botId ?? member.id, since: entry.since ?? Date.now(), ...doing, ...(speaking === member.id ? { speaking: true } : {}) }]
    })
  }
  // Every member at work in any workgroup, keyed by Bot id — the shape a Bot's own chat
  // reads (`work.bots[botId]`), and a copy of the original `workView`.
  wg.workView = () => {
    const bots = {}
    for (const [sessionId, entry] of live) {
      if (entry.turn === undefined) continue
      const owner = wg.sessionOwners.get(sessionId)
      if (owner?.botId === undefined) continue
      const botId = owner.botId
      if (bots[botId] !== undefined) continue
      bots[botId] = { since: entry.since, ...doingOf(entry), roomId: owner.workgroupId }
    }
    return bots
  }
  // The members of this group whose turn is running, and since when.
  const workingIn = room => (room.members ?? []).flatMap((member) => {
    const sessionId = room.sessions?.[member.id]
    const entry = sessionId === undefined ? undefined : live.get(sessionId)
    return entry?.turn !== undefined ? [{ member, since: entry.since ?? Date.now() }] : []
  })
  const minutesSince = at => Math.max(1, Math.round((Date.now() - at) / 60000))

  // Exchanges the user stopped. A late reply for one of these is dropped instead of
  // landing in the log (the original's stoppedRoomTurns rule). Declared before the round
  // functions so the loop and both stop paths can consult it.
  const stoppedExchanges = new Set()
  const STOPPED_KEPT = 200

  // A member's message in the round: in the log, for the members after it, and in the
  // round's replies, for the user. COPY OF THE ORIGINAL (`postInRound`).
  const postInRound = (room, round, member, text, extra = {}) => {
    const line = {
      who: member.name,
      memberId: member.id,
      text,
      // Set only for the answer to a call from another machine. A local turn's exchange never
      // leaves this process, so it has no use for the field; a remote answer needs it to be
      // matched to the caller's open slot after the Hub round trip.
      ...(extra.exchangeId === undefined ? {} : { exchangeId: String(extra.exchangeId) }),
    }
    appendLine(room, line)
    // A member's answer is the conversation, so it belongs on the Hub (see `mirrorLine`). Without
    // this a group's Bot replies lived on one machine only, and a colleague's copy of the group was
    // silent.
    mirrorLine(room, room.log.at(-1) ?? line)
    round.replies.push({ botId: member.id, name: member.name, text, time: Date.now() })
    void wg.save().catch(() => {})
  }

  // COPY OF THE ORIGINAL (`roomTurn`, src/host/groups.js:274). One member turn inside the
  // round; resolves to its final text, `{ failure }` when its model call failed, `{ missed }`
  // when it went quiet for too long, `{ approval }` when it waits for the user's approval,
  // `{ working }` when it goes on working without the round, or null when stopped.
  //
  // The wait restarts on each event of the member's Session (`touch`), so a member at work
  // is never cut off; `say` posts what it writes before its last step into the log while
  // the round is still on it. What the original keeps in `rt.roomWaiters` is kept here in
  // `wg.roomWaiters` (P0-8), and `wg.deliver` is the domain's own delivery seam.
  async function roomTurn(room, member, sessionId, { text, files }, note, signal, round, by, said = [], requestedExchangeId = undefined) {
    if (signal.aborted) return null
    // A called member reuses the caller's exchange so its answer can be matched to the slot that
    // asked. A local turn has no caller across the Hub and mints its own, exactly as before.
    const exchangeId = typeof requestedExchangeId === 'string' && requestedExchangeId !== ''
      ? requestedExchangeId
      : randomUUID()
    const turn = { botId: member.id, sessionId, exchangeId }
    const { started } = round
    started.push(turn)
    room.seen[member.id] = room.seq
    // Checked before the delivery, which may start the turn at once.
    // Checked before the delivery, which may start the turn at once. The original reads
    // `rt.live`; a workgroup member Session is never in that map (see `live` above), so it
    // is this domain's own record that answers.
    const busy = live.get(sessionId)?.turn !== undefined
    // COPY OF THE ORIGINAL (`claimTrigger`, src/host/turns.js:232): the member's running turn
    // remembers what started it. The original learns this from the `user/message` event of the
    // delivered message; this domain cannot rely on that, because the record must also exist for
    // a turn that ends after the round let go of it — the late-reply path reads `info.role` to
    // decide how the turn's result is routed, and an absent `info` silently dropped it.
    liveOf(sessionId).info = {
      kind: WG_SOURCE_KIND, form: 'relay', role: 'room',
      exchangeId, senderName: 'You', roomId: room.id,
      ...(by === undefined ? {} : { askedBy: by }),
    }
    const done = new Promise((resolve) => {
      let timer
      let grace
      const finish = (value) => {
        clearTimeout(timer)
        clearTimeout(grace)
        wg.roomWaiters.delete(exchangeId)
        resolve(value)
      }
      const touch = () => {
        clearTimeout(timer)
        timer = setTimeout(() => finish({ missed: true }), WG_REPLY_TIMEOUT_MS)
        timer.unref?.()
      }
      const work = () => { grace ??= setTimeout(() => finish({ working: true }), WG_WORK_GRACE_MS); grace.unref?.() }
      const say = (raw) => {
        const step = stripOwnName(member.name, raw)
        if (isPass(step)) return
        said.push(step)
        postInRound(room, round, member, step)
      }
      touch()
      wg.roomWaiters.set(exchangeId, { sessionId, memberId: member.id, roomId: room.id, resolve: finish, fail: failure => finish({ failure }), touch, work, say, approval: () => finish({ approval: true }) })
      signal.addEventListener('abort', () => finish(null), { once: true })
    })
    try {
      await deliver({ sessionId, text, exchangeId, roomId: room.id, note, files, ...(by === undefined ? {} : { askedBy: by }) })
      // Still at earlier work: the call waits in its inbox and is answered after that.
      if (busy) wg.roomWaiters.get(exchangeId)?.resolve({ working: true })
    } catch (error) {
      rt.warn('ds-bot: workgroup delivery to %s failed: %s', member.name, error)
      // A delivery that failed is not a pass: the round shows it. Nothing here can repair
      // a lost Session, so the member's next turn in this group starts a new one.
      const lost = error?.code === 'session/not-found' || /\bis corrupt\b|\bcorrupt session log\b/i.test(String(error?.message ?? ''))
      if (lost && room.sessions?.[member.id] === sessionId) {
        delete room.sessions[member.id]
        wg.releaseSessionOwner?.(sessionId)
        void wg.save().catch(() => {})
      }
      wg.roomWaiters.get(exchangeId)?.fail({ code: lost ? 'SESSION_RESET' : 'SESSION', message: String(error?.message ?? error).slice(0, 300) })
    }
    const reply = await done
    // A turn that ended leaves nothing for a stop to cancel.
    if (typeof reply === 'string' || reply?.failure !== undefined) started.splice(started.indexOf(turn), 1)
    if (reply === null || typeof reply === 'object') return reply
    return stripOwnName(member.name, String(reply ?? '').trim())
  }

  // COPY OF THE ORIGINAL (`waitersOf` / `touchRoomTurn` / `failRoomTurn` / `workRoomTurn`).
  // The original keys these on `rt.groupOwners`; this domain's equivalent index is
  // `wg.sessionOwners`, so a local group's turn can never touch a workgroup waiter.
  const waitersOf = sessionId => [...wg.roomWaiters.values()].filter(waiter => waiter.sessionId === sessionId)
  wg.touchRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.touch() }
  wg.failRoomTurn = (sessionId, failure) => {
    const waiters = waitersOf(sessionId)
    for (const waiter of waiters) waiter.fail(failure)
    return waiters.length > 0
  }
  wg.yieldRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.approval() }
  // The team's own tools are quick; any other tool is the start of work.
  //
  // COPY OF THE ORIGINAL, INCLUDING WHAT GOES IN THE SET. `TEAM_TOOLS` lists the ORIGINAL's group
  // tools — `group_relay`, `post_to_group`, `read_group_chat`, `read_own_chat` — and a workgroup
  // registers none of them; it registers `WG_TOOLS`. Testing `TEAM_TOOLS` alone therefore
  // classified every one of THIS domain's group tools as "the start of work": a member that opened
  // the round with `workgroup_relay`, read the group with `read_workgroup_chat`, or handed work on
  // with `workgroup_post` counted as still busy, so the round stopped waiting for its answer and
  // posted whatever it had. A local group's same three calls are quick and the member keeps its
  // slot. That difference is what the user described as 「工作群 bot 的工具使用没有原版全」.
  const QUICK_TOOLS = new Set([...TEAM_TOOLS, ...Object.values(WG_TOOLS)])
  wg.workRoomTurn = (sessionId, tool) => {
    if (QUICK_TOOLS.has(tool)) return
    for (const waiter of waitersOf(sessionId)) waiter.work()
  }

  // COPY OF THE ORIGINAL (`callMembers`, src/host/groups.js:355). A called member moves up
  // if it is still waiting, or gets one more turn if it already spoke; either way it goes
  // right after slot `index`. `cap` is the caller's per-member turn bound.
  function callMembers(round, turns, index, callees, note, cap, by) {
    let next = index + 1
    for (const peer of callees) {
      if ((turns.get(peer.id) ?? 0) >= cap) continue
      const waiting = round.slots.findIndex((other, at) => at > index && other.id === peer.id && other.status === 'waiting')
      const called = waiting === -1 ? { id: peer.id, name: peer.name, status: 'waiting' } : round.slots.splice(waiting, 1)[0]
      called.note = note
      if (by === undefined) delete called.by
      else called.by = by
      round.slots.splice(next, 0, called)
      next += 1
    }
  }

  // COPY OF THE ORIGINAL (`openingSpeakers`, src/host/groups.js:670). A member that posts
  // never answers its own post. @mentions choose the speakers; else the admin answers alone
  // in admin mode, or first of everyone.
  function openingSpeakers(room, opener) {
    const everyone = room.members ?? []
    // A person is IN the group but never ANSWERS it. This machine cannot run a turn for somebody
    // else's account, so a `usr_…` member handed to the round becomes a `deliverRemote` post —
    // "you were called" — sent up to the Hub, where nobody is listening.
    //
    // The original never had this shape: every member of a local group was a Bot, so `everyone`
    // was answerable by construction. This is the one thing the copy must ADD rather than inherit.
    // @mentions are still parsed against the full list, so naming a person is consumed as a
    // mention rather than leaking into the text — it simply cannot make them a speaker.
    const answerable = everyone.filter(member => member.kind !== 'user')
    const members = answerable.filter(member => member.id !== opener.botId)
    const admin = members.find(member => member.id === room.adminId)
    if (opener.kickoff) return admin ? [admin] : []
    if (opener.quiet) return []
    if (opener.done) return members.filter(member => member.id === opener.askedBy)
    const { all, found: named } = mentionsIn(opener.text ?? '', everyone)
    const found = named.filter(member => member.kind !== 'user' && member.id !== opener.botId)
    if (opener.progress) return found
    if (opener.late) return found.length > 0 ? found : members.filter(member => member.id === opener.askedBy)
    // COPY OF THE ORIGINAL (`src/host/groups.js:685`): a MEMBER's post only calls the members it
    // names. Without this, an @-less Bot reply was indistinguishable from the user speaking, and
    // `admin` mode answered every hand-off with another admin turn.
    if (opener.member) return found
    if (found.length > 0 && !all) return found
    if (!all && room.mode === 'admin' && admin) return [admin]
    return admin ? [admin, ...members.filter(member => member !== admin)] : members
  }
  wg.openingSpeakers = openingSpeakers

  // COPY OF THE ORIGINAL (`drainRoomInbox`, src/host/groups.js:390): a message the user
  // sends while a round is running joins that round, and the members it names answer it
  // before the round ends. Without this the message opened a second round only after the
  // first ended, and the group looked like it had stopped answering.
  // COPY OF THE ORIGINAL (`waitingLines`, src/host/groups.js:373). Messages the user sent
  // while this round is running. The original reads the Session's own inbox and removes
  // each message from it; here the queue is this domain's `wg.roomInbox`, which is the
  // same thing for this domain — a kickoff is a cue, never a line, and a member's own post
  // is not the user speaking.
  const waitingLines = roomId => (wg.roomInbox.get(roomId) ?? [])
    .filter(item => item.kickoff !== true && item.botId === undefined && String(item.text ?? '') !== '')
    .map(item => ({ id: item.id ?? item.text, text: String(item.text ?? '') }))

  function drainRoomInbox(room, round, turns, index) {
    // The greeting's prompt tells the admin the user has not written yet.
    if (round.kickoff) return 0
    const lines = waitingLines(room.id)
    if (lines.length === 0) return 0
    wg.roomInbox.delete(room.id)
    const before = round.slots.length
    for (const line of lines) {
      appendLine(room, { who: 'User', text: line.text })
      round.replies.push({ kind: 'user', text: line.text, time: Date.now() })
      // The members the message's own round would open with answer it next, inside this
      // round, and the note says whether the user named them.
      const { all, found } = mentionsIn(line.text, room.members ?? [])
      const note = all || found.length > 0 ? 'the user mentioned you' : 'new message from the user'
      callMembers(round, turns, index - 1, openingSpeakers(room, { text: line.text }), note, WG_ADMIN_TURNS_EACH)
    }
    // The user spoke in this room, so late results may call members again.
    room.lateRounds = 0
    void wg.save().catch(() => {})
    return round.slots.length - before
  }

  // ── the coordinator lease (plan §9.5) ───────────────────────────────────────────
  //
  // V1 allows ONE scheduler per Hub group. This is where that becomes true rather than aspirational:
  // an automatic round asks for the lease first, and a group whose lease is held elsewhere does not
  // start one. Human chat is untouched — `send-hub` never consults the lease — which is what §9.5
  // means by "其离线时普通真人聊天继续，自动 Bot 轮次暂停".
  //
  // Two outcomes are not failures:
  //   * a local group has no Hub, so there is nothing to coordinate;
  //   * the socket is down, so the Hub cannot be asked. The round proceeds, because a team with no
  //     Hub must behave exactly as it did before G5 (gate N2's neighbour: "local still works").
  async function holdLeaseFor(room) {
    const workgroupId = room.hubWorkgroupId
    if (workgroupId === undefined) return { held: true, local: true }
    if (wg.bridge?.status?.().connected !== true) return { held: true, offline: true }
    try {
      const answer = await wg.bridge.acquireLease({ workgroupId }).catch(error => ({ error }))
      if (answer?.error !== undefined) {
        // Held by somebody else: this machine must not run a second round. The person is told, once,
        // through the round's own reporting rather than a toast they cannot act on.
        const message = answer.error?.message ?? String(answer.error)
        rt.warn('ds-bot: no workgroup round in %s: %s', room.name, message)
        appendLine(room, { who: 'System', kind: 'failed', text: message })
        await wg.save().catch(() => {})
        return { held: false, reason: message }
      }
      return { held: true, lease: answer?.lease }
    } catch (error) {
      // A refusal the bridge itself produced (no account, say) is not a reason to stop a local round.
      rt.warn('ds-bot: the lease for %s was not acquired: %s', room.name, error?.message ?? error)
      return { held: true, degraded: true }
    }
  }

  // Released when the round ends, so the next round does not wait for an expiry. Best effort: a
  // failed release only costs the group one lease duration.
  async function releaseLeaseFor(room) {
    const workgroupId = room.hubWorkgroupId
    if (workgroupId === undefined) return
    if (wg.bridge?.status?.().connected !== true) return
    await wg.bridge.releaseLease({ workgroupId })
  }

  // COPY OF THE ORIGINAL (`runRound`, src/host/groups.js:410): the turn loop with its own
  // budget, the per-member call cap, and the "@Name" expansion after each member speaks.
  // The earlier version walked `round.slots` once, so a member could never be called again
  // inside a round, and a message typed during a round was handled out of order.
  async function runRound(room, round, signal) {
    // The projection is updated at the points where the round's OBLIGATION changes: a member starts
    // working, a remote call is sent, an answer arrives, or a slot ends. A terminal round is removed
    // instead, because nothing remains to recover.
    const persist = () => wg.persistRound(round)
    let limit = round.slots.length + WG_EXTRA_TURNS + (room.adminId !== undefined && room.adminId !== null ? WG_ADMIN_EXTRA_TURNS : 0)
    const turns = new Map()
    // COPY OF THE ORIGINAL (`groups.js:415`): the inbox half of the condition keeps a
    // message the user typed during the LAST speaker's turn inside this round. Without it
    // the loop ended with the slots, and that message opened a second round instead.
    for (let index = 0;
      (index < round.slots.length || waitingLines(room.id).length > 0) && (round.turns ?? 0) < limit;
      index += 1) {
      if (signal.aborted) break
      limit += drainRoomInbox(room, round, turns, index)
      if (index >= round.slots.length) break
      const slot = round.slots[index]
      const member = (room.members ?? []).find(other => other.id === slot.id)
      // Settings may change mid-round, for example when the admin removes someone.
      if (member === undefined) {
        slot.status = 'left'
        persist()
        continue
      }
      slot.status = 'speaking'
      round.speaking = member.id
      round.turns = (round.turns ?? 0) + 1
      turns.set(member.id, (turns.get(member.id) ?? 0) + 1)
      persist()
      // A remote member is a person (or a Bot) on another device. Their turn is not a model
      // call this machine can make: it is a message on the Hub, and the answer — if any —
      // arrives later as an event. The round therefore does not wait for it, exactly as it
      // does not wait for a member who went quiet.
      //
      // Without the bridge (signed out), the member is reported as skipped rather than as a
      // failed Bot: nothing is broken, the Hub is simply not there.
      if (member.kind !== 'localBot') {
        // ONE EXCHANGE, ONE SLOT.
        //
        // The caller cannot await a model turn that runs on another machine. It can, however, wait
        // for a signal from the Hub: the called machine answers under this exchange, and the bridge
        // hands the line to `receiveRemote`. Registering the waiter BEFORE the call closes the race
        // where a fast answer arrives before the round knows what it is waiting for.
        const exchangeId = randomUUID()
        const remoteReply = new Promise((resolve) => {
          round.remoteWaiters ??= new Map()
          const timer = setTimeout(() => resolve({ missed: true }), WG_REPLY_TIMEOUT_MS)
          timer.unref?.()
          round.remoteWaiters.set(exchangeId, {
            memberId: member.id,
            slot,
            resolve: (value) => { clearTimeout(timer); resolve(value) },
            // Stopping the round has to release this wait, not leave it to the 240 s timer: a
            // called Bot on another machine may never answer after the user pressed Stop.
            cancel: () => { clearTimeout(timer); resolve(null) },
          })
        })
        // WRITE THE EXCHANGE BEFORE THE HUB SEND.
        //
        // `deliverRemote` returns only after the bridge has put the call in its outbox or the Hub
        // has acknowledged it. If the state file is written after that await, a process death in
        // between leaves a call on the Hub whose exchange is nowhere on this machine: the answer can
        // never be matched, which is the exact loss this projection exists to prevent. The slot is
        // durably 'remote' with its exchange first; the send may then fail, and the failure path
        // overwrites that record with 'failed'.
        slot.status = 'remote'
        slot.exchangeId = exchangeId
        persist()
        if (typeof wg.flushSave === 'function') await wg.flushSave()
        const delivered = await Promise.resolve()
          .then(() => wg.deliverRemote?.({ room, member, round, slot: { ...slot, exchangeId, roundId: round.id } }))
          .catch(error => ({ error }))
        if (delivered?.error !== undefined) {
          round.remoteWaiters?.get(exchangeId)?.resolve(null)
          rt.warn('ds-bot: workgroup line for remote member %s not sent: %s', member.name, delivered.error?.message ?? delivered.error)
          slot.status = 'failed'
          round.failed.push(member.name)
          round.replies.push({
            kind: 'failed', botId: member.id, name: member.name, code: 'HUB',
            text: String(delivered.error?.message ?? delivered.error).slice(0, 300), time: Date.now(),
          })
          round.speaking = null
          persist()
          continue
        }
        if (delivered?.skipped !== undefined) {
          round.remoteWaiters?.get(exchangeId)?.resolve(null)
          // A member that cannot be called (a person, or an endpoint-less row) is not a silent
          // "missed": the round records why it did not run, so the user can fix the membership.
          slot.status = 'failed'
          round.failed.push(member.name)
          round.replies.push({
            kind: 'failed', botId: member.id, name: member.name, code: 'HUB',
            text: `This member cannot be called (${delivered.skipped}).`,
            time: Date.now(),
          })
          round.speaking = null
          persist()
          continue
        }
        const answered = await remoteReply
        round.remoteWaiters?.delete(exchangeId)
        round.speaking = null
        if (round.state === 'stopped') {
          // Stop won the race with an in-flight answer. The words may still be in `receiveRemote`'s
          // log (the Hub is the record), but this round must not continue or rewrite its stopped
          // slots.
          continue
        }
        if (answered === null || answered?.missed === true || answered === undefined) {
          slot.status = 'missed'
          round.passed.push(member.name)
          if (answered?.missed === true) round.replies.push({ kind: 'missed', botId: member.id, name: member.name, time: Date.now() })
          persist()
          continue
        }
        // A member's answer calls only the members it NAMES, exactly as the local `runRound`
        // continuation below does. The exchange has already put the words in the log and the
        // round's replies; this adds the next slot rather than opening a second round.
        slot.status = 'posted'
        persist()
        const spoken = answered.text
        const leads = room.adminId !== undefined && room.adminId !== null && room.adminId === member.id
        const everyone = room.members ?? []
        const others = everyone.filter(other => other.id !== member.id)
        const { all, found: named } = mentionsIn(spoken, everyone)
        const found = named.filter(other => other.id !== member.id)
        const callees = leads && all ? [...found, ...others.filter(other => !found.includes(other))] : found
        callMembers(round, turns, index, callees, `${member.name} mentioned you`, leads ? WG_ADMIN_TURNS_EACH : WG_TURNS_EACH, member.id)
        continue
      }
      let session
      try {
        session = await sessionFor(room, member)
      } catch (error) {
        rt.warn('ds-bot: workgroup Session for %s in %s failed: %s', member.name, room.name, error)
        round.speaking = null
        slot.status = 'failed'
        round.failed.push(member.name)
        round.replies.push({ kind: 'failed', botId: member.id, name: member.name, code: 'SESSION', text: String(error?.message ?? error).slice(0, 300), time: Date.now() })
        persist()
        continue
      }
      if (session === undefined) {
        round.speaking = null
        slot.status = 'left'
        persist()
        continue
      }
      if (round.state === 'stopped') continue
      const sessionId = session.id
      await loadLines(room)
      const prompt = roomPrompt(room, member, round)
      // COPY OF THE ORIGINAL (`groups.js:449`): a new member Session opens with a brief of
      // the Bot's own chat, so it knows what the user and this Bot have been doing. Only a
      // Session made by this very turn has one; every later turn has `brief: undefined`.
      const text = session.brief === undefined ? prompt.text : `${session.brief}\n\n${prompt.text}`
      const said = []
      const reply = await roomTurn(room, member, sessionId, { text, files: prompt.files }, slot.note ?? 'your turn', signal, round, slot.by, said)
      round.speaking = null
      if (round.state === 'stopped') continue
      const final = typeof reply === 'string' && !isPass(reply) ? reply : undefined
      if (reply?.failure !== undefined) {
        // Not a pass: the user sees why the member is silent, and the round goes on.
        slot.status = 'failed'
        round.failed.push(member.name)
        const { code, status, message } = reply.failure
        round.replies.push({ kind: 'failed', botId: member.id, name: member.name, code, ...(status ? { status } : {}), text: message, time: Date.now() })
      } else if (reply?.approval) {
        // The member's turn goes on in the background and posts when it ends.
        slot.status = 'waiting-approval'
        round.replies.push({ kind: 'approval', botId: member.id, name: member.name, time: Date.now() })
      } else if (reply?.working) {
        slot.status = 'working'
        round.replies.push({ kind: 'working', botId: member.id, name: member.name, time: Date.now() })
      } else if (final !== undefined || (typeof reply === 'string' && said.length > 0)) {
        slot.status = 'posted'
        if (final !== undefined) postInRound(room, round, member, final)
      } else {
        slot.status = typeof reply === 'string' ? 'passed' : 'missed'
        round.passed.push(member.name)
        if (reply?.missed) round.replies.push({ kind: 'missed', botId: member.id, name: member.name, time: Date.now() })
      }
      persist()
      const spoken = final === undefined ? said : [...said, final]
      if (spoken.length === 0) continue
      // Only the admin's "@all" calls everyone, so a member cannot set off a storm.
      const leads = room.adminId !== undefined && room.adminId !== null && room.adminId === member.id
      const everyone = room.members ?? []
      const others = everyone.filter(other => other.id !== member.id)
      const { all, found: named } = mentionsIn(spoken.join('\n\n'), everyone)
      const found = named.filter(other => other.id !== member.id)
      const callees = leads && all ? [...found, ...others.filter(other => !found.includes(other))] : found
      callMembers(round, turns, index, callees, `${member.name} mentioned you`, leads ? WG_ADMIN_TURNS_EACH : WG_TURNS_EACH, member.id)
      persist()
    }
    // THE LOOP EITHER FINISHED THE ROUND OR LEFT A DURABLE OBLIGATION.
    //
    // Every slot that can still produce words later keeps the round open: a remote answer, a local
    // turn that is still speaking, a member working past the round, or one waiting for approval.
    // `waiting` is included too: the loop may have stopped on its turn budget before reaching it.
    // Anything else is finished, and a finished round is removed rather than left as terminal junk.
    if (round.state !== 'stopped') {
      const pending = (round.slots ?? []).some(slot => ['remote', 'speaking', 'working', 'waiting-approval', 'waiting'].includes(slot.status))
      round.state = pending ? 'open' : 'closed'
    }
    if (round.state === 'open') {
      wg.persistRound(round)
    } else if (round.state === 'stopped') {
      // TERMINAL BUT KEPT: a persisted stop is what tells reconciliation and a late answer that
      // this exchange will never continue. Dropping it here was the race that erased the user's stop.
      wg.persistRound(round)
    } else {
      wg.dropRound(round.id)
    }
    await wg.save()
  }
  wg.runRound = runRound

  // COPY OF THE ORIGINAL (`postStep`, src/host/groups.js:731): what a member says while it
  // works, posted into the group. While the member holds its place in a round it joins
  // that round; later it joins whatever round runs, or posts on its own. Only the members
  // it calls with @ answer it, and not past the late-round limit.
  const memberIn = (sessionId, info) => {
    const owner = wg.sessionOwners.get(sessionId)
    const room = wg.workgroupOf(owner?.workgroupId ?? info?.roomId)
    const member = (room?.members ?? []).find(other => other.id === owner?.botId)
    return room !== undefined && member !== undefined ? { room, member } : {}
  }
  const callsIn = (room, member, text) => mentionsIn(text, (room.members ?? [])).found.some(other => other.id !== member?.id)

  async function postStep(sessionId, info, text) {
    const waiter = info?.role === 'room' ? wg.roomWaiters.get(info.exchangeId) : undefined
    if (waiter !== undefined) return waiter.say(text)
    const { room, member } = memberIn(sessionId, info)
    if (room === undefined) return
    const calls = callsIn(room, member, text)
    const running = [...wg.roomProgress.values()].find(round => round.roomId === room.id)
    if (!calls && running !== undefined) return postInRound(room, running, member, text)
    const quiet = !calls || (room.lateRounds ?? 0) >= WG_LATE_ROUNDS
    if (!quiet) room.lateRounds = (room.lateRounds ?? 0) + 1
    await wg.save()
    await postToGroupSession(room, member, text, { progress: true, ...(quiet ? { quiet: true } : {}) })
  }
  wg.postStep = postStep

  // COPY OF THE ORIGINAL (`flushSteps`): lines a member writes close together reach the
  // group as one message, so a burst of steps does not come out as a string of messages.
  const held = new Map()
  ctx.effect(() => () => { for (const entry of held.values()) clearTimeout(entry.timer) }, 'ds-bot: workgroup step lines')
  const flushSteps = (sessionId) => {
    const entry = held.get(sessionId)
    if (entry === undefined) return undefined
    clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.lines.length === 0) return undefined
    entry.last = Date.now()
    return postStep(sessionId, entry.info, entry.lines.splice(0).join('\n\n'))
  }
  wg.roomStepText = async (sessionId, info, raw, first) => {
    const { room, member } = memberIn(sessionId, info)
    if (room === undefined) return
    const text = stripOwnName(member.name, raw)
    if (isPass(text)) return
    const entry = held.get(sessionId) ?? { last: 0, lines: [] }
    held.set(sessionId, entry)
    entry.info = info
    entry.lines.push(text)
    if ((first && info?.role === 'room') || callsIn(room, member, text) || Date.now() - entry.last >= WG_STEP_GAP_MS) return flushSteps(sessionId)
    entry.timer ??= setTimeout(() => void flushSteps(sessionId)?.catch(error => rt.warn('ds-bot: step lines from %s not posted: %s', member.name, error)), entry.last + WG_STEP_GAP_MS - Date.now())
  }
  wg.takeRoomSteps = (sessionId) => {
    const entry = held.get(sessionId)
    if (entry === undefined) return ''
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.last = Date.now()
    return entry.lines.splice(0).join('\n\n')
  }
  wg.withRoomSteps = (lines, reply) => (lines === '' ? reply : isPass(reply) ? lines : `${lines}\n\n${reply}`)

  // COPY OF THE ORIGINAL (`lateRoomReply`, src/host/groups.js:703): a member the round moved
  // on from posts what its turn ended with, and whoever it names answers. Past the late
  // round limit nobody does, so late posts cannot keep a group talking forever.
  async function lateRoomReply(sessionId, info, reply, { shown = false } = {}) {
    const { room, member } = memberIn(sessionId, info)
    if (room === undefined) return
    const text = stripOwnName(member.name, reply)
    const done = isPass(text) && shown && info?.askedBy !== undefined
    if (isPass(text) && !done) return
    const quiet = (room.lateRounds ?? 0) >= WG_LATE_ROUNDS
    if (!quiet) room.lateRounds = (room.lateRounds ?? 0) + 1
    await wg.save()
    await postToGroupSession(room, member, done ? '' : text, { late: true, ...(done ? { done: true } : {}), ...(info?.askedBy ? { askedBy: info.askedBy } : {}), ...(quiet ? { quiet: true } : {}) })
      .catch(error => rt.warn('ds-bot: late workgroup reply from %s failed: %s', member.name, error))
  }
  wg.lateRoomReply = lateRoomReply

  // COPY OF THE ORIGINAL (`lateRoomFailure`, src/host/groups.js:799): the round said such a
  // member posts when done; a failed model call is how it ended. Nobody answers it.
  async function lateRoomFailure(sessionId, info, failure) {
    const { room, member } = memberIn(sessionId, info)
    if (room === undefined) return
    const { code, status, message } = failure
    await postToGroupSession(room, member, `Could not finish: its model call failed (${failureLine(failure)}).`, {
      late: true, quiet: true, failed: { code, ...(status ? { status } : {}), message },
    }).catch(error => rt.warn('ds-bot: late workgroup failure from %s failed: %s', member.name, error))
  }
  wg.lateRoomFailure = lateRoomFailure

  // Stop a round: the members it started are cancelled, and what they would have said
  // stays out of the log.
  async function stopRound(roomId) {
    await wg.load()
    const rounds = [...wg.roomProgress.values()].filter(round => round.roomId === roomId)
    if (rounds.length === 0) {
      // A recovered round has no live object, but the user can still stop its obligation. Mark every
      // open record terminal so reconciliation will never continue it, and report the stop.
      let stopped = false
      for (const record of Object.values(wg.state.rounds ?? {})) {
        if (record.roomId !== roomId || record.state !== 'open') continue
        record.state = 'stopped'
        for (const slot of record.slots ?? []) {
          if (['remote', 'speaking', 'waiting', 'working', 'waiting-approval'].includes(slot.status)) slot.status = 'stopped'
        }
        wg.persistRound(record)
        stopped = true
      }
      if (stopped) {
        appendLine(wg.workgroupOf(roomId), { who: 'User', kind: 'stopped', text: '' })
        await wg.save()
      }
      return stopped
    }
    let stopped = false
    for (const round of rounds) {
      // A called Bot's turn has no outer `exec.signal`; aborting its own controller is what makes
      // `roomTurn` clear its reply timer. Without it, stopping the round left a 240 s timer keeping
      // the process alive even though no Bot was working any more.
      round.abort?.()
      // A remote member is not in `round.started` (that list is local member turns), so its waiter
      // needs its own cancellation. Without this, Stop left the round open until the reply timeout.
      for (const waiter of round.remoteWaiters?.values() ?? []) waiter.cancel?.()
      round.remoteWaiters?.clear()
      for (const started of round.started ?? []) {
        stoppedExchanges.add(started.exchangeId)
        if (stoppedExchanges.size > STOPPED_KEPT) stoppedExchanges.delete(stoppedExchanges.values().next().value)
        const waiter = wg.roomWaiters.get(started.exchangeId)
        if (waiter !== undefined) {
          wg.roomWaiters.delete(started.exchangeId)
          waiter.resolve(null)
        }
        // Cancel the member's real turn, so work actually stops (the original cancels
        // through the agent; here the same agent is reached through the one runtime).
        const agent = await rt.resolveAgent?.(started.sessionId)?.catch?.(() => undefined)
        agent?.cancel?.({ kind: 'user' })
        stopped = true
      }
      round.speaking = null
      for (const slot of round.slots) {
        if (['speaking', 'waiting', 'remote', 'working', 'waiting-approval'].includes(slot.status)) slot.status = 'stopped'
      }
      // TERMINAL, NOT DELETED. The round itself is gone with this process, but "the user stopped this
      // exchange" is a durable fact: a late answer after a restart must be logged and must not resume
      // the round.
      round.state = 'stopped'
      wg.persistRound(round)
      // The loop may still be unwinding from the waiters just resolved. Marking it stopped is what
      // makes `runRound` preserve this record instead of overwriting it with `closed`/`open`.
      stopped = true
    }
    if (stopped) appendLine(wg.workgroupOf(roomId), { who: 'User', kind: 'stopped', text: '' })
    await wg.save()
    return stopped
  }
  wg.stopRound = stopRound
  wg.wasStopped = exchangeId => stoppedExchanges.has(exchangeId)

  // RECONCILE A PROJECTION WITH THE AUTHORITY.
  //
  // A coordinator restart throws away the live round but keeps `state.rounds`. The Hub still has the
  // call and may already have the answer. This reads the open records and asks the Hub log for the
  // exchange each remote slot is waiting on. Matching answers go through the ordinary
  // `receiveRemote` seam, so they are logged once (by `hubEventId`) and the slot is marked posted.
  //
  // It deliberately does NOT re-run a member or start a relay: a recovered answer is a line, not a
  // new opener. A stopped record is terminal and is never touched. Failures are reported and do not
  // stop other rooms: a Hub that is down leaves the obligation exactly as it was.
  async function reconcileRounds(roomId) {
    await wg.load()
    const records = Object.values(wg.state.rounds ?? {})
    for (const record of records) {
      if (record.state !== 'open') continue
      const room = wg.workgroupOf(record.roomId)
      if (roomId !== undefined && record.roomId !== roomId && room?.hubWorkgroupId !== roomId) continue
      if (room === undefined) {
        // The group was deleted locally: nothing can continue this record.
        wg.dropRound(record.roundId)
        continue
      }
      // A record with a LIVE round is not recovered; its own waiter owns the close. Touching it
      // here would race the in-memory round and could move a live slot from under its waiter.
      const live = [...wg.roomProgress.values()].some(round => round.id === record.roundId)
      if (live) continue
      let changed = false
      const pending = (record.slots ?? [])
        .filter(slot => slot.status === 'remote' && typeof slot.exchangeId === 'string')
      if (pending.length === 0) continue

      // The LOCAL log is the fast path; a line that is already here closes its slot without a Hub
      // read. What remains is looked up in ONE paged Hub scan, not one scan per slot.
      const wanted = new Map(pending.map(slot => [slot.exchangeId, slot]))
      for (const slot of pending) {
        const local = (room.log ?? []).find(line => line.exchangeId === slot.exchangeId)
        if (local === undefined) continue
        slot.status = 'posted'
        wanted.delete(slot.exchangeId)
        changed = true
      }
      if (wanted.size > 0 && room.hubWorkgroupId !== undefined) {
        // Follow `hasMore`: an answer may be past the first page. Bounded by the Hub's cursor so a
        // malformed page cannot loop forever. The map makes one page serve every pending exchange.
        let afterSeq = Math.max(0, (record.startSeq ?? 1) - 1)
        let pages = 0
        const MAX_PAGES = 50
        try {
          while (wanted.size > 0 && pages < MAX_PAGES) {
            pages += 1
            const page = await wg.hub.events({ workgroupId: room.hubWorkgroupId, afterSeq })
            for (const event of page.events ?? []) {
              const slot = wanted.get(event?.payload?.exchangeId)
              if (slot === undefined) continue
              const applied = await wg.receiveRemote?.({ workgroupId: room.hubWorkgroupId, event, reconcile: true })
              if (applied !== true) continue
              slot.status = 'posted'
              wanted.delete(event.payload.exchangeId)
              changed = true
            }
            if (page.hasMore !== true) break
            const next = Number(page.nextAfterSeq)
            if (!Number.isFinite(next) || next <= afterSeq) break
            afterSeq = next
          }
        } catch (error) {
          rt.warn('ds-bot: round %s not reconciled: %s', record.roundId, error?.message ?? error)
        }
        // A slot whose exchange was already consumed by the Hub replay is closed without a second
        // write; the line carries the hubEventId and the round needs no further work.
        for (const [exchangeId, slot] of wanted) {
          if ((room.log ?? []).some(line => line.exchangeId === exchangeId)) {
            slot.status = 'posted'
            wanted.delete(exchangeId)
            changed = true
          }
        }
      }
      if (changed) wg.persistRound(record)
    }
  }
  wg.reconcileRounds = reconcileRounds

  // COPY OF THE ORIGINAL `stopMemberWork`: stop ONE member of a round. The original reads
  // `rt.live`, which holds the local domain's turns; this domain's rounds live in
  // `wg.roomProgress`, so that is what says whether this member is working now.
  //
  // A member that is not currently speaking is not an error: it is simply not working,
  // and the caller gets false, the same answer the original gives.
  async function stopMemberWork(roomId, botId) {
    await wg.load()
    const room = wg.workgroupOf(roomId)
    if (room === undefined) return false
    const member = (room.members ?? []).find(other => other.id === botId)
    if (member === undefined) return false
    const rounds = [...wg.roomProgress.values()].filter(round => round.roomId === roomId)
    // `roomWaiters` is the authoritative record of who is mid-turn: it is written before
    // the turn is delivered and removed when it answers. `round.started` is a narrower
    // subset (it is spliced out as soon as a turn ends), so the waiters are what a stop
    // must go by — otherwise a member that just started appears "not working".
    const waiting = [...wg.roomWaiters.entries()].filter(([, waiter]) => waiter.roomId === roomId && waiter.memberId === botId)
    if (waiting.length === 0) return false
    let stopped = false
    for (const [exchangeId, waiter] of waiting) {
      // Same rule as stopping a whole round: the reply that still arrives is dropped
      // instead of landing in the log (the original's stoppedRoomTurns rule).
      stoppedExchanges.add(exchangeId)
      if (stoppedExchanges.size > STOPPED_KEPT) stoppedExchanges.delete(stoppedExchanges.values().next().value)
      wg.roomWaiters.delete(exchangeId)
      waiter.resolve(null)
      const agent = await rt.resolveAgent?.(waiter.sessionId)?.catch?.(() => undefined)
      agent?.cancel?.({ kind: 'user' })
      for (const round of rounds) {
        const slot = round.slots.find(entry => entry.id === botId)
        if (slot !== undefined) slot.status = 'stopped'
        const at = (round.started ?? []).findIndex(entry => entry.exchangeId === exchangeId)
        if (at !== -1) round.started.splice(at, 1)
        wg.persistRound(round)
      }
      stopped = true
    }
    if (stopped) {
      appendLine(room, { who: member.name, memberId: member.id, kind: 'stopped', text: '' })
      await wg.save()
    }
    return stopped
  }
  wg.stopMemberWork = stopMemberWork

  // Resume: a round interrupted by a restart is reported, never silently re-run.
  // Re-running a round could repeat a side-effecting tool call, which the plan forbids
  // (方案 9.4 / 5.2 resume.js「不自动重放可能具有副作用的远程任务」). So this reports the
  // members whose work was cut rather than replaying it, and the user decides.
  async function resumeWorkgroup(roomId) {
    await wg.load()
    const room = wg.workgroupOf(roomId)
    if (room === undefined) throw new Error('Unknown workgroup')
    const interrupted = []
    for (const [memberId, sessionId] of Object.entries(room.sessions ?? {})) {
      // A Session the original can no longer open is retired, the way the original
      // does it: the member's next turn there starts a new Session.
      const owner = wg.sessionOwners.get(sessionId)
      if (owner !== undefined) interrupted.push({ memberId, sessionId })
    }
    if (interrupted.length > 0) {
      appendLine(room, { who: 'System', kind: 'resumed', text: '' })
      await wg.save()
    }
    return { interrupted, replayed: false }
  }
  wg.resumeWorkgroup = resumeWorkgroup

  // COPY OF THE ORIGINAL (`reportRound`, src/host/groups.js:824). A Bot that posted into
  // the group with report_back hears what the round ended with, and the work it handed on
  // is closed. Without it a poster never learns the outcome and a handoff chain never
  // settles.
  //
  // The report goes to the POSTER'S OWN CHAT, not into the workgroup: it is the original
  // domain's message to a Bot, so it is written the way the original writes it — the
  // original `SOURCE_KIND`, a `report` role, and a header of its own. The original
  // `rt.deliver` builds that header from `rt.roomOf(roomId)`, which knows only local
  // groups, so the header is written here instead; the delivery itself still goes through
  // the one shared `rt`.
  async function reportRound(room, post, round) {
    const replies = round.replies ?? []
    const lines = replies.filter(reply => reply.kind === undefined).map(reply => `${reply.name}: ${reply.text}`)
    const waiting = replies.filter(reply => reply.kind === 'approval').map(reply => reply.name)
    const working = replies.filter(reply => reply.kind === 'working').map(reply => reply.name)
    const text = [
      lines.length > 0 ? `Replies to your post (oldest first):\n${lines.join('\n')}` : 'Nobody replied to your post.',
      working.length > 0 ? `Still working on it: ${working.join(', ')}. Each posts its result in the group when done, not to you; ${WG_TOOLS.readChat} shows it.` : '',
      waiting.length > 0 ? `Waiting for the user's approval: ${waiting.join(', ')}. What they say afterwards is posted in the group, not sent to you; ${WG_TOOLS.readChat} shows it.` : '',
      (round.passed ?? []).length > 0 ? `Stayed silent: ${round.passed.join(', ')}.` : '',
      (round.failed ?? []).length > 0 ? `Could not answer because their model call failed: ${replies.filter(reply => reply.kind === 'failed').map(reply => `${reply.name} (${failureLine({ code: reply.code, status: reply.status, message: reply.text })})`).join(', ')}.` : '',
    ].filter(Boolean).join(BS + BS)
    // Replies the poster waited for go on with the work it posted for. The ledger is this
    // domain's own (`host/handoffs.js`): reading `rt.closeWork` here matched nothing, because
    // the original's map holds only the original domain's work — a workgroup post's `sub`
    // was never in it, so this closed nothing even once `post.sub` arrived.
    const work = post.sub === undefined ? undefined : wg.closeWork?.(post.sub, `Workgroup "${room.name}"`, text)
    if (post.botId === undefined) return
    try {
      const sessionId = rt.chatOf(post.botId)
      const agent = await rt.resolveAgent(sessionId)
      if (agent === undefined) return
      const message = createUserMessage({
        content: [{ type: 'text', text: `[Group chat "${room.name}" · replies to your post]\n${text}` }],
        source: { kind: SOURCE_KIND, form: 'relay', role: 'report', exchangeId: randomUUID(), senderName: room.name, roomId: room.id, ...(work ? { work } : {}) },
      })
      if (typeof agent.followup === 'function') agent.followup(message)
      else await ctx.sessionController.prompt({ sessionId, mode: 'queue', content: message.content, source: message.source })
      await ctx.sessions?.flush?.(agent.session)
    } catch (error) {
      rt.warn('ds-bot: workgroup report to %s failed: %s', post.name ?? 'a Bot', error)
    }
  }
  wg.reportRound = reportRound

  // COPY OF THE ORIGINAL (`group_relay`, src/host/groups.js:488), renamed to this
  // domain's tool (P0-2) and reading `wg.*` state (P0-8).
  //
  // The kickoff case is the one the earlier version got wrong: the original queues a
  // `{ kickoff: true }` item for `[Group chat created]` and then opens the round with the
  // admin and the `roomKickoff` prompt. The earlier version treated the kickoff post as an
  // ordinary empty user message, so the admin was asked to answer "User: " with no text and
  // every member correctly answered nothing.
  ctx.tools.register(defineTool({
    name: WG_TOOLS.relay,
    description: 'Workgroup relay only. Deliver the latest user message to the members of this Workgroup, one at a time, and collect their replies.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      await wg.load()
      const owner = wg.sessionOwners.get(exec.agent?.id)
      if (owner === undefined) return JSON.stringify({ error: 'Not a workgroup Session' })
      const room = wg.workgroupOf(owner.workgroupId)
      if (room === undefined) return JSON.stringify({ error: 'Unknown workgroup' })
      // Everything queued since the last relay is posted in order, so messages that the
      // Session folds into one turn are not lost; the newest one picks the speakers.
      const queued = wg.roomInbox.get(room.id) ?? []
      wg.roomInbox.delete(room.id)
      const posts = queued.length > 0 ? queued : [{ text: '' }]
      const startSeq = room.seq + 1
      // COPY OF THE ORIGINAL (`groups.js:522`): what the user referenced in this round,
      // handed to the members that have not been shown it.
      const references = posts.flatMap(post => post.references ?? [])
      // The opening greeting is a cue for the admin, not a line of the group; a member's
      // late failure, its work picked up after a restart, its work the user stopped, or the
      // end of work whose result it already posted is an event of the round.
      const event = item => item.failed || item.resumed || item.stopped || item.done
      for (const post of posts.filter(item => !item.kickoff && !event(item))) {
        // COPY OF THE ORIGINAL (`groups.js:509-517`): image readings go into the log only,
        // because members read the group as text; `@` names are still picked from what the
        // user typed. A file stays with its line and reaches each member it is shown to.
        //
        // A post that already carries a log seq was written when it was posted (a member's post
        // into a running round, or a late result that had no round to join), and the original
        // skips exactly these with the same field.
        if (post.logged !== undefined) continue
        const readings = post.images === undefined || rt.imagesForGroup === undefined
          ? []
          : await rt.imagesForGroup(post.images, room.id)
        const text = [post.text, ...readings, ...(post.files ?? []).map(fileLine)].filter(Boolean).join('\n')
        appendLine(room, {
          ...(post.botId ? { who: post.name ?? 'Bot', memberId: post.botId } : { who: 'User' }),
          text,
          ...(post.files === undefined ? {} : { files: post.files }),
        })
        // A user's line is the one kind the relay appends but no later step mirrors. A member
        // post is mirrored by `postInRound`/`postToGroupSession`; mirroring it again would
        // duplicate it.
        if (post.botId === undefined && post.hubEventId === undefined) {
          mirrorLine(room, room.log.at(-1))
        }
      }
      if (posts.some(post => !post.botId && !post.kickoff)) room.lateRounds = 0
      await wg.save()
      // An event post never picks the speakers over a message queued with it.
      const opener = posts.slice().reverse().find(post => !event(post)) ?? posts.at(-1)
      // A member a Bot's post calls by name works for that Bot.
      const named = opener.botId === undefined ? [] : mentionsIn(opener.text ?? '', room.members ?? []).found
      const round = {
        // Stable identity for the persisted obligation and the `roundId` a remote call carries on
        // the wire. The answer is matched by `exchangeId`; the round id says which obligation it
        // belongs to.
        id: `round-${randomUUID()}`,
        roomId: room.id,
        members: room.members,
        startSeq,
        ...(opener.kickoff ? { kickoff: true } : {}),
        ...(references.length > 0 ? { references } : {}),
        slots: openingSpeakers(room, opener).map(member => ({
          id: member.id,
          name: member.name,
          status: 'waiting',
          ...(opener.kickoff ? { note: 'the group was just created' } : {}),
          ...(named.includes(member) ? { by: opener.botId } : {}),
          ...(opener.done ? { note: `${opener.name ?? 'a member'} finished the work you asked for` } : {}),
        })),
        speaking: null,
        turns: 0,
        replies: [],
        passed: [],
        failed: [],
        started: [],
      }
      for (const post of posts.filter(item => item.failed)) {
        const { code, status, message } = post.failed
        round.failed.push(post.name ?? 'Bot')
        round.replies.push({ kind: 'failed', botId: post.botId, name: post.name ?? 'Bot', code, ...(status ? { status } : {}), text: message, time: Date.now() })
      }
      // The log line tells the admin and the other members on their next turn.
      for (const post of posts.filter(item => item.resumed || item.stopped || item.done)) {
        const name = post.name ?? 'Bot'
        const kind = post.done ? 'done' : post.stopped ? 'stopped' : post.again ? 'cut' : 'resumed'
        appendLine(room, { who: name, memberId: post.botId, kind, text: '' })
        round.replies.push({ kind, botId: post.botId, name, time: Date.now() })
      }
      if (posts.some(post => post.resumed || post.stopped || post.done)) await wg.save()
      wg.roomProgress.set(exec.callId, round)
      // Written BEFORE any member speaks: a remote slot is an obligation, and it must survive the
      // process that is about to wait on it.
      wg.persistRound(round)
      // THE COORDINATOR FENCE (plan §9.5).
      //
      // A Hub group may only run an automatic round while this device holds the group's lease, and
      // the round's own id is what a late report is checked against. A local group (`hubWorkgroupId`
      // undefined) is unaffected: it has no Hub, no second coordinator, and no fence to apply.
      //
      // The failure is reported rather than thrown: a round that cannot be coordinated must leave the
      // group usable for human chat, which is exactly what §9.5 asks for.
      const fencing = await holdLeaseFor(room)
      if (fencing.held === false) {
        // The projection was written before the lease because a remote call must be durable before
        // it is sent. A refused lease means this round never runs, so that projection must not
        // survive as an obligation nothing will continue.
        wg.dropRound(round.id)
        wg.roomProgress.delete(exec.callId)
        exec.concludeTurn?.()
        return
      }
      try {
        await runRound(room, round, exec.signal ?? new AbortController().signal)
        // `runRound` returns normally after either finishing or handing outstanding slots back to
        // the projection. Only a round that was not durably left open is settled here.
        if (round.state !== 'open' && wg.roundOf(round.id) !== undefined) wg.dropRound(round.id)
      } catch (error) {
        rt.warn('ds-bot: workgroup round in %s stopped: %s', room.name, error)
        // A thrown loop cannot continue its slots. Keeping the projection would create an obligation
        // no process is left to honour, which is exactly the orphan the reviewer found.
        wg.dropRound(round.id)
      } finally {
        wg.roomProgress.delete(exec.callId)
        await releaseLeaseFor(room).catch(() => {})
      }
      // COPY OF THE ORIGINAL (`groups.js:572-575`): a poster that asked to be reported to
      // gets one message when the round ends.
      await wg.save()
      for (const post of posts) {
        if (post.reportBack && (room.members ?? []).some(member => member.id === post.botId)) void reportRound(room, post, round)
      }
      exec.concludeTurn?.()
      return JSON.stringify({ replies: round.replies, passed: round.passed, ...(round.failed.length > 0 ? { failed: round.failed } : {}) })
    },
  }))

  // COPY OF THE ORIGINAL (`post_to_group`, src/host/tools.js:566). A member writes into the
  // group as itself, choosing who answers with "@Name", and optionally asks for the replies
  // to come back to it (`report_back`).
  //
  // This tool is what makes a hand-off possible at all in a workgroup. `report_back` is the
  // only thing that opens a work for a group post (`openWork(sub, …)`), and `reportRound`
  // closes it when the round ends so the poster goes on with what came back. Without a
  // workgroup counterpart the original's `post_to_group` answered "No group chat called …
  // that you can see" for a workgroup — it only knows local rooms — so a workgroup member
  // could hand work ON but never hear it back.
  //
  // The name is this domain's own (`workgroup_post`), for the same reason the relay is
  // (`P0-2`): a second registration of `post_to_group` would collide with the original's.
  ctx.tools.register(defineTool({
    name: WG_TOOLS.post,
    description: 'Post a message into a Workgroup as yourself. A member\'s post calls only the members it names with "@Name"; without one it is only written into the group. With report_back the replies also come back to you as a new message when the round ends, so you can go on with the work.',
    parameters: {
      group: { type: 'string', required: true, description: 'Exact workgroup name' },
      message: { type: 'string', required: true, description: 'What to say; write "@Name" to choose who answers, and a name without "@" to only mention a member' },
      report_back: { type: 'boolean', description: 'Also send the members\' replies back to you as a new message when the round ends' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      await wg.load()
      const owner = wg.sessionOwners.get(exec.agent?.id)
      if (owner === undefined) return 'Only members of a Workgroup can post in it.'
      const room = wg.workgroupOf(owner.workgroupId)
      if (room === undefined) return 'Unknown workgroup'
      if (args.group !== undefined && args.group !== room.name) return `You are in "${room.name}", not "${args.group}".`
      const member = (room.members ?? []).find(other => other.id === owner.botId)
      if (member === undefined) return `You are no longer in "${room.name}".`
      // A member posting while it holds the group's speaking slot should answer there.
      const info = wg.live.get(exec.agent?.id)?.info
      if (info?.role === 'room' && info.roomId === room.id) return `You are speaking in "${room.name}" right now. Write your message as your reply instead.`
      const text = String(args.message ?? '').trim()
      if (text === '') return 'Write a message to post.'
      const everyone = room.members ?? []
      const named = mentionsIn(text, everyone).found.filter(other => other.id !== member.id && other.kind !== 'user')
      const reportBack = args.report_back === true
      // COPY OF THE ORIGINAL: an ordinary member's post calls only the members it names, so
      // asking to be reported to with nobody named would wait for nobody.
      const leads = room.adminId !== undefined && room.adminId !== null && room.adminId === member.id
      if (!leads && reportBack && named.length === 0) {
        return 'Nobody would answer: your post only calls the members you name. Write "@Name" for each member who should answer, or post without report_back.'
      }
      // Replies the poster waits for, while it works on what a Bot asked it for, are work
      // handed on for that request (`handoffs.js`).
      const work = reportBack ? worksOf(exec).find(id => wg.ownsWork(owner.botId, id)) : undefined
      const sub = work === undefined ? undefined : randomUUID()
      if (sub !== undefined) wg.openWork(sub, { from: owner.botId, room: room.id, parent: work })
      try {
        await wg.postToGroupSession(room, member, text, { member: true, ...(reportBack ? { reportBack: true } : {}), ...(sub ? { sub } : {}) })
      } catch (failure) {
        if (sub !== undefined) wg.dropWork(sub)
        return `Could not post in "${room.name}": ${failure.message}`
      }
      const asker = sub === undefined ? undefined : wg.workAsker(work)?.senderSessionId
      const askerName = asker === undefined ? undefined : wg.workgroupBotOf?.(asker)?.name ?? rt.botOf(asker)?.name
      const waits = askerName ? ` End your turn when you have handed on everything: the replies bring you back to this work, and your answer goes to ${askerName} once all of it is back.` : ''
      return named.length === 0
        ? `Posted in "${room.name}", where the user and its members read it. Nobody answers it: your post only calls the members you name with @Name.`
        : `Posted in "${room.name}". Members reply there, where the user reads them${reportBack ? '; their replies also come back to you as a new message when the round ends' : ', and nothing comes back to you'}.${waits}`
    },
  }))

  // The workgroup's own viewer, same shape as the original's read_group_chat.
  ctx.tools.register(defineTool({
    name: WG_TOOLS.readChat,
    description: 'Read the latest messages of a Workgroup, including what you said there.',
    parameters: { group: { type: 'string', required: true, description: 'Exact workgroup name' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      await wg.load()
      const owner = wg.sessionOwners.get(exec.agent?.id)
      if (owner === undefined) return 'Only members of a Workgroup can read it.'
      const room = wg.workgroupOf(owner.workgroupId)
      if (room === undefined) return 'Unknown workgroup'
      if (args.group !== undefined && args.group !== room.name) return `You are in "${room.name}", not "${args.group}".`
      await loadLines(room)
      const lines = room.log.slice(-WG_READ_MAX)
      return lines.length === 0 ? `"${room.name}" has no messages yet.` : `Latest in "${room.name}" (oldest first):\n${lines.map(line => lineText(line, memberText(room)(line))).join('\n')}`
    },
  }))

  // COPY OF THE ORIGINAL (`read_own_chat`, src/host/groups.js:581). A member reads its own
  // chat with the user, and the group sees that it looked, so private context enters a
  // workgroup only visibly. The round prompt has always told a member it may call this;
  // the copy registered only two of the original's three group tools, so it was a promise
  // to a tool that did not exist.
  //
  // `rt.partsOf`, `rt.partIndex`, `rt.aroundOwnChat`, `rt.latestOwnChat`, `rt.searchOwnChat`,
  // `rt.noteText` and `rt.clock` are the original chat index (src/host/chat-index.js and
  // parts.js) hung on the one shared runtime, so this domain reads a Bot's own chat the
  // same way the original does, without importing any of the original modules.
  ctx.tools.register(defineTool({
    name: WG_TOOLS.readOwn,
    description: 'Read or search your own chat with the user, across all its parts, including earlier parts that left your working context. Each line starts with its anchor, such as [part 2 #1234 · 10-08 14:22]; long messages are cut. Pass the anchor as around to read that message in full, with what was said just before and after it. In a workgroup the group sees that you looked, so share only what the group needs.',
    parameters: {
      query: { type: 'string', description: 'Words to look for in every part, separated by spaces. A message must have all of them; when none has, those with the most are shown. Omit for the latest messages' },
      around: { type: 'string', description: 'An anchor from an earlier result, such as "part 2 #1234": shows that message in full and the messages just before and after it' },
      part: { type: 'integer', description: 'Number of an earlier part: shows the handoff note you wrote when it ended' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      await wg.load()
      const id = exec.agent?.id
      const owner = wg.sessionOwners.get(id)
      const member = owner === undefined
        ? undefined
        : (wg.workgroupOf(owner.workgroupId)?.members ?? []).find(other => other.id === owner.botId)
      if (owner === undefined || member === undefined) return 'Only members of a Workgroup can look at their own chat.'
      const room = wg.workgroupOf(owner.workgroupId)
      const query = String(args.query ?? '').trim().slice(0, 80)
      const around = String(args.around ?? '').trim().slice(0, 40)
      const parts = rt.partsOf(member.id)
      const number = Number.isInteger(args.part) ? args.part : undefined
      // The group sees that it looked, recorded where the original records it.
      const text = query !== '' ? query : around !== '' ? `around ${around}` : number !== undefined ? `part ${number}` : ''
      appendLine(room, { who: member.name, memberId: member.id, kind: 'lookup', text })
      for (const round of wg.roomProgress.values()) {
        if (round.roomId === room.id) round.replies.push({ kind: 'lookup', botId: member.id, name: member.name, text, time: Date.now() })
      }
      void wg.save().catch(() => {})
      const partsNote = parts.length > 1 ? `\n\nYour own chat has ${parts.length} parts: ${rt.partIndex(parts)}. Call ${WG_TOOLS.readOwn} with part N for the note that closed an earlier part, or with words to search all parts.` : ''
      if (query === '' && around !== '') {
        const found = await rt.aroundOwnChat(member.id, around)
        if (found.error) return `${found.error}${partsNote}`
        if (found.lines.length === 0) return `Nothing was said around ${around}.${partsNote}`
        const heading = found.exact ? `around ${around}` : `with no message at ${around}; the nearest ones`
        return `Your own chat ${heading} (oldest first):\n${found.lines.join('\n')}${partsNote}`
      }
      if (query === '' && number !== undefined) {
        const part = parts[number - 1]
        if (part === undefined) return `Your own chat has no part ${number}.${partsNote}`
        if (part.endedAt === undefined) return `Part ${number} is the current one; it is in your context.${partsNote}`
        return `Part ${number} of your own chat (${rt.clock(part.startedAt)} – ${rt.clock(part.endedAt)}). The handoff note that closed it:\n${rt.noteText(part) ?? '(none: the part ended on a context overflow)'}${partsNote}`
      }
      if (query === '') {
        const lines = await rt.latestOwnChat(member.id, { askingId: id })
        return lines.length === 0 ? `Your own chat is empty.${partsNote}` : `Your own chat (oldest first):\n${lines.join('\n')}${partsNote}`
      }
      const { lines, every } = await rt.searchOwnChat(member.id, query, { askingId: id })
      if (lines.length === 0) return `Nothing in your own chat mentions "${query}".${partsNote}`
      const heading = every ? `messages mentioning "${query}"` : `no message has all of "${query}"; messages with the most of these words`
      return `Your own chat, ${heading} (oldest first):\n${lines.join('\n')}${partsNote}`
    },
  }))


  // COPY OF THE ORIGINAL (`session/event`, src/host/turns.js:349-620), reduced to the
  // parts a workgroup round needs. It is for this domain only: it returns immediately for
  // any Session it does not own, so it can never consume an original group's turn.
  //
  // Three things here are the original's and were missing before:
  //   1. What the user types into the group's own chat is queued for the next round
  //      (`turns.js:471-482`), and a kickoff is queued as `{ kickoff: true }` — not as an
  //      empty user message, which is what made the first round in a new workgroup ask the
  //      admin to answer nothing.
  //   2. A member's Session keeps its waiter alive on every event (`touchRoomTurn`) and
  //      lets the round go on once it is really working (`workRoomTurn`), so a member doing
  //      real work is never cut off and the round never waits forever on it.
  //   3. The round's answer is what the member's TURN ends with (`turn/end`), collected
  //      from its `assistant/message` texts the way the original collects `entry.texts` —
  //      not each intermediate message, which resolved the round on the first step.
  const turnText = new Map()
  // How many of a turn's texts already went to the group as step lines.
  const turnShown = new Map()
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (sessionId === undefined) return
    const owner = wg.sessionOwners.get(sessionId)
    if (owner === undefined) return
    const queue = (item) => {
      const room = wg.workgroupOf(owner.workgroupId)
      if (room === undefined) return
      const queued = wg.roomInbox.get(room.id) ?? []
      wg.roomInbox.set(room.id, [...queued, { who: 'User', ...item }])
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      // COPY OF THE ORIGINAL (`turns.js:232`, `claimTrigger`): a member Session's running turn
      // remembers WHAT started it. `turn/end` reads it to decide how the turn's result is
      // routed — a `role: 'room'` turn belongs to a round, a `role: 'request'` turn is work
      // another Bot asked for, and `askedBy` is the member a round slot was called by. Without
      // it this map held no `info` at all, so the late-reply path had nothing to route on.
      if (owner.botId !== undefined && source?.kind === WG_SOURCE_KIND) liveOf(sessionId).info = source
      if (!isGroupSession(owner)) return
      // Only the GROUP's own Session queues; a member's Session is a Bot's own turn and
      // must never be read as a user post to the group.
      if (source?.kind === 'user' || source?.kind === 'schedule') {
        // COPY OF THE ORIGINAL (`turns.js:471-482`): the attachments the user sent travel
        // with the queued message, so the round can put them in the log and hand them to
        // each member. Images are read as text for the log; files stay as files.
        const content = Array.isArray(event.data?.content) ? event.data.content : []
        const images = content.filter(block => block?.type === 'image' && !block.offloaded).map(block => block.attachment)
        const files = content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
        queue({
          text: textOf(event.data?.content),
          ...(images.length > 0 ? { images } : {}),
          ...(files.length > 0 ? { files } : {}),
          ...(typeof source?.logged === 'number' ? { logged: source.logged } : {}),
        })
      }
      // COPY OF THE ORIGINAL (`turns.js:446`): the kickoff is a cue, never a line.
      else if (source?.kind === WG_SOURCE_KIND && source.role === 'kickoff') queue({ text: '', kickoff: true })
      // COPY OF THE ORIGINAL (`turns.js:429-457`): a member's post into the group becomes the
      // round's opener, and it carries MORE than the text — who posted it, whether the poster
      // asked to be reported back to, the work the replies belong to (`sub`), and how the post
      // came about (`late`, `progress`, `quiet`, `askedBy`, `done`).
      //
      // This branch was missing, and that is what broke a workgroup's hand-offs. A member's post
      // still reached the round (the relay hook treats `role: 'post'` as an opener), but it
      // reached it as a bare user message: `botId` was gone, so the post was attributed to the
      // user; `reportBack` was gone, so `reportRound` never ran and the poster never heard back;
      // `sub` was gone, so `post.sub` read `undefined` every time and no work was ever closed.
      // A Bot that handed work on was never brought back to it — the group went quiet after the
      // first answer.
      else if (source?.kind === WG_SOURCE_KIND && source.role === 'post') {
        // A long post comes as a file (attachLong), which stays with its line.
        const content = Array.isArray(event.data?.content) ? event.data.content : []
        const files = content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
        queue({
          text: textOf(event.data?.content).replace(/^\[Workgroup post from (?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, ''),
          ...(files.length > 0 ? { files } : {}),
          botId: source.senderSessionId,
          name: source.senderName,
          reportBack: source.reportBack === true,
          ...(source.member ? { member: true } : {}),
          ...(source.sub ? { sub: source.sub } : {}),
          ...(source.late ? { late: true } : {}),
          ...(source.progress ? { progress: true } : {}),
          ...(source.quiet ? { quiet: true } : {}),
          ...(source.failed ? { failed: source.failed } : {}),
          ...(source.resumed ? { resumed: true } : {}),
          ...(source.again ? { again: true } : {}),
          ...(source.stopped ? { stopped: true } : {}),
          ...(source.done ? { done: true } : {}),
          ...(source.askedBy ? { askedBy: source.askedBy } : {}),
          ...(source.logged !== undefined ? { logged: source.logged } : {}),
        })
      }
      return
    }
    // A member's turn: keep its waiter alive, and let the round go on when it is working.
    if (owner.botId !== undefined) wg.touchRoomTurn?.(sessionId)
    // What the member is doing, for the round's typing line and the activity capsule
    // (COPY OF the original's `session/event` bookkeeping, src/host/turns.js:349-620).
    // Only a member's own Session: the group's Session runs no model turn of its own.
    if (owner.botId !== undefined) {
      const entry = liveOf(sessionId)
      switch (event.type) {
        case 'turn/start':
          entry.turn = event.data?.turn
          entry.since = event.time ?? Date.now()
          entry.step = undefined
          entry.tool = undefined
          entry.args = undefined
          break
        case 'assistant/message': {
          const content = event.data?.message?.content
          const text = textOf(content)
          const called = Array.isArray(content) && content.some(block => block?.type === 'tool-call')
          if (text !== '') entry.step = called ? stripWrittenCalls(text) || undefined : undefined
          break
        }
        case 'tool/call':
          entry.tool = String(event.data?.name ?? '')
          entry.args = String(event.data?.arguments ?? '')
          break
        case 'tool/ptc-dispatch-start':
          entry.tool = String(event.data?.name ?? '')
          entry.args = JSON.stringify(event.data?.arguments ?? {})
          break
        case 'tool/result':
        case 'turn/end':
          entry.tool = undefined
          entry.args = undefined
          if (event.type === 'turn/end') {
            entry.turn = undefined
            if (entry.since === undefined) live.delete(sessionId)
          }
          break
        default:
      }
    }
    switch (event.type) {
      case 'turn/start':
        turnText.set(sessionId, [])
        turnShown.set(sessionId, 0)
        return
      case 'assistant/message': {
        const content = event.data?.message?.content
        const text = textOf(content)
        if (text === '') return
        const called = Array.isArray(content) && content.some(block => block?.type === 'tool-call')
        const texts = [...(turnText.get(sessionId) ?? []), text]
        turnText.set(sessionId, texts)
        // COPY OF THE ORIGINAL (`showSteps`, src/host/turns.js:174): a text with a tool call
        // goes on at once, because the member goes on working; one without may be the turn's
        // last, so it waits for the turn's end and is posted as the reply.
        const upTo = called ? texts.length : texts.length - 1
        const shown = turnShown.get(sessionId) ?? 0
        if (upTo > shown) {
          const waiter = [...wg.roomWaiters.entries()].find(([, other]) => other.sessionId === sessionId)
          for (let at = shown; at < upTo; at += 1) {
            void wg.roomStepText?.(sessionId, waiter === undefined ? undefined : { role: 'room', exchangeId: waiter[0] }, texts[at], at === shown)
              ?.catch(error => rt.warn('ds-bot: step text from %s not posted: %s', sessionId, error))
          }
          turnShown.set(sessionId, upTo)
        }
        return
      }
      case 'tool/call':
      case 'tool/ptc-dispatch-start':
        wg.workRoomTurn?.(sessionId, String(event.data?.name ?? ''))
        return
      case 'turn/end': {
        const texts = turnText.get(sessionId) ?? []
        const shown = turnShown.get(sessionId) ?? 0
        turnText.delete(sessionId)
        turnShown.delete(sessionId)
        const waiters = [...wg.roomWaiters.entries()].filter(([, waiter]) => waiter.sessionId === sessionId)
        const reason = event.data?.reason
        // COPY OF THE ORIGINAL: a failed model call is not a pass. The round shows why the
        // member is silent and goes on, instead of recording that it chose to stay quiet.
        const error = reason?.kind === 'error' ? reason.error : undefined
        const failure = error === undefined ? undefined : { code: error?.code ?? 'UNKNOWN', ...(error?.status ? { status: error.status } : {}), message: String(error?.message ?? error).slice(0, 300) }
        const reply = reason?.kind === 'aborted' ? null : texts.slice(shown).join(BS + BS).trim()
        if (waiters.length > 0) {
          for (const [exchangeId, waiter] of waiters) {
            wg.roomWaiters.delete(exchangeId)
            if (failure !== undefined) waiter.fail(failure)
            else waiter.resolve(reply)
          }
          return
        }
        // COPY OF THE ORIGINAL (`turns.js:600-620`): the round moved on without this member —
        // it went on working, went quiet, or waited for an approval — and its turn is ending
        // now. What it ends with still reaches the group, and `lateRoomReply` is what tells the
        // member that asked for it, so the chain of work closes.
        //
        // Returning early here (what this did) meant a member that outlived its slot was
        // silent forever: the round had already let go of it, so no waiter existed and nothing
        // was posted. That is one of the two ways a workgroup conversation stopped dead.
        const info = wg.live.get(sessionId)?.info
        // The trigger is read and then dropped, exactly as the original does at `turn/end`
        // (`turns.js:527`): a later turn must not inherit this one's role.
        if (wg.live.get(sessionId) !== undefined) {
          wg.live.get(sessionId).info = undefined
          if (wg.live.get(sessionId).since === undefined) wg.live.delete(sessionId)
        }
        if (info?.role !== 'room' || reason?.kind === 'aborted') return
        const said = texts.slice(shown).join(BS + BS).trim()
        const held = wg.takeRoomSteps?.(sessionId) ?? ''
        const groupReply = wg.withRoomSteps?.(held, said) ?? said
        if (failure !== undefined) void wg.lateRoomFailure?.(sessionId, info, failure)
        else void wg.lateRoomReply?.(sessionId, info, groupReply, { shown: shown > 0 })
        return
      }
      default:
    }
  })

  // COPY OF THE ORIGINAL (src/host/groups.js:843-877), and the one piece that makes a
  // workgroup chat actually work.
  //
  // A group's own Session never consults the model. Models drift from "only call
  // group_relay" — they answer in their own voice, or message one member directly — so
  // the original does not ask the model at all: it synthesizes the relay tool call right
  // here and returns it as the model's answer. The round then runs through the tool.
  //
  // Relying on a system prompt instead (what this domain did) left the group silent: when
  // the model did not call the tool, nothing ever ran, so the group chat looked empty and
  // unfinished. A prompt cannot guarantee behaviour an event hook can.
  //
  // The relay tool is this domain's own `workgroup_relay` (P0-2), and a Session's owner is
  // resolved through `wg.sessionOwners`, so an original group's turn can never be relayed
  // by this hook and vice versa (P0-3).
  const relayStream = (options, next) => {
    if (options.sessionId === undefined || options.purpose !== undefined || rt.ownRequest?.(options)) return next()
    return (async function* relayOrPass() {
      await wg.load()
      const owner = wg.sessionOwners.get(options.sessionId)
      // Only the GROUP's own Session relays. A member's Session is a Bot's real turn and
      // must reach the model: relaying it here answered the member with a synthesized
      // relay call instead of its own words, so every member turn ended with an empty
      // message and the group showed nothing.
      if (!isGroupSession(owner)) {
        yield* next()
        return
      }
      // Plugins append context as user-role messages (time, attachments), so only a
      // message from the user, a scheduled task, or a member's post after the last model
      // or tool step starts a relay.
      const opens = message => message.role === 'user'
        && (message.source?.kind === 'user' || message.source?.kind === 'schedule' || (message.source?.kind === WG_SOURCE_KIND && (message.source.role === 'post' || message.source.role === 'kickoff')))
      // A LINE FROM ANOTHER MACHINE IS HISTORY, NEVER A CUE.
      //
      // It has to be in the group's Session or this machine's chat shows nothing of what the rest of
      // the group said — that is the reported 「同事加入后，消息并没有实时更新」 when the colleague's
      // Bot answers. But it must not open a round here: the round it belongs to ran on the machine
      // that produced the line, and running a second one here is the same conversation answered
      // twice by two machines.
      //
      // `receiveRemote` therefore writes it with `role: 'remote'`, which `cells.js` draws exactly
      // like a `post` and this hook deliberately does not list as an opener.
      const latest = [...options.messages].reverse()
        .find(message => message.role === 'assistant' || message.role === 'tool' || opens(message))
      if (latest?.role !== 'user') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const id = `toolu_relay_${randomUUID().replace(/-/g, '')}`
      const declared = new Set((options.tools ?? []).map(tool => tool.name))
      // Only for a group made under the PTC preset, which can call nothing but run_code;
      // new group Sessions get the standard preset.
      const [name, args] = declared.has('run_code') && !declared.has(WG_TOOLS.relay)
        ? ['run_code', JSON.stringify({ description: 'Relay the workgroup to its members', code: `return await tools.${WG_TOOLS.relay}({})`, timeoutMs: 600_000 })]
        : [WG_TOOLS.relay, '{}']
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  }
  // Named so a test can find this hook without depending on registration order: several
  // modules legitimately register on `llm/stream`, and position is not a contract.
  relayStream.relay = WG_TOOLS.relay
  ctx.on('llm/stream', relayStream)

  // Rooms the UI and the channel expose, as a projection only.
  //
  // `linkedLocalName` answers "which local group was this upgraded from" (plan §8.2) so
  // the panel can show the provenance. It is read from the local domain through the
  // read-only `rt.roomOf` seam the upgrade handler already uses; a workgroup created
  // directly has no link and therefore no name. The link itself stays by id — the name
  // is a display snapshot, so renaming the local group never rewrites the workgroup.
  const linkedLocalNameOf = (workgroupId) => {
    for (const [localRoomId, link] of Object.entries(wg.state?.links ?? {})) {
      if (link?.workgroupId !== workgroupId) continue
      const name = rt.roomOf?.(localRoomId)?.name
      if (typeof name === 'string' && name !== '') return name
    }
    return null
  }

  wg.view = () => Object.values(wg.state?.workgroups ?? {}).map(({ log, seen, sessions, segments, ...room }) => {
    const last = log?.at(-1)
    return {
      ...room,
      members: room.members ?? [],
      ...(last ? { preview: last.who === 'User' ? last.text : `${last.who}：${last.text}` } : {}),
      linkedLocalName: linkedLocalNameOf(room.id),
    }
  })
}
