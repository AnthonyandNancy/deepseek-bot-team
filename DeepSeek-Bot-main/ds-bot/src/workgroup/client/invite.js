// Inviting a colleague into a workgroup (plan §5.1: the copied group settings' job includes 邀请).
//
// The control is ALWAYS on screen. That is a deliberate reversal of the G4/G5 version, where the
// member list rendered nothing at all unless the room had a Hub identity (`MemberList` returned null
// when `hub === null`), so a person on a machine that was not signed in saw no invite control and no
// reason for its absence. A control that disappears cannot explain itself.
//
// What each state looks like:
//
//   ready       the group is on the Hub — type a phone number or a Hub user id and press Invite
//   signed-out  nothing to invite with; the field stays, the button is disabled, and the note says
//               why and offers the one action that fixes it
//   not-on-hub  the room has no Hub identity (a group made by an older build); the note says so
//
// The invite itself goes through the domain's own route (`api/workgroup`, endpoint `invite-member`),
// never the original's, so a workgroup invite can never be mistaken for a local-team action.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { t } from '../../client/i18n.js'
import { callWorkgroup } from './api.js'
// The one piece of this component worth testing on its own lives in its own module.
import { inviteTarget } from './invite-target.js'

export { inviteTarget }

export function WorkgroupInviteRow({ room, onInvited }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const [state, setState] = useState({ loading: true })

  const workgroupId = room?.hubWorkgroupId

  // Whether this machine can invite at all. `hub-state` is the same call the account page makes, so
  // the answer here cannot disagree with what the settings page shows.
  const load = useCallback(async () => {
    try {
      const answer = await callWorkgroup('hub-state')
      setState({ loading: false, loggedIn: answer?.loggedIn === true })
    } catch {
      // A Hub this plugin cannot reach is the same situation as signed out, for this control.
      setState({ loading: false, loggedIn: false })
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const canInvite = workgroupId !== undefined && state.loggedIn === true
  const reason = workgroupId === undefined
    ? t('This group is not on the Hub, so there is nobody to invite yet.')
    : state.loading
      ? null
      : state.loggedIn ? null : t('Sign in to the Hub first: an invite names an account on the Hub.')

  const invite = async () => {
    const target = inviteTarget(value)
    if (busy || (target.phone === undefined && target.hubUserId === undefined)) return
    setBusy(true)
    setNote(null)
    try {
      const sent = await callWorkgroup('invite-member', { workgroupId, ...target })
      // The masked phone is what the Hub returns; showing it confirms WHO was invited without
      // repeating a full number on screen.
      setNote(t('Invited {phone}.', { phone: sent?.inviteePhoneMasked ?? '' }))
      setValue('')
      onInvited?.()
    } catch (error) {
      // The Hub's own sentence, not a generic failure: "no account matches that person" and "already
      // invited" are different problems with different next steps.
      setNote(error?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  return h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack bt-wg-invset', 'data-invite': canInvite ? 'ready' : 'blocked' },
    h('span', { className: 'bt-set-copy' },
      h('span', { className: 'bt-bs-label' }, t('Invite a colleague')),
      h('span', { className: 'bt-set-hint' }, t('Their phone number, or their Hub user id.'))),
    h('div', { className: 'bt-wg-invset-field' },
      h('input', {
        className: 'bt-input',
        value,
        type: 'text',
        autoComplete: 'off',
        placeholder: t('Phone number or Hub user id'),
        'aria-label': t('Phone number or Hub user id'),
        disabled: !canInvite || busy,
        onChange: event => setValue(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter' && canInvite) void invite() },
      }),
      h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        disabled: !canInvite || busy || value.trim() === '',
        onClick: invite,
      }, busy ? t('Inviting…') : t('Invite'))),
    // The reason is shown even while the field is disabled, so "why can I not do this" always has an
    // answer on screen next to the control.
    reason === null ? null : h('span', { className: 'bt-set-hint bt-wg-invset-reason', role: 'status' }, reason),
    note === null ? null : h('span', { className: 'bt-set-hint bt-wg-invset-note', role: 'status' }, note))
}
