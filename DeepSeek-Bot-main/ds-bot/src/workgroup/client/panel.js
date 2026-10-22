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
import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react'
import { callWorkgroup } from './api.js'
import { createSource } from '../../client/sources.js'
import { RoomAvatar } from '../../client/mark.js'
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
  } catch (error) {
    setState({ error: error?.message ?? String(error) })
  }
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
  room.approval ? h('span', { className: 'bt-badge', 'aria-label': t('Waiting for your approval') }, '!') : null)
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

function Composer({ roomId, onSent }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    if (text.trim() === '' || busy) return
    setBusy(true)
    const ok = await run(() => callWorkgroup('send', { roomId, text }))
    setBusy(false)
    if (ok) { setText(''); onSent?.() }
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
    h('div', { className: 'bt-wg-compose-actions' },
      h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        onClick: () => void run(() => callWorkgroup('stop-round', { roomId })),
      }, t('Stop')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || text.trim() === '', onClick: send }, busy ? t('Sending…') : t('Send'))))
}

function ChatPane({ roomId, roster }) {
  const state = useWorkgroupState()
  const room = state.room
  if (roomId === null) return h('div', { className: 'bt-wg-empty' }, t('Pick a workgroup, or create one.'))
  if (room === null) return h('div', { className: 'bt-wg-empty' }, t('Loading…'))
  const lines = (room.log ?? []).map((line) => {
    const body = line.kind === undefined
      ? [h('span', { key: 'who', className: 'bt-wg-line-who' }, `${line.who}：`),
        h('span', { key: 'text' }, ...markMentions(line.text, room.members))]
      : h('span', { className: 'bt-wg-line-note' }, `[${line.who}] ${line.kind}`)
    return h('div', { key: line.seq, className: 'bt-wg-line', 'data-kind': line.kind ?? 'message' }, body)
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
    h('div', { className: 'bt-wg-log' }, lines),
    h(Composer, { roomId, onSent: () => void openWorkgroup(roomId) }),
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
      // G3 交付水位：工作群界面已可用，跨用户群聊与消息属 G4。标注必须显眼，
      // 并且不能让人把"还不能用"误判成"坏了"。
      h('div', { className: 'bt-wg-unfinished', role: 'note' },
        t('Not finished: workgroup chat and messages are not available yet.')),
      state.error !== null ? h('div', { className: 'bt-wg-error', role: 'alert' }, state.error) : null,
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
