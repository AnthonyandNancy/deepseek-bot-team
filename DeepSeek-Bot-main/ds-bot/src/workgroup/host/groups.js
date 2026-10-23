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
        await wg.save()
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
  async function applyRoster({ hubWorkgroupId, members: hubMembers }) {
    if (hubWorkgroupId === undefined) return undefined
    await wg.load()
    const room = roomOfHubGroup(hubWorkgroupId)
    if (room === undefined) return undefined
    const roster = Array.isArray(hubMembers) ? hubMembers : undefined
    if (roster === undefined) return room

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
    // The Main Bot, exactly as the original picks it. A member this machine cannot match to a Bot
    // has no `botId`, so it can never be mistaken for one.
    const mainBot = answerable.find(member => member.botId !== undefined && rt.isMain?.(member.botId) === true)
    const owner = roster.find(member => member.role === 'owner')
    // The owner's own Bot leads when they published one. Matched on `endpointId`, NOT on `id`: a
    // local member's `id` is now the Bot's own id, so comparing it to the Hub's `ep_…` could never
    // hold and the owner's Bot never led.
    const ownerMember = owner === undefined || owner.memberType !== 'botEndpoint'
      ? undefined
      : answerable.find(member => member.endpointId === owner.endpointId)
    // The owner's Bot first, then the Main Bot, then the first answerable member so a group with no
    // Main Bot still has somebody asked first, then whoever led before rather than dropping to
    // nobody on a bad sync.
    const adminId = ownerMember?.id ?? mainBot?.id ?? answerable[0]?.id ?? (room.adminId ?? null)

    const same = (room.members ?? []).length === next.length
      && (room.members ?? []).every((member, index) => member.id === next[index]?.id
        && member.name === next[index]?.name
        && member.kind === next[index]?.kind)
      && room.adminId === adminId
    // Written only when it changed: every event would otherwise touch state.json, and a group with
    // traffic would rewrite the file on each message.
    if (same) return room
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
    await wg.save()
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
    return applyRoster({ hubWorkgroupId, members: answer.members })
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
  async function updateWorkgroup(roomId, patch = {}, actorId) {
    await wg.load()
    const room = wg.workgroupOf(roomId)
    if (room === undefined) throw new Error('Unknown workgroup')
    // Only the user (actorId undefined) or the group's admin may change it, the same
    // rule the original applies to a local group.
    if (actorId !== undefined && room.adminId !== actorId) {
      throw new Error(`Only the user or the admin of "${room.name}" can change it`)
    }
    // The name as it was before this call, so the Session title can be brought in line
    // with the record afterwards (COPY OF the original, roster.js:445,459).
    const before = room.name
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
        kept.push(room.members.find(other => other.id === id) ?? (typeof member === 'object' ? { ...member } : { id }))
      }
      // A member taken off the list loses its Session, the way `remove` below does it.
      for (const member of room.members) {
        if (kept.some(other => other.id === member.id)) continue
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
    for (const member of patch.add ?? []) {
      // An id, as the original takes it, OR a record, which is what the composer sends.
      const id = member !== null && typeof member === 'object' ? member.id : member
      if (id === undefined || id === null) continue
      if (room.members.some(other => other.id === id)) continue
      const known = rt.botOf?.(id)
      room.members.push(typeof member === 'object' ? { ...member } : { id, ...(known ? { name: known.name } : {}) })
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
    // COPY OF THE ORIGINAL (`updateRoom`, src/host/roster.js:459): "if (room.name !==
    // before) { changes.push(`renamed it …`); await retitleRoom(room) }".
    //
    // The report 「@的时候，显示的群名称不对」is this line missing. A workgroup IS a
    // Session (`createWorkgroup` copies the original's `createSession(title)`), so the
    // Session carries a title of its own. Nothing renamed it, so it kept whatever it was
    // created with — the screen showed the "@" menu offering "You, Chief, 阿三大苏打"
    // for a group called 阿松大, because that was the Session's title, not the group's
    // name. The original keeps the two in step on every rename; so does this now.
    if (room.name !== before) await retitleWorkgroup(room)
    return room
  }
  wg.updateWorkgroup = updateWorkgroup

  async function deleteWorkgroup(roomId) {
    await wg.load()
    const room = wg.workgroupOf(roomId)
    if (room === undefined) throw new Error('Unknown workgroup')
    // A member's Session is released with the group, and archived the way the
    // original does it, so no turn goes on working for a group that is gone.
    for (const sessionId of Object.values(room.sessions ?? {})) {
      wg.releaseSessionOwner(sessionId)
      void ctx.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true })?.catch?.(() => {})
    }
    dropLines(roomId)
    wg.roomInbox.delete(roomId)
    for (const [callId, round] of wg.roomProgress) if (round.roomId === roomId) wg.roomProgress.delete(callId)
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
    const agent = await rt.resolveAgent(room.id)
    if (agent === undefined) return
    const message = createUserMessage({
      content: [{ type: 'text', text: `[Workgroup post from ${member.name}]\n${text}` }],
      source: { kind: WG_SOURCE_KIND, form: 'relay', role: 'post', exchangeId: randomUUID(), senderName: member.name, senderSessionId: member.id, roomId: room.id, ...extra },
    })
    if (typeof agent.followup === 'function') agent.followup(message)
    else await ctx.sessionController.prompt({ sessionId: room.id, mode: 'queue', content: message.content, source: message.source })
    await ctx.sessions?.flush?.(agent.session)
  }
  wg.postToGroupSession = postToGroupSession

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
  async function receiveRemote({ workgroupId, event }) {
    await wg.load()
    const room = roomOfHubGroup(workgroupId) ?? wg.workgroupOf(workgroupId)
    if (room === undefined) return false
    // Durability of the dedup: the bridge's in-memory set of seen ids dies with the process, but the
    // log's own `hubEventId` does not. A replay after a restart therefore lands on a room that
    // already has this event and is refused here, which is what makes "at least once" invisible.
    if (event?.eventId !== undefined && (room.log ?? []).some(line => line.hubEventId === event.eventId)) return false
    const payload = event?.payload ?? {}
    const text = typeof payload.text === 'string' ? payload.text : ''
    const files = Array.isArray(payload.attachments) ? payload.attachments : []
    if (text === '' && files.length === 0) return false

    // Who said it. The Hub's sender is a Hub user; the member list carries the same id on the
    // member record, so the name in the log is the one the group already shows.
    const senderId = event?.sender?.userId
    const member = (room.members ?? []).find(other => other.hubUserId === senderId || other.id === senderId)
    // A Hub endpoint may speak as itself; the payload's own name is the next best answer because the
    // sender published it. "A member" is the last resort, and it is a bug when it shows: the roster
    // sync (`applyRoster`) is what normally prevents it.
    const name = member?.name ?? payload.senderName ?? payload.endpointName ?? 'A member'
    const memberId = member?.id ?? senderId ?? 'remote'

    appendLine(room, {
      who: name,
      memberId,
      text: files.length === 0 ? text : text === '' ? `[${files.map(file => file.name).join(', ')}]` : `${text}
[${files.map(file => file.name).join(', ')}]`,
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
    })
    // A line from the Hub stays out of the group's own Session, and that is deliberate.
    //
    // `postToGroupSession` writes a `role: 'post'` workgroup message, which the relay hook consumes
    // to start a round — that is exactly right for a LOCAL member, whose words this machine's model
    // produced. For a line that already came from another machine over the Hub it would start a
    // second round here, which is the same conversation answered twice by two machines. The log is
    // the record; the round is what turns a message into work, and only the machine the message was
    // sent from should start one.
    await wg.save()
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
      source: { kind: 'user' },
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
  const postInRound = (room, round, member, text) => {
    appendLine(room, { who: member.name, memberId: member.id, text })
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
  async function roomTurn(room, member, sessionId, { text, files }, note, signal, round, by, said = []) {
    if (signal.aborted) return null
    const exchangeId = randomUUID()
    const turn = { botId: member.id, sessionId, exchangeId }
    const { started } = round
    started.push(turn)
    room.seen[member.id] = room.seq
    // Checked before the delivery, which may start the turn at once.
    // Checked before the delivery, which may start the turn at once. The original reads
    // `rt.live`; a workgroup member Session is never in that map (see `live` above), so it
    // is this domain's own record that answers.
    const busy = live.get(sessionId)?.turn !== undefined
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
      }
      const work = () => { grace ??= setTimeout(() => finish({ working: true }), WG_WORK_GRACE_MS) }
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
  const QUICK_TOOLS = new Set(TEAM_TOOLS)
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
        continue
      }
      slot.status = 'speaking'
      round.speaking = member.id
      round.turns = (round.turns ?? 0) + 1
      turns.set(member.id, (turns.get(member.id) ?? 0) + 1)
      // A remote member is a person (or a Bot) on another device. Their turn is not a model
      // call this machine can make: it is a message on the Hub, and the answer — if any —
      // arrives later as an event. The round therefore does not wait for it, exactly as it
      // does not wait for a member who went quiet.
      //
      // Without the bridge (signed out), the member is reported as skipped rather than as a
      // failed Bot: nothing is broken, the Hub is simply not there.
      if (member.kind !== 'localBot') {
        const delivered = await Promise.resolve()
          .then(() => wg.deliverRemote?.({ room, member, round, slot }))
          .catch(error => ({ error }))
        if (delivered?.error !== undefined) {
          rt.warn('ds-bot: workgroup line for remote member %s not sent: %s', member.name, delivered.error?.message ?? delivered.error)
          slot.status = 'failed'
          round.failed.push(member.name)
          round.replies.push({
            kind: 'failed', botId: member.id, name: member.name, code: 'HUB',
            text: String(delivered.error?.message ?? delivered.error).slice(0, 300), time: Date.now(),
          })
        } else if (delivered?.queued === true || delivered?.sent === true) {
          slot.status = 'remote'
        } else {
          // No bridge: the member is on another device and this machine cannot reach it.
          slot.status = 'remote'
        }
        round.speaking = null
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
        continue
      }
      if (session === undefined) {
        round.speaking = null
        slot.status = 'left'
        continue
      }
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
    if (rounds.length === 0) return false
    let stopped = false
    for (const round of rounds) {
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
      for (const slot of round.slots) if (slot.status === 'speaking' || slot.status === 'waiting') slot.status = 'stopped'
    }
    if (stopped) appendLine(wg.workgroupOf(roomId), { who: 'User', kind: 'stopped', text: '' })
    await wg.save()
    return stopped
  }
  wg.stopRound = stopRound
  wg.wasStopped = exchangeId => stoppedExchanges.has(exchangeId)

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
    // Replies the poster waited for go on with the work it posted for.
    const work = post.sub === undefined ? undefined : rt.closeWork?.(post.sub, `Workgroup "${room.name}"`, text)
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
        const readings = post.images === undefined || rt.imagesForGroup === undefined
          ? []
          : await rt.imagesForGroup(post.images, room.id)
        const text = [post.text, ...readings, ...(post.files ?? []).map(fileLine)].filter(Boolean).join('\n')
        appendLine(room, {
          ...(post.botId ? { who: post.name ?? 'Bot', memberId: post.botId } : { who: 'User' }),
          text,
          ...(post.files === undefined ? {} : { files: post.files }),
        })
      }
      if (posts.some(post => !post.botId && !post.kickoff)) room.lateRounds = 0
      await wg.save()
      // An event post never picks the speakers over a message queued with it.
      const opener = posts.slice().reverse().find(post => !event(post)) ?? posts.at(-1)
      // A member a Bot's post calls by name works for that Bot.
      const named = opener.botId === undefined ? [] : mentionsIn(opener.text ?? '', room.members ?? []).found
      const round = {
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
        wg.roomProgress.delete(exec.callId)
        exec.concludeTurn?.()
        return
      }
      try {
        await runRound(room, round, exec.signal ?? new AbortController().signal)
      } catch (error) {
        rt.warn('ds-bot: workgroup round in %s stopped: %s', room.name, error)
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
        queue({ text: textOf(event.data?.content), ...(images.length > 0 ? { images } : {}), ...(files.length > 0 ? { files } : {}) })
      }
      // COPY OF THE ORIGINAL (`turns.js:446`): the kickoff is a cue, never a line.
      else if (source?.kind === WG_SOURCE_KIND && source.role === 'kickoff') queue({ text: '', kickoff: true })
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
        if (waiters.length === 0) return
        const reason = event.data?.reason
        // COPY OF THE ORIGINAL: a failed model call is not a pass. The round shows why the
        // member is silent and goes on, instead of recording that it chose to stay quiet.
        const error = reason?.kind === 'error' ? reason.error : undefined
        const failure = error === undefined ? undefined : { code: error?.code ?? 'UNKNOWN', ...(error?.status ? { status: error.status } : {}), message: String(error?.message ?? error).slice(0, 300) }
        const reply = reason?.kind === 'aborted' ? null : texts.slice(shown).join(BS + BS).trim()
        for (const [exchangeId, waiter] of waiters) {
          wg.roomWaiters.delete(exchangeId)
          if (failure !== undefined) waiter.fail(failure)
          else waiter.resolve(reply)
        }
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
