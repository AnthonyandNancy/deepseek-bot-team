// The invitation inbox: the one place a person answers "somebody asked me to join their group".
//
// G4 scope, not G5. `g4/NEXT-INSTRUCTION.md` §2 puts 邀请 (invites) and 群成员 in G4, and lists
// `POST /v1/invites/:id/accept` among the endpoints G4 must deliver; T08 ("双机聊天、附件、成员邀请")
// is the acceptance case. G5 is cross-user task delegation and approvals, which is a different
// thing — a card that asks "may this machine run your task" is not a card that asks "may I join".
//
// Why this file exists at all: the host has answered invites since G4 (`group-invites`,
// `answer-invite`), and the panel drew them, but the panel was registered under a key no navigation
// ever selected (`WG_PANEL_KEY`). So an invite arrived at the Hub, reached this machine through
// `group-invites`, and had nowhere to appear: a colleague could be invited and never see it. This
// is the entry point that was missing, reachable from the sidebar's own button row.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { callWorkgroup } from './api.js'
import { t } from '../../client/i18n.js'

// A group name for a row that has none, without inventing a title the Hub never showed.
const labelOf = invite => invite?.groupName || invite?.name || t('Unnamed workgroup')

export function useInbox() {
  const [state, setState] = useState({ incoming: [], groups: [], ready: false, error: null })

  const load = useCallback(async () => {
    try {
      const answer = await callWorkgroup('group-invites')
      setState({ incoming: answer?.incoming ?? [], groups: answer?.groups ?? [], ready: true, error: null })
    } catch (error) {
      // A Hub that is down is not a broken inbox: say so quietly and let the next open retry.
      setState(previous => ({ ...previous, ready: true, error: error?.message ?? String(error) }))
    }
  }, [])

  useEffect(() => { void load() }, [load])
  return { ...state, reload: load }
}

export function InviteInboxButton({ count, onClick, className = 'bt-round' }) {
  const label = count > 0 ? t('Invitations ({count})', { count }) : t('Invitations')
  return h('button', {
    type: 'button',
    className,
    'aria-label': label,
    title: label,
    'data-invites': String(count),
    onClick,
  },
  h('span', { className: 'bt-inbox-glyph', 'aria-hidden': true }, '\u2709'),
  count > 0 ? h('span', { className: 'bt-inbox-count', 'aria-hidden': true }, String(count)) : null)
}

// The list itself. Kept as a plain list rather than a modal framework: two verbs per row, and the
// answer is final, so a card that closes itself is the whole interaction.
export function InviteInbox({ open, onClose, onChanged }) {
  const { incoming, ready, error, reload } = useInbox()
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)

  useEffect(() => {
    if (open) void reload()
  }, [open, reload])
  if (!open) return null

  const answer = async (invite, accept) => {
    setBusy(invite.inviteId)
    setNote(null)
    try {
      await callWorkgroup('answer-invite', { inviteId: invite.inviteId, accept })
      await reload()
      onChanged?.()
      if (accept) onClose?.()
    } catch (failure) {
      setNote(failure?.message ?? String(failure))
    } finally {
      setBusy(null)
    }
  }

  return h('div', {
    className: 'bt-inbox-panel',
    role: 'dialog',
    'aria-label': t('Invitations'),
    'data-invites': String(incoming.length),
  },
  h('div', { className: 'bt-inbox-head' },
    h('span', { className: 'bt-inbox-title' }, t('Invitations')),
    h('button', { type: 'button', className: 'bt-inbox-x', 'aria-label': t('Close'), onClick: onClose }, '\u00d7')),
  error !== null ? h('div', { className: 'bt-note', role: 'alert' }, error) : null,
  incoming.length === 0
    ? h('div', { className: 'bt-inbox-empty' }, ready ? t('No invitations.') : t('Loading…'))
    : h('div', { className: 'bt-inbox-list', role: 'list' }, incoming.map(invite => h('div', {
      key: invite.inviteId,
      className: 'bt-inbox-row',
      role: 'listitem',
      'data-invite': invite.inviteId,
    },
    h('div', { className: 'bt-inbox-copy' },
      h('span', { className: 'bt-inbox-name' }, labelOf(invite)),
      h('span', { className: 'bt-inbox-from' }, invite.invitedByPhoneMasked ?? '')),
    h('div', { className: 'bt-inbox-actions' },
      h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy === invite.inviteId,
        onClick: () => void answer(invite, true),
      }, busy === invite.inviteId ? t('Joining…') : t('Join')),
      h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm bt-danger', disabled: busy === invite.inviteId,
        onClick: () => void answer(invite, false),
      }, t('Decline')))))),
  note === null ? null : h('div', { className: 'bt-inbox-note', role: 'status' }, note))
}

// The button's own styles. Installed with the shell so the sidebar's header row can hold a badge
// without the panel having been opened first.
export const INBOX_CSS = `
.bt-inbox-glyph{font-size:15px;line-height:1}
.bt-inbox-count{position:absolute;top:2px;right:2px;min-width:15px;height:15px;padding:0 3px;border-radius:8px;background:var(--bt-blue,#2f6fed);color:#fff;font-size:9px;line-height:15px;text-align:center;font-weight:600}
.bt-round:has(.bt-inbox-count){position:relative}
.bt-inbox-panel{position:absolute;top:46px;right:8px;z-index:40;width:312px;max-height:min(60vh,420px);overflow:auto;display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:12px;background:var(--bt-main);box-shadow:0 0 0 .5px var(--bt-line-2),0 12px 32px -8px rgba(0,0,0,.24)}
.bt-inbox-head{display:flex;align-items:center;justify-content:space-between;padding:0 2px 2px}
.bt-inbox-title{font-size:12px;font-weight:600;color:var(--bt-ink-2)}
.bt-inbox-x{border:0;background:none;color:var(--bt-ink-3);font-size:15px;line-height:1;padding:2px 4px;cursor:pointer}
.bt-inbox-x:hover{color:var(--bt-ink)}
.bt-inbox-empty{padding:10px 2px;color:var(--bt-ink-3);font-size:12px}
.bt-inbox-list{display:flex;flex-direction:column;gap:4px}
.bt-inbox-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:9px;background:color-mix(in srgb,var(--bt-ink) 3%,var(--bt-main))}
.bt-inbox-copy{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}
.bt-inbox-name{font-size:13px;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-inbox-from{font-size:11px;color:var(--bt-ink-3)}
.bt-inbox-actions{display:flex;align-items:center;gap:5px;flex:none}
.bt-inbox-note{font-size:11px;color:var(--bt-ink-3);overflow-wrap:anywhere}
`
