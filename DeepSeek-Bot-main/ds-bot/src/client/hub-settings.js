// The "Hub account" page in Bot settings.
//
// Uses the original settings building blocks — `SetSection`, `SetRow`, `bt-set-*`, `bt-field`,
// `bt-input`, `bt-soft` — so the page looks like the rest of settings instead of a second design
// system bolted on. The components are passed in rather than imported from settings.js, which
// would make the import a cycle.
//
// What this page must never do:
//   * show or keep the password past submit;
//   * show or hold a token or a device private key (the host never sends them);
//   * claim the phone number is verified — nothing verified it (no SMS in V1);
//   * imply the credentials live in an OS keychain, which the plugin cannot reach.
import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'

// A country code list short enough to be honest about: the field accepts any of these, and the
// number is normalized host-side, so the list is a convenience and not a validation.
const COUNTRY_CODES = ['+86', '+852', '+853', '+886', '+1', '+44', '+81', '+65', '+61']

const ErrorLine = ({ message }) => (message === undefined || message === ''
  ? null
  : h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, message))

// Where the credential is kept. Said plainly: the plan records that this is not an OS keychain
// (docs/g3/PLAN.md §0), and a settings page that implied otherwise would be a lie the user
// cannot check.
const storageNote = backend => (backend === 'credentials'
  ? 'The device key is kept in the Harness credential store (owner-only file).'
  : 'The device key is kept in an owner-only file in the Bot data folder.')

export function HubAccountPage({ actions, run, Section, Row }) {
  // The page loads its own state rather than reading a field the roster does not have. That
  // keeps the Hub's state entirely out of the original team's index, which is the same
  // separation the whole domain follows.
  const [hub, setHub] = useState({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    // No await on the original team: this is the only request the page makes on open, and a Hub
    // that is down only changes what the page says.
    Promise.resolve(actions.hubState())
      .then((value) => { if (live) setHub(value ?? {}) })
      .catch(() => { if (live) setHub({ loggedIn: false, unreachable: true }) })
      .then(() => { if (live) setLoaded(true) })
    return () => { live = false }
  }, [])

  // Whether a recovery code exists, once signed in. Loaded separately so a Hub that is down leaves
  // the main page working and only this row unknown.
  useEffect(() => {
    if (hub.loggedIn !== true) return undefined
    void loadRecoveryState()
    return undefined
  }, [hub.loggedIn])

  const reload = async () => {
    try { setHub(await actions.hubState() ?? {}) } catch { setHub({ loggedIn: false, unreachable: true }) }
  }

  const [baseUrl, setBaseUrl] = useState('')
  const [dialCode, setDialCode] = useState('+86')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [registering, setRegistering] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [devices, setDevices] = useState(undefined)
  // Password recovery. A separate mode of the same page rather than a new one: recovery is a way
  // to become signed in, which is what this page is for.
  const [recovering, setRecovering] = useState(false)
  const [recoveryCode, setRecoveryCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNew, setConfirmNew] = useState('')
  // A freshly created recovery code, shown once and then cleared: the Hub keeps only a digest, so
  // there is no way to display it again and the page must not imply otherwise.
  const [freshCode, setFreshCode] = useState('')
  const [hasCode, setHasCode] = useState(undefined)

  // `account.baseUrl` arrives with the fetched state; the editable field keeps its own value
  // once a person starts typing.
  useEffect(() => {
    if (hub.account?.baseUrl !== undefined && baseUrl === '') setBaseUrl(hub.account.baseUrl)
  }, [hub.account?.baseUrl])

  const account = hub.account
  const loggedIn = hub.loggedIn === true

  // The password fields are cleared on every outcome, success or failure: a value that survives
  // a failed attempt ends up in a screenshot or a shoulder.
  const clearSecrets = () => {
    setPassword('')
    setConfirm('')
    setNewPassword('')
    setConfirmNew('')
  }

  const submit = async (mode) => {
    if (mode === 'register' && password !== confirm) {
      setError(t('The two passwords do not match.'))
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const value = await run(actions.hubSubmit({
        mode,
        baseUrl: baseUrl.trim(),
        phone: `${dialCode}${phone.replace(/[\s()-]/g, '')}`,
        password,
      }))
      if (value !== false) setNotice(mode === 'register' ? t('Account created.') : t('Signed in.'))
      await reload()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      clearSecrets()
      setBusy(false)
      setRegistering(false)
    }
  }

  // Signed out, holding a recovery code. This is the path for a machine that was lost or
  // re-installed, where there is no session left to change a password with.
  const submitRecovery = async () => {
    if (newPassword !== confirmNew) {
      setError(t('The two passwords do not match.'))
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await run(actions.hubRecover({
        baseUrl: baseUrl.trim(),
        phone: `${dialCode}${phone.replace(/[\s()-]/g, '')}`,
        code: recoveryCode,
        newPassword,
      }))
      setNotice(t('Password changed. Every other session was signed out.'))
      await reload()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      clearSecrets()
      setRecoveryCode('')
      setBusy(false)
      setRecovering(false)
    }
  }

  const changePassword = async () => {
    if (newPassword !== confirmNew) {
      setError(t('The two passwords do not match.'))
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await run(actions.hubChangePassword({ currentPassword: password, newPassword }))
      setNotice(t('Password changed. Every other session was signed out.'))
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      clearSecrets()
      setBusy(false)
    }
  }

  const makeRecoveryCode = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const value = await run(actions.hubCreateRecoveryCode())
      setFreshCode(value?.code ?? '')
      setHasCode(true)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }

  const loadRecoveryState = async () => {
    try {
      const value = await run(actions.hubRecoveryState())
      setHasCode(value?.hasCode === true)
    } catch { /* the page already shows a Hub problem elsewhere; a second one adds nothing */ }
  }

  const loadDevices = async () => {
    setBusy(true)
    setError('')
    try {
      const value = await run(actions.hubDevices())
      setDevices(value?.devices ?? [])
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (deviceId) => {
    setBusy(true)
    setError('')
    try {
      await run(actions.hubRevokeDevice(deviceId))
      const value = await run(actions.hubDevices())
      setDevices(value?.devices ?? [])
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    setBusy(true)
    setError('')
    try {
      await run(actions.hubLogout())
      setDevices(undefined)
      setNotice(t('Signed out. Local Bots work as before.'))
      await reload()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }

  const sections = [
    h(Section, { key: 'node', title: t('Hub node') },
      h(Row, { label: t('Address'), hint: t('Leave empty to use this Bot team locally only.') },
        h('input', {
          className: 'bt-input', type: 'url', value: baseUrl, placeholder: 'https://127.0.0.1:7788',
          disabled: loggedIn || busy, onChange: event => setBaseUrl(event.target.value),
        })),
      h(Row, { label: t('Connection'), hint: t('Passwords are only sent over TLS.') },
        h('span', { className: 'bt-set-hint' }, loggedIn ? t('Signed in') : t('Not signed in')))),
  ]

  if (!loggedIn) {
    sections.push(h(Section, { key: 'sign-in', title: t('Sign in') },
      h(Row, { label: t('Phone number'), hint: t('Used as your sign-in name. It is not verified — this Hub sends no SMS.') },
        h('div', { className: 'bt-set-control' },
          h('select', { className: 'bt-input', value: dialCode, style: { width: 90 }, disabled: busy, onChange: event => setDialCode(event.target.value) },
            COUNTRY_CODES.map(code => h('option', { key: code, value: code }, code))),
          h('input', {
            className: 'bt-input', type: 'tel', value: phone, placeholder: '13800138000', disabled: busy,
            onChange: event => setPhone(event.target.value),
          }))),
      h(Row, { label: t('Password'), hint: t('At least 10 characters. Kept only on this machine while signing in.') },
        h('input', {
          className: 'bt-input', type: 'password', value: password, autoComplete: 'current-password', disabled: busy,
          onChange: event => setPassword(event.target.value),
        })),
      registering
        ? h(Row, { label: t('Confirm password') },
          h('input', {
            className: 'bt-input', type: 'password', value: confirm, autoComplete: 'new-password', disabled: busy,
            onChange: event => setConfirm(event.target.value),
          }))
        : null,
      h(Row, { label: '' }, h('div', { className: 'bt-actions' },
        h('button', {
          type: 'button', className: 'bt-soft', disabled: busy,
          onClick: () => { void submit('login') },
        }, t('Sign in')),
        h('button', {
          type: 'button', className: 'bt-soft', disabled: busy,
          onClick: () => { if (registering) void submit('register'); else setRegistering(true) },
        }, registering ? t('Create account') : t('Create an account')))),
      // The recovery path. Without it an account is simply unrecoverable — there is no SMS and no
      // email — and once the Hub holds real workgroup history that means losing it.
      h(Row, {
        label: t('Forgot your password?'),
        hint: t('Use a recovery code. If you never created one, only the operator of the Hub can reset the password from its command line.'),
      },
      h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
        onClick: () => { setRecovering(!recovering); setError(''); setNotice('') },
      }, recovering ? t('Cancel') : t('Use a recovery code'))),
      recovering
        ? h(Row, {
          label: t('Recovery code'),
          hint: t('The 16 characters created while signed in. Hyphens and spaces are ignored.'),
        },
        h('input', {
          className: 'bt-input', type: 'text', value: recoveryCode, placeholder: 'XXXX-XXXX-XXXX-XXXX',
          autoComplete: 'off', spellCheck: false, disabled: busy,
          onChange: event => setRecoveryCode(event.target.value),
        }))
        : null,
      recovering
        ? h(Row, { label: t('New password') },
          h('input', {
            className: 'bt-input', type: 'password', value: newPassword, autoComplete: 'new-password', disabled: busy,
            onChange: event => setNewPassword(event.target.value),
          }))
        : null,
      recovering
        ? h(Row, { label: t('Confirm new password') },
          h('input', {
            className: 'bt-input', type: 'password', value: confirmNew, autoComplete: 'new-password', disabled: busy,
            onChange: event => setConfirmNew(event.target.value),
          }))
        : null,
      recovering
        ? h(Row, { label: '' },
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => { void submitRecovery() } }, t('Recover account')))
        : null))
  } else {
    sections.push(h(Section, { key: 'account', title: t('This account') },
      h(Row, { label: t('Phone number') }, h('span', { className: 'bt-set-hint' }, account?.phoneMasked ?? '—')),
      h(Row, { label: t('Hub user ID') }, h('span', { className: 'bt-set-hint', style: { userSelect: 'all' } }, account?.hubUserId ?? '—')),
      h(Row, { label: t('This device') }, h('span', { className: 'bt-set-hint' }, account?.deviceId ?? '—')),
      h(Row, { label: t('Credential storage'), hint: storageNote(hub.backend) },
        h('span', { className: 'bt-set-hint' }, hub.storage ?? '—')),
      h(Row, { label: '' },
        h('div', { className: 'bt-actions' },
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => { void loadDevices() } }, t('Show devices')),
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => { void signOut() } }, t('Sign out'))))),
      // Changing the password while signed in: the ordinary case, and the one that also gives a
      // person a chance to create a recovery code *before* they need it.
      h(Section, { key: 'password', title: t('Password') },
        h(Row, { label: t('Current password') },
          h('input', {
            className: 'bt-input', type: 'password', value: password, autoComplete: 'current-password', disabled: busy,
            onChange: event => setPassword(event.target.value),
          })),
        h(Row, { label: t('New password'), hint: t('At least 10 characters.') },
          h('input', {
            className: 'bt-input', type: 'password', value: newPassword, autoComplete: 'new-password', disabled: busy,
            onChange: event => setNewPassword(event.target.value),
          })),
        h(Row, { label: t('Confirm new password') },
          h('input', {
            className: 'bt-input', type: 'password', value: confirmNew, autoComplete: 'new-password', disabled: busy,
            onChange: event => setConfirmNew(event.target.value),
          })),
        h(Row, { label: '', hint: t('Changing the password signs out every other device.') },
          h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => { void changePassword() } }, t('Change password')))),
      // Recovery codes. The code is displayed once and cannot be looked up later, so the copy says
      // so instead of letting someone assume they can come back for it.
      h(Section, { key: 'recovery', title: t('Recovery codes') },
        h(Row, {
          label: hasCode === true ? t('You have an unused recovery code.') : t('You have no recovery code.'),
          hint: hasCode === true
            ? t('Creating a new code does not cancel the old one. Each code works once.')
            : t('Without one, a forgotten password can only be reset by the Hub operator.'),
        },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { void makeRecoveryCode() } }, t('Create a recovery code'))),
        freshCode === ''
          ? null
          : h(Row, {
            label: t('Your new recovery code'),
            // Said plainly, because a user who assumes it can be looked up later will lose it.
            hint: t('Copy it now and keep it somewhere safe. It is shown only this once.'),
          },
          h('span', { className: 'bt-set-hint', style: { userSelect: 'all', fontFamily: 'monospace', fontSize: 15, letterSpacing: '0.08em' } }, freshCode))),
      h(Section, { key: 'devices', title: t('Devices') },
        devices === undefined
          ? h(Row, { label: t('Not loaded yet.'), hint: t('Show devices lists every machine signed in to this account.') })
          : devices.length === 0
            ? h(Row, { label: t('No devices.') })
            : devices.map(device => h(Row, {
              key: device.deviceId,
              label: device.name,
              hint: `${device.platform ?? ''}${device.current ? ` · ${t('this device')}` : ''}`,
            },
            h('button', {
              type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
              onClick: () => { void revoke(device.deviceId) },
            }, device.current ? t('Sign out this device') : t('Revoke'))))))
  }

  if (!loaded) return [h(Section, { key: 'loading', title: t('Hub account') }, h(Row, { label: t('Loading…') }))]

  return [
    ...sections,
    error === '' ? null : h('div', { key: 'error' }, h(ErrorLine, { message: error })),
    notice === '' ? null : h('div', { key: 'notice', className: 'bt-set-hint', style: { padding: '0 14px 10px' } }, notice),
  ]
}
