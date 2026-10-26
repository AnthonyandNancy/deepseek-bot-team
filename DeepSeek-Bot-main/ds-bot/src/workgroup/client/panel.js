// The Bot panel: what the "Bot" top-level sidebar entry opens.
//
// Per the plan (§0.9 and §8.3) this is the ONE place the Bot team is shown. It renders
// the workgroups this domain owns, with the original team's `bt-*` tokens so the look
// matches the rest of DS Bot instead of inventing a second visual language.
//
// Root-cause note (T4): the first version rooted the panel at `.bt-panel`, which
// src/client/styles.js defines as the right-hand *drawer* (`position:fixed;right:0;
// width:320px`), and used a set of layout classes (`bt-panel-side`, `bt-chat`,
// `bt-composer`, …) that no stylesheet ever defined. Mounted in the centre column it
// therefore painted as a 320px strip of unstyled text — the user's "进去是假的". The
// panel now owns `bt-wg-*` names, and ./styles.js defines every one of them.
//
// G1 scope: list, create, open, rename, delete, send, stop. Everything calls the
// separate `api/workgroup` route. No Hub, no remote members yet.
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { callWorkgroup } from './api.js'
import { ApprovalCards } from './tasks.js'
import { createSource } from '../../client/sources.js'
import { BotMark, RoomAvatar } from '../../client/mark.js'
import { Elapsed, Shimmer, workPhrase } from '../../client/cells.js'
import { t } from '../../client/i18n.js'
import { mentionSpans } from '../../shared/mentions.js'
import { WG_CSS } from './styles.js'
import { installStyles } from '../../client/styles.js'

// One observable source for the whole panel, so a refresh from any child updates all.
const store = createSource({ rooms: [], ready: false, error: null, selected: null, room: null })

const setState = patch => store.set(state => ({ ...state, ...patch }))

export function useWorkgroupState() {
  return useSource(store)
}

// Subscribe to any observable source (the shape createSource returns). Kept generic so the
// panel can also follow the local roster it is handed, without a second mechanism.
export function useSource(source) {
  const [snapshot, setSnapshot] = useState(() => source?.getSnapshot?.())
  useEffect(() => {
    if (typeof source?.subscribe !== 'function') return undefined
    setSnapshot(source.getSnapshot())
    return source.subscribe(() => setSnapshot(source.getSnapshot()))
  }, [source])
  return snapshot
}

export async function refreshWorkgroups() {
  try {
    const value = await callWorkgroup('state')
    setState({ rooms: value.rooms ?? [], ready: true, error: null })
  } catch (error) {
    setState({ error: error?.message ?? String(error), ready: true })
  }
}

export async function openWorkgroup(id) {
  setState({ selected: id, room: null })
  try {
    const room = await callWorkgroup('room', { id })
    setState({ room })
    // Opening a group is reading it. The cursor is written here rather than on a timer: "opened"
    // is exactly the event the count is supposed to describe.
    const hubWorkgroupId = room?.hub?.workgroupId
    if (hubWorkgroupId !== undefined) {
      const seq = room?.hub?.cursor ?? 0
      if (seq > 0) {
        await callWorkgroup('mark-read', { workgroupId: hubWorkgroupId, seq }).catch(() => {})
        await refreshWorkgroups()
      }
    }
  } catch (error) {
    setState({ error: error?.message ?? String(error) })
  }
}

// KEEP THE OPEN GROUP LIVE.
//
// The host already has one Server-Sent Events stream for the original team (`/api/bot/feed`,
// `src/host/feed.js`). A workgroup save publishes a `workgroup` event on it. The panel subscribes to
// that same stream, so a line, a roster change or a rename arrives as it happens instead of on a
// timer. The event is only a SIGNAL: the room and the Hub roster are re-read through their normal
// read endpoints, so one transport does not become a second source of truth.
//
// A slow poll remains as the recovery path for a dropped stream. A laptop that sleeps can lose the
// EventSource without the room becoming wrong; the fallback closes that gap.
const FEED_PATH = 'api/bot/feed'
const liveListeners = new Set()
let liveSource
export const listenLive = (fn) => {
  liveListeners.add(fn)
  if (liveSource === undefined && typeof EventSource === 'function') {
    liveSource = new EventSource(FEED_PATH)
    const notify = (payload) => { for (const listener of liveListeners) listener(payload ?? {}) }
    liveSource.addEventListener('workgroup', (event) => {
      let payload = {}
      try { payload = JSON.parse(event.data) } catch { /* a malformed frame is just a refresh */ }
      notify(payload)
    })
    liveSource.addEventListener('revision', () => notify({ kind: 'revision' }))
  }
  return () => {
    liveListeners.delete(fn)
    if (liveListeners.size > 0) return
    liveSource?.close?.()
    liveSource = undefined
  }
}

const roomSignature = room => JSON.stringify([
  room?.name,
  room?.notice,
  room?.mode,
  room?.adminId,
  (room?.members ?? []).map(member => [member.id, member.name, member.role, member.mine, member.avatar]),
  (room?.log ?? []).map(line => [line.seq, line.kind ?? '', line.text]),
  room?.hub?.cursor,
  room?.hub?.pending,
])

export function useLiveRoom(roomId) {
  useEffect(() => {
    if (roomId === null || roomId === undefined) return undefined
    let live = true
    let timer
    let running = false
    let pending = false
    let last = roomSignature(store.getSnapshot().room)
    const read = async () => {
      if (running) { pending = true; return }
      running = true
      try {
        const room = await callWorkgroup('room', { id: roomId })
        if (!live) return
        const next = roomSignature(room)
        // Only the group that is still on screen may write: a slow answer for a group the user
        // already left must not replace the one they are reading.
        if (next !== last && store.getSnapshot().selected === roomId) {
          last = next
          setState({ room })
        }
      } catch {
        // The group is already on screen; the next signal or fallback tick tries again.
      } finally {
        running = false
        if (pending) { pending = false; void read() }
      }
    }
    // Every workgroup signal refreshes the open room. The event may name another group; `read` uses
    // the selected id and the store check above, so it cannot show one room's answer in another.
    const off = listenLive(() => { void read() })
    const tick = () => {
      if (!live) return
      void read().finally(() => { if (live) timer = setTimeout(tick, 5000) })
    }
    void read()
    timer = setTimeout(tick, 5000)
    return () => { live = false; clearTimeout(timer); off() }
  }, [roomId])
}

// The member card's own live read. The room log changes only when somebody speaks; a person joining,
// or a colleague's Bot being added, changes the roster without a line. The Hub remains the authority,
// and a workgroup signal is the trigger; the signature keeps a message-only signal from re-rendering.
const memberSignature = members => JSON.stringify((members ?? []).map(member => [
  member.membershipId,
  member.name,
  member.role,
  member.ownerIsYou,
  member.avatar,
  member.color,
  member.online,
]))

export function useLiveMembers(workgroupId) {
  const [members, setMembers] = useState([])
  useEffect(() => {
    if (workgroupId === undefined) { setMembers([]); return undefined }
    let live = true
    let timer
    let running = false
    let pending = false
    let last = memberSignature(members)
    const read = async () => {
      if (running) { pending = true; return }
      running = true
      try {
        // The roster lives on the Hub, so this read is the authority. It is deliberately NOT gated
        // on the local state revision: presence (`online`) and a member joining change the Hub row
        // without necessarily saving this machine's state file.
        const answer = await callWorkgroup('group-members', { workgroupId })
        if (!live) return
        const next = answer?.members ?? []
        const signature = memberSignature(next)
        if (signature !== last) {
          last = signature
          setMembers(next)
        }
      } catch {
        // A Hub that is down keeps the last roster on screen; the connection line says why.
      } finally {
        running = false
        if (pending) { pending = false; void read() }
      }
    }
    const off = listenLive(() => { void read() })
    const tick = () => {
      if (!live) return
      void read().finally(() => { if (live) timer = setTimeout(tick, 5000) })
    }
    void read()
    timer = setTimeout(tick, 5000)
    return () => { live = false; clearTimeout(timer); off() }
  }, [workgroupId])
  return members
}

// Create a workgroup directly, then select it. Returns the created room so the caller
// (the new-chat menu) can navigate to it. `members` is what makes the room answerable.
export async function createWorkgroup(name, members = []) {
  const room = await callWorkgroup('create-room', { name, members })
  await refreshWorkgroups()
  setState({ selected: room.id, room })
  return room
}

const run = async (action) => {
  try {
    await action()
    await refreshWorkgroups()
    return true
  } catch (error) {
    setState({ error: error?.message ?? String(error) })
    return false
  }
}

// The marker that tells a workgroup apart from a local group (T1). It carries a glyph
// *and* the word, so the distinction survives colour blindness and greyscale.
function WorkgroupMark({ label }) {
  return h('span', { className: 'bt-wg-mark', 'aria-hidden': label === undefined, 'aria-label': label },
    h('span', { className: 'bt-wg-mark-glyph', 'aria-hidden': true }, '◆'),
    h('span', null, t('Workgroup')))
}

// One row, drawn with the original team's row class so spacing and type match.
// Exported for the render test, which checks the marker and the accessible name.
export function RoomRow({ room, active, onOpen }) {
  const members = room.members ?? []
  const name = room.name || t('Unnamed workgroup')
  // The accessible name carries the whole distinction: kind, name, member count, and
  // where it came from when it was upgraded from a local group.
  const label = [
    t('Workgroup'),
    name,
    members.length > 0 ? t('{count} members', { count: members.length }) : '',
    room.linkedLocalName ? t('Upgraded from {name}', { name: room.linkedLocalName }) : '',
  ].filter(Boolean).join(', ')
  return h('button', {
    type: 'button',
    className: active ? 'bt-row bt-row-active' : 'bt-row',
    'data-workgroup-id': room.id,
    'data-workgroup': 'true',
    'aria-label': label,
    'aria-current': active ? 'true' : undefined,
    onClick: () => onOpen(room.id),
  },
  h('span', { className: 'bt-wg-avatar', 'aria-hidden': true }, '◆'),
  h('span', { className: 'bt-wg-row-main' },
    h('span', { className: 'bt-row-name' },
      h('span', { className: 'bt-wg-name' }, name),
      h(WorkgroupMark)),
    h('span', { className: 'bt-wg-preview' }, room.preview ?? (members.length > 0 ? t('{count} members', { count: members.length }) : '')),
    room.linkedLocalName
      ? h('span', { className: 'bt-wg-link' }, t('Upgraded from {name}', { name: room.linkedLocalName }))
      : null),
  room.approval ? h('span', { className: 'bt-badge', 'aria-label': t('Waiting for your approval') }, '!') : null,
  // Unread, from the Hub's own count for this person. Absent for a group that is not on the Hub:
  // a local workgroup has no cursor, and inventing one would show a number nobody can clear.
  room.unread > 0
    ? h('span', { className: 'bt-wg-unread', 'aria-label': t('{count} unread', { count: room.unread }), 'data-unread': String(room.unread) }, String(room.unread))
    : null)
}


// Draw the "@Name" tokens a workgroup message contains, so what the reader sees called is
// what the host actually called (plan: the same rule on both sides).
//
// The spans come from the original `mentionSpans`, the very function the group host uses
// to choose speakers — so this is not a second parser. `@all` is marked as well. Anything
// that is not a mention stays plain text.
function markMentions(text, members) {
  const value = String(text ?? '')
  if (!value.includes('@')) return [value]
  const bots = (members ?? []).map(member => ({ id: member.id, name: member.name }))
  const spans = mentionSpans(value, bots)
  if (spans.length === 0) return [value]
  const out = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) out.push(value.slice(cursor, span.start))
    const token = value.slice(span.start, span.end)
    out.push(h('span', {
      key: `m${span.start}`,
      className: span.all ? 'bt-wg-at bt-wg-at-all' : 'bt-wg-at',
      'data-mention': span.all ? 'all' : span.bot?.name,
    }, token))
    cursor = span.end
  }
  if (cursor < value.length) out.push(value.slice(cursor))
  return out
}

// The connection line under the composer.
//
// It reports a MEASURED state, not a decoration: it times a real round trip to this
// plugin's own route and shows what happened — connected with the latency, or the failure
// itself. Polling stops while the panel is closed, and a slow answer never stacks up
// (`busy` guards it).
function ConnectionLine() {
  const [state, setState] = useState({ kind: 'checking', ms: null, detail: '' })
  useEffect(() => {
    let live = true
    let timer
    let busy = false
    const probe = async () => {
      if (busy) return
      busy = true
      const started = Date.now()
      try {
        await callWorkgroup('state')
        if (live) setState({ kind: 'ok', ms: Date.now() - started, detail: '' })
      } catch (error) {
        if (live) setState({ kind: 'down', ms: null, detail: error?.message ?? String(error) })
      } finally {
        busy = false
        if (live) timer = setTimeout(probe, 5000)
      }
    }
    void probe()
    return () => { live = false; clearTimeout(timer) }
  }, [])
  const label = state.kind === 'ok'
    ? t('Connected · {ms} ms', { ms: state.ms })
    : state.kind === 'down' ? t('Not connected: {reason}', { reason: state.detail }) : t('Connecting…')
  return h('div', {
    className: `bt-wg-conn bt-wg-conn-${state.kind}`,
    role: 'status',
    'aria-live': 'polite',
    'data-connection': state.kind,
  },
  h('span', { className: 'bt-wg-conn-dot', 'aria-hidden': true }),
  h('span', { className: 'bt-wg-conn-text' }, label))
}

// Read a picked file as base64. The bytes are what travels; the file's path never leaves this
// function, which is the whole shape of the relay (plan §13.2).
const readAsBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onerror = () => reject(new Error('That file could not be read.'))
  reader.onload = () => {
    const result = String(reader.result ?? '')
    // `data:...;base64,XXXX` → `XXXX`. A browser hands a data URL; the Hub wants bare base64.
    const comma = result.indexOf(',')
    resolve(comma === -1 ? result : result.slice(comma + 1))
  }
  reader.readAsDataURL(file)
})

function Composer({ roomId, hub, archived, paused = 0, onSent }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const fileInput = useRef(null)

  // An upgraded local group is history: it is not deleted and it is not read-only in the sense of
  // hidden, but a message typed here would go nowhere. Saying so is the honest answer.
  if (archived) {
    return h('div', { className: 'bt-wg-compose bt-wg-compose-archived', role: 'note', 'data-archived': 'true' },
      t('This group was upgraded to a workgroup. It stays here as read-only history; conversation continues in the workgroup.'))
  }

  const send = async () => {
    if (text.trim() === '' || busy) return
    setBusy(true)
    setNote(null)
    // A Hub group's message goes to the Hub FIRST: the pane calls `send-hub`, which returns once
    // the Hub has it. A room with no Hub keeps the original local path.
    const ok = await run(() => (hub === null
      ? callWorkgroup('send', { roomId, text })
      : callWorkgroup('send-hub', { workgroupId: hub.workgroupId, text })))
    setBusy(false)
    if (ok) { setText(''); onSent?.() } else setNote(t('That message was not sent. It is still in the box.'))
  }

  const attach = async (file) => {
    if (file === undefined || hub === null || busy) return
    setBusy(true)
    setNote(null)
    try {
      const data = await readAsBase64(file)
      const sent = await callWorkgroup('send-attachment', {
        workgroupId: hub.workgroupId,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        data,
      })
      setNote(t('Sent {name} ({size} bytes).', { name: sent.name, size: sent.size }))
      onSent?.()
    } catch (error) {
      setNote(error?.message ?? String(error))
    } finally {
      setBusy(false)
      if (fileInput.current !== null) fileInput.current.value = ''
    }
  }

  return h('div', { className: 'bt-wg-compose' },
    h('textarea', {
      className: 'bt-wg-compose-input',
      value: text,
      rows: 2,
      placeholder: t('Message this workgroup…'),
      'aria-label': t('Message this workgroup'),
      onChange: event => setText(event.target.value),
      onKeyDown: (event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
      },
    }),
    note === null ? null : h('div', { className: 'bt-wg-note', role: 'status' }, note),
    h('div', { className: 'bt-wg-compose-actions' },
      // Only a Hub group can carry a file: a local workgroup's members are Bots on this machine and
      // the relay is the Hub's. Offering the control where it cannot work would be a dead button.
      hub === null ? null : h('span', null,
        h('input', {
          ref: fileInput,
          type: 'file',
          className: 'bt-wg-file',
          'aria-label': t('Attach a file'),
          onChange: event => void attach(event.target.files?.[0]),
        })),
      paused > 0 ? h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        onClick: () => void run(() => callWorkgroup('continue-room', { roomId })),
      }, t('Continue')) : null,
      h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        onClick: () => void run(() => callWorkgroup('stop-round', { roomId })),
      }, t('Stop')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || text.trim() === '', onClick: send }, busy ? t('Sending…') : t('Send'))))
}

// The Hub line of a group that lives on the Hub: whether the socket is up, how far this machine
// has read the group's log, and whether anything it typed is still waiting for the Hub's ack.
//
// It is deliberately separate from `ConnectionLine` below: that one measures THIS plugin's route
// (is the host answering?), this one reports the Hub. Two different failures must not look alike.
function HubLine({ hub }) {
  if (hub === null) return null
  const state = hub.connected ? 'online' : 'offline'
  const label = hub.pending > 0
    ? t('Waiting for the Hub: {count} message(s).', { count: hub.pending })
    : hub.connected
      ? t('Connected to the Hub · read to #{seq}', { seq: hub.cursor })
      : t('Offline: messages are kept and sent when the Hub comes back.')
  return h('div', {
    className: `bt-wg-conn bt-wg-conn-${state === 'online' ? 'ok' : 'down'}`,
    role: 'status',
    'aria-live': 'polite',
    'data-hub': state,
    'data-pending': String(hub.pending ?? 0),
  },
  h('span', { className: 'bt-wg-conn-dot', 'aria-hidden': true }),
  h('span', { className: 'bt-wg-conn-text' }, label))
}

// One attachment in a log line, as a button that fetches the bytes through the plugin's own route.
//
// The bytes are relayed, not linked: the Hub's ticket is short-lived and tied to one person, so
// handing the client a URL would put that ticket in a place the browser keeps. The button asks, the
// host fetches, the browser saves.
function AttachmentLink({ attachment, name }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const label = name ?? attachment?.name ?? t('file')
  if (attachment?.attachmentId === undefined) {
    // An attachment this machine cannot fetch (expired, or an older line without an id): say the
    // name rather than offering a button that cannot work.
    return h('span', { className: 'bt-wg-attach bt-wg-attach-plain' }, label)
  }
  const fetchIt = async () => {
    setBusy(true)
    setNote(null)
    try {
      const answer = await callWorkgroup('attachment-download', { attachmentId: attachment.attachmentId })
      // `data` is base64, which in a plugin route is the only way bytes cross without a second
      // transport. The save itself is the browser's job, so the user chooses where it lands.
      const href = `data:${attachment.mime ?? 'application/octet-stream'};base64,${answer.data}`
      const link = document.createElement('a')
      link.href = href
      link.download = answer.name ?? label
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch (error) {
      setNote(error?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }
  return h('span', { className: 'bt-wg-attach' },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: fetchIt },
      busy ? t('Downloading…') : t('Download {name}', { name: label })),
    note === null ? null : h('span', { className: 'bt-wg-note', role: 'status' }, note))
}

// WHO IS WORKING IN THIS GROUP, above the composer — the original group chat's work indicator.
//
// A local group shows a member at work twice: the activity row (a `BotMark` plus a shimmering
// `workPhrase` and an `Elapsed` clock) while it runs, and the bottom capsule listing everyone busy.
// A workgroup's panel showed NEITHER. The host side has been complete all along — `roomWorkView`
// and `activityView` answer in the original's exact shape — but the panel simply never asked, and
// its chat is a transcript with no live part at all. That is the whole difference the user
// described as 「工作群并没有原版群聊那种工作中的动效」.
//
// The data comes from the domain's own `state` route, the same one `refreshWorkgroups` uses, so this
// adds no second mechanism: `work.rooms[roomId]` is keyed by the room id the panel already holds.
//
// Polled while a room is open, at the same cadence the connection line uses. A workgroup's members
// run in OTHER Sessions on this machine (and on another machine entirely), so there is no client
// event to subscribe to; the original's own work view is polled the same way.
export function LocalWorking({ roomId }) {
  const [busy, setBusy] = useState([])
  useEffect(() => {
    let live = true
    let timer
    let running = false
    const poll = async () => {
      if (running) return
      running = true
      try {
        const value = await callWorkgroup('state')
        // `work.rooms` is keyed by room id; a room with nobody working has no entry at all.
        if (live) setBusy(value?.work?.rooms?.[roomId] ?? [])
      } catch {
        if (live) setBusy([])
      } finally {
        running = false
        // The indicator has to disappear promptly when the work ends, so poll faster while somebody
        // is busy than when nobody is — the same trade the connection line makes.
        if (live) timer = setTimeout(poll, busy.length > 0 ? 700 : 2000)
      }
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
    // `busy.length` is deliberately not a dependency: it is read inside the loop for the cadence, and
    // depending on it would restart the poll on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])
  if (busy.length === 0) return null
  return h('div', { className: 'bt-wg-working', role: 'status', 'aria-live': 'polite', 'data-working': String(busy.length) },
    busy.slice(0, 3).map(entry => h('span', { key: entry.botId, className: 'bt-wg-working-line', 'data-speaking': entry.speaking === true ? 'true' : undefined },
      h(RoomAvatar, { room: { members: [entry.botId] }, size: 18 }),
      h(Shimmer, null, `...${workPhrase(entry)}`),
      h(Elapsed, { at: entry.since, className: 'bt-wg-working-time' }))),
    busy.length > 3 ? h('span', { className: 'bt-wg-working-more' }, `+${busy.length - 3}`) : null)
}

// The members of a Hub group, as the Hub reports them, plus the invite control. A person is shown
// as a masked phone number (the Hub never returns a full one to a member), and a Bot endpoint as
// the name its owner published.
export function MemberList({ hub, members, onInvite }) {
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const [published, setPublished] = useState(null)
  if (hub === null) return null

  const publish = async () => {
    setBusy(true)
    setPublished(null)
    try {
      const answer = await callWorkgroup('publish-endpoints')
      setPublished(t('Published {count} Bot(s).', { count: (answer.endpoints ?? []).length }))
      onInvite?.()
    } catch (error) {
      setPublished(error?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  const invite = async () => {
    const value = phone.trim()
    if (value === '' || busy) return
    setBusy(true)
    setNote(null)
    try {
      const sent = await callWorkgroup('invite-member', { workgroupId: hub.workgroupId, phone: value })
      setNote(t('Invited {phone}.', { phone: sent.inviteePhoneMasked }))
      setPhone('')
      onInvite?.()
    } catch (error) {
      setNote(error?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  return h('div', { className: 'bt-wg-roster', 'data-members': String(members.length) },
    h('div', { className: 'bt-wg-roster-head' }, t('Members')),
    h('div', { className: 'bt-wg-roster-list', role: 'list' },
      members.map(member => h('div', {
        key: member.membershipId,
        className: 'bt-wg-roster-row',
        role: 'listitem',
        'data-member-type': member.memberType,
        'data-member-role': member.role,
      },
      // A person's presence, from the Hub. A Bot endpoint has no socket of its own, so it shows no
      // dot rather than a misleading one.
      member.userId === undefined
        ? null
        : h('span', {
          className: `bt-wg-presence bt-wg-presence-${member.online === true ? 'on' : 'off'}`,
          'aria-label': member.online === true ? t('Online') : t('Offline'),
          'data-online': member.online === true ? 'true' : 'false',
        }),
      // WHO A BOT BELONGS TO.
      //
      // A workgroup's members come from several accounts, and two colleagues may both have a Bot
      // called "Chief". Without this tag the roster is a list of names with no way to tell whose is
      // whose — the user's 「需要在每个 bot 增加标识，区分每个 bot 的归属」. "Yours" is the Hub's own
      // answer (`ownerIsYou`, computed from the authenticated connection), so it cannot be faked.
      member.memberType === 'botEndpoint'
        // The Hub roster carries the appearance its owner published (`avatar.shape`/`image`,
        // plus `color`). Passing the bare endpoint id instead let `lookOf()` derive a different
        // character and colour on every machine, which is the reported changing Bot avatar.
        ? h(BotMark, {
          bot: {
            id: member.endpointId,
            name: member.name,
            // `lookOf()` reads the colour from the record and the shape/photo from `avatar`.
            // The Hub's published snapshot groups all three; split it the same way here.
            ...(member.color !== undefined
              ? { color: member.color }
              : typeof member.avatar?.color === 'string' ? { color: member.avatar.color } : {}),
            ...(member.avatar === undefined
              ? {}
              : {
                  avatar: {
                    ...(typeof member.avatar.shape === 'string' ? { shape: member.avatar.shape } : {}),
                    ...(typeof member.avatar.image === 'string' ? { image: member.avatar.image } : {}),
                  },
                }),
          },
          size: 16,
          live: false,
        })
        : null,
      h('span', { className: 'bt-wg-roster-name' },
        // A Bot endpoint shows its published name; a person shows the masked number the Hub gives.
        member.memberType === 'botEndpoint' ? member.name ?? t('Bot') : member.phoneMasked ?? t('A member')),
      member.memberType === 'botEndpoint'
        ? h('span', { className: 'bt-wg-roster-owner', 'data-mine': member.ownerIsYou === true ? 'true' : 'false' },
          member.ownerIsYou === true ? t('Yours') : t("A colleague's"))
        : null,
      member.role === 'owner' ? h('span', { className: 'bt-wg-roster-role' }, t('Owner')) : null))),
    // Publishing is what makes this machine's Bots addressable in a group. It is a button rather
    // than something automatic on every panel open, because it is a decision about what this machine
    // offers other people — and the host refuses it while signed out, which is what the note says.
    h('div', { className: 'bt-wg-publish' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: publish },
        t('Publish my Bots to this group')),
      published === null ? null : h('div', { className: 'bt-wg-note', role: 'status' }, published)),
    h('div', { className: 'bt-wg-invite' },
      h('input', {
        className: 'bt-input',
        value: phone,
        placeholder: t('Invite by phone number'),
        'aria-label': t('Phone number to invite'),
        onChange: event => setPhone(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') void invite() },
      }),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || phone.trim() === '', onClick: invite },
        busy ? t('Inviting…') : t('Invite'))),
    note === null ? null : h('div', { className: 'bt-wg-note', role: 'status' }, note))
}

function ChatPane({ roomId, roster }) {
  const state = useWorkgroupState()
  // The open group is re-read while it is on screen, so a line that arrives from another machine
  // appears without closing and reopening it.
  useLiveRoom(roomId)
  const room = state.room
  // The Hub roster is fetched separately from the room, because it lives on the Hub and the room
  // lives here: a Hub that is down must not stop the conversation that is already on screen.
  const hubWorkgroupId = room?.hub?.workgroupId
  const members = useLiveMembers(hubWorkgroupId)

  if (roomId === null) return h('div', { className: 'bt-wg-empty' }, t('Pick a workgroup, or create one.'))
  if (room === null) return h('div', { className: 'bt-wg-empty' }, t('Loading…'))

  const memberOfLine = (line) => (members ?? []).find(member => member.endpointId === line.memberId
    || member.membershipId === line.memberId
    || member.userId === line.memberId)
  const lines = (room.log ?? []).map((line) => {
    const owner = memberOfLine(line)
    const body = line.kind === undefined
      ? [h('span', { key: 'who', className: 'bt-wg-line-who' }, `${line.who}：`,
        // Two colleagues can each have a Bot called "Chief". The member card already says whose
        // each one is; the line is where a person reads who did the work, so it carries the same
        // answer. Only a Bot endpoint has an owner tag — a person's line is not a Bot.
        owner?.memberType === 'botEndpoint'
          ? h('span', {
              key: 'owner',
              className: 'bt-wg-line-owner',
              'data-mine': owner.ownerIsYou === true ? 'true' : 'false',
            }, owner.ownerIsYou === true ? t('Yours') : t("A colleague's"))
          : null),
        h('span', { key: 'text' }, ...markMentions(line.text, room.members)),
        // The line's own files, as buttons. A line with files carries them on `attachments`; the
        // text already names them, so this is the part that actually fetches.
        ...(Array.isArray(line.attachments) && line.attachments.length > 0
          ? [h('span', { key: 'files', className: 'bt-wg-line-files' },
            line.attachments.map((attachment, index) => h(AttachmentLink, { key: index, attachment })))]
          : [])]
      : h('span', { className: 'bt-wg-line-note' }, `[${line.who}] ${line.kind}`)
    return h('div', {
      key: line.seq,
      className: 'bt-wg-line',
      'data-kind': line.kind ?? 'message',
      // A line that crossed the Hub is marked as such: it is what tells the reader that the
      // message came from another machine, and it is the only place that fact is visible.
      ...(line.via === 'hub' ? { 'data-via': 'hub', 'data-hub-seq': String(line.hubSeq ?? '') } : {}),
    }, body)
  })

  return h('div', { className: 'bt-wg-chat' },
    h('div', { className: 'bt-wg-chat-head' },
      // The same identity the local-group header shows: the group's member avatars, then
      // its name. A workgroup and a local group should read the same at the top.
      h(RoomAvatar, { room: { members: (room.members ?? []).map(member => member.id) }, roster, size: 28 }),
      h('span', { className: 'bt-wg-chat-name' }, room.name || t('Unnamed workgroup')),
      h(WorkgroupMark),
      h('span', { className: 'bt-wg-chat-sub' }, t('{count} members', { count: (room.members ?? []).length })),
      room.linkedLocalName
        ? h('span', { className: 'bt-wg-chat-sub' }, t('Upgraded from {name}', { name: room.linkedLocalName }))
        : null),
    // A room that was upgraded away from this machine: the pane says so once, above the log, and
    // the composer refuses below. Both read the same fact.
    room.archived
      ? h('div', { className: 'bt-wg-archived', role: 'note', 'data-archived': 'true' },
        t('Archived: this local group was upgraded to a workgroup. Its history stays readable here and is not shared.'))
      : null,
    h(MemberList, { hub: room.hub ?? null, members, onInvite: () => void openWorkgroup(roomId) }),
    h('div', { className: 'bt-wg-log' }, lines),
    // The live part of the conversation: who is working right now, between the transcript and the
    // box the user types in. Placed exactly where a local group's activity row sits.
    h(LocalWorking, { roomId }),
    h(Composer, {
      roomId,
      hub: room.hub ?? null,
      archived: room.archived === true,
      paused: (room.paused ?? []).length,
      onSent: () => void openWorkgroup(roomId),
    }),
    h(HubLine, { hub: room.hub ?? null }),
    h(ConnectionLine, null))
}

// The stylesheet is installed once per document. A remount (switching panels back and
// forth) must not append a second copy.
let stylesInstalled = false
const ensureStyles = () => {
  if (stylesInstalled) return
  stylesInstalled = true
  installStyles(WG_CSS, 'workgroup')
}

// Invites addressed to this account.
//
// Without this the product had no way to JOIN a group: the host could answer an invite, but nothing
// in the UI ever showed one, so a second machine could never be added. It sits at the top of the
// panel rather than in a modal, because an invite is a thing a person ignores for a day.
function InviteInbox({ onChanged }) {
  const [invites, setInvites] = useState([])
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)

  const load = useCallback(async () => {
    try {
      const answer = await callWorkgroup('group-invites')
      setInvites(answer.incoming ?? [])
    } catch {
      // A Hub that is down is not an error worth a banner here: `ConnectionLine` already says so.
      setInvites([])
    }
  }, [])
  useEffect(() => { void load() }, [load])

  if (invites.length === 0) return null
  const answer = async (invite, accept) => {
    setBusy(invite.inviteId)
    setNote(null)
    try {
      await callWorkgroup('answer-invite', { inviteId: invite.inviteId, accept })
      await load()
      onChanged?.()
    } catch (error) {
      setNote(error?.message ?? String(error))
    } finally {
      setBusy(null)
    }
  }
  return h('div', { className: 'bt-wg-inbox', role: 'region', 'aria-label': t('Invitations'), 'data-invites': String(invites.length) },
    h('div', { className: 'bt-wg-roster-head' }, t('Invitations')),
    invites.map(invite => h('div', { key: invite.inviteId, className: 'bt-wg-invite-row', 'data-invite': invite.inviteId },
      h('span', { className: 'bt-wg-invite-name' }, invite.groupName || t('Unnamed workgroup')),
      h('span', { className: 'bt-wg-invite-from' }, invite.invitedByPhoneMasked ?? ''),
      h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy === invite.inviteId,
        onClick: () => void answer(invite, true),
      }, t('Join')),
      h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm bt-danger', disabled: busy === invite.inviteId,
        onClick: () => void answer(invite, false),
      }, t('Decline')))),
    note === null ? null : h('div', { className: 'bt-wg-note', role: 'status' }, note))
}

// The approval cards: work another person asked B to do (plan §10.1 step 3).
//
// This is the one screen in the product that grants somebody else's work the right to run on this
// machine, so it is deliberately plain:
//   * it appears only for requests addressed to THIS account, because the host only records those;
//   * it names the person, the group and what was asked for, in the words the requester used;
//   * "Approve" asks which Bot runs it, and offers the three ways the plan names --- an existing
//     Bot, the Chief picking one, or a new Bot for this task;
//   * "Decline" is a first-class answer, not a hidden menu item.
//
// Nothing here is a capability: the host writes the local ledger after the Hub agrees, and the tool
// guard enforces it. A card left unanswered runs nothing at all.
// `ApprovalCards` lives in ./tasks.js now: the group settings drawer shows the same cards, and one
// component means the two places cannot drift apart.

// The panel itself. It reaches the host only through ./api.js, never into the shell.
export function BotPanel({ roster } = {}) {
  const state = useWorkgroupState()
  const [renaming, setRenaming] = useState(null)
  const [draft, setDraft] = useState('')
  const selected = state.selected
  useEffect(() => { void refreshWorkgroups() }, [])
  useEffect(ensureStyles, [])

  const onOpen = useCallback(id => { void openWorkgroup(id) }, [])
  const remove = useCallback(async (room) => {
    await run(() => callWorkgroup('delete-room', { id: room.id }))
    if (store.getSnapshot().selected === room.id) setState({ selected: null, room: null })
  }, [])
  const rename = useCallback(async (room) => {
    const next = draft.trim()
    setRenaming(null)
    if (next === '' || next === room.name) return
    await run(() => callWorkgroup('update-room', { id: room.id, name: next }))
  }, [draft])

  const rooms = useMemo(() => state.rooms ?? [], [state.rooms])

  const rowFor = (room) => {
    if (renaming === room.id) {
      return h('input', {
        key: 'rename',
        className: 'bt-input',
        value: draft,
        autoFocus: true,
        'aria-label': t('Rename {name}', { name: room.name }),
        onChange: event => setDraft(event.target.value),
        onBlur: () => void rename(room),
        onKeyDown: (event) => {
          if (event.key === 'Enter') void rename(room)
          if (event.key === 'Escape') setRenaming(null)
        },
      })
    }
    return h(RoomRow, { key: 'row', room, active: room.id === selected, onOpen })
  }

  const menuFor = room => h('div', { className: 'bt-wg-row-menu' },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { setRenaming(room.id); setDraft(room.name) } }, t('Rename')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-danger', onClick: () => void remove(room) }, t('Delete')))

  const list = rooms.length === 0 && state.ready
    ? h('div', { className: 'bt-hint' }, t('No workgroups yet.'))
    : rooms.map(room => h('div', { key: room.id, className: 'bt-wg-row-wrap' }, rowFor(room), menuFor(room)))

  return h('div', { className: 'bt-wg', 'data-workgroup-panel': 'true' },
    h('div', { className: 'bt-wg-side' },
      h('div', { className: 'bt-wg-head' },
        h('span', { className: 'bt-wg-title' }, t('Workgroups')),
        h('span', { className: 'bt-wg-count' }, String(rooms.length))),
      // The G3 notice ("workgroup chat and messages are not available yet") used to sit here.
      // G4 delivered both, so it is gone: the panel now reports what it can actually do — see
      // `BridgeLine` below, which shows a measured Hub connection rather than a promise.
      state.error !== null ? h('div', { className: 'bt-wg-error', role: 'alert' }, state.error) : null,
      h(InviteInbox, { onChanged: () => void refreshWorkgroups() }),
      h(ApprovalCards, { onChanged: () => void refreshWorkgroups() }),
      h('div', { className: 'bt-wg-list', role: 'list', 'aria-label': t('Workgroups') }, list)),
    h('div', { className: 'bt-wg-main' },
      h(ChatPane, { roomId: selected, roster })))
}

// Exposed so the host entry can show a count without re-fetching, and so the original
// context menu can act on a workgroup row through this domain's own route. The row looks
// like a local group row on purpose (the plan reuses the original group UI), so the menu
// opens on it too — but its entries must not call the local team's actions with a
// workgroup id, which is what answered "Unknown group chat" (找不到该群聊).
export const workgroupStore = store

// Close a workgroup that is no longer there, so the panel does not keep showing a deleted
// group. Only clears the selection when it is the one that went.
export const forgetWorkgroup = id => setState(store.getSnapshot().selected === id ? { selected: null, room: null } : {})

// Rename a workgroup from anywhere in the client. Returns the new name, or undefined when
// nothing changed, so a caller can tell "cancelled" from "renamed".
export async function renameWorkgroup(id, name) {
  const next = String(name ?? '').trim()
  const room = store.getSnapshot().rooms.find(other => other.id === id)
  if (room === undefined || next === '' || next === room.name) return undefined
  await callWorkgroup('update-room', { id, name: next })
  await refreshWorkgroups()
  return next
}

// Delete a workgroup from anywhere in the client. The row disappears and, if it was open,
// the panel goes back to no selection.
export async function deleteWorkgroup(id) {
  await callWorkgroup('delete-room', { id })
  forgetWorkgroup(id)
  await refreshWorkgroups()
}
