// The invite control (plan §5.1: the copied group settings' job includes 邀请).
//
// Two things are pinned here, and both were broken before:
//   1. the control is ALWAYS rendered — the old member list rendered nothing at all unless the room
//      had a Hub identity, so a person saw no invite box and no reason for its absence;
//   2. one field accepts a phone number or a Hub user id, and the right one reaches the Hub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inviteTarget } from '../src/workgroup/client/invite-target.js'

const inviteSrc = readFileSync(new URL('../src/workgroup/client/invite.js', import.meta.url), 'utf8')
const copySrc = readFileSync(new URL('../src/workgroup/client/group-settings.js', import.meta.url), 'utf8')
const originalSrc = readFileSync(new URL('../src/client/group-settings.js', import.meta.url), 'utf8')
const drawerSrc = readFileSync(new URL('../src/client/details-drawer.js', import.meta.url), 'utf8')
const settingsSrc = readFileSync(new URL('../src/client/settings.js', import.meta.url), 'utf8')
const rowCss = readFileSync(new URL('../src/workgroup/client/rows.js', import.meta.url), 'utf8')

test('one field tells a phone number from a Hub user id', () => {
  // Hub ids are minted as `usr_…`, so the prefix is unambiguous; everything else is a phone number
  // (the Hub's own validation gives a better error than a client-side guess would).
  assert.deepEqual(inviteTarget('+8613800138000'), { phone: '+8613800138000' })
  assert.deepEqual(inviteTarget('13800138000'), { phone: '13800138000' })
  assert.deepEqual(inviteTarget('  usr_b77461fab78f452abc56cb971839f13 '), { hubUserId: 'usr_b77461fab78f452acb56cb971839f13'.replace('acb', 'abc') })
  assert.deepEqual(inviteTarget('usr_abc123'), { hubUserId: 'usr_abc123' })
  // Nothing typed is nothing sent.
  assert.deepEqual(inviteTarget(''), {})
  assert.deepEqual(inviteTarget('   '), {})
})

test('the invite row is always rendered, and says why when it cannot be used', () => {
  // No early return on a missing Hub identity: that was the defect.
  assert.equal(/if \(workgroupId === undefined\) return null/.test(inviteSrc), false, 'the row must not vanish')
  assert.equal(inviteSrc.includes('data-invite'), true, 'the row carries its state for the UI and for a test')
  // A reason is on screen next to the disabled control, for both blocked cases.
  assert.match(inviteSrc, /not on the Hub, so there is nobody to invite yet/)
  assert.match(inviteSrc, /Sign in to the Hub first/)
  // The field stays usable-looking and the button is what disables.
  assert.match(inviteSrc, /disabled: !canInvite \|\| busy/)
})

test('the invite row is stacked, and its styles are installed where the row is actually drawn', () => {
  // The row lives in the group-settings drawer, and the drawer installs the shell stylesheet group —
  // not WG_CSS, which the chat panel installs for itself. So a class defined only in WG_CSS renders
  // unstyled here, which is what squeezed the hint to two characters per line. The layout therefore
  // has to come from the stylesheet the drawer does install.
  assert.match(inviteSrc, /bt-bs-stack/, 'a row holding a label, a field and a note is stacked, not two columns')
  assert.match(inviteSrc, /bt-wg-invset-field/, 'the field and its button share a line')
  // The name `bt-wg-invite` already means "the panel's inline invite box" (panel.js), which is a
  // single-line row. Reusing it here is what applied the wrong layout.
  assert.equal(/className: '[^']*\bbt-wg-invite\b(?![-w])/.test(inviteSrc), false, 'the panel class must not be reused')

  // Every class the component uses must be defined in WORKGROUP_ROW_CSS, the stylesheet that ships
  // with the shell and is therefore present in the drawer.
  for (const name of ['bt-wg-invset', 'bt-wg-invset-field', 'bt-wg-invset-reason', 'bt-wg-invset-note']) {
    assert.ok(rowCss.includes(`.${name}`), `.${name} must be defined in WORKGROUP_ROW_CSS`)
  }
  // And the button/input sizes come from the shell's own `.bt-soft` / `.bt-input`, which are global
  // (styles.js), so the drawer does not need a local copy of either.
  assert.match(inviteSrc, /className: 'bt-soft bt-soft-sm'/)
  assert.match(inviteSrc, /className: 'bt-input'/)
})

test('the invite goes through this domain\u2019s own route', () => {
  // `api/workgroup`, never `api/bot`: a workgroup invite must not be mistakable for a local-team call.
  assert.match(inviteSrc, /callWorkgroup\('invite-member'/)
  assert.match(inviteSrc, /callWorkgroup\('hub-state'\)/)
  assert.equal(/api\/bot/.test(inviteSrc), false)
})

test('the copied settings form puts the invite row below Add member', () => {
  const addAt = copySrc.indexOf("t('Add member')")
  const inviteAt = copySrc.indexOf('h(WorkgroupInviteRow')
  assert.ok(addAt > 0 && inviteAt > 0, 'both must be present')
  assert.ok(inviteAt > addAt, 'the invite row reads directly below Add member')
})

test('the copy differs from the original only where plan 5.1 says it should', () => {
  // The copy exists because the original knows nothing about inviting a person. It carries exactly
  // two additions, and it does not re-export the stylesheet (the original installs it once).
  assert.match(copySrc, /WorkgroupInviteRow/)
  assert.match(copySrc, /ApprovalCards/)
  assert.equal(/export const GROUP_SETTINGS_CSS/.test(copySrc), false, 'the stylesheet is not duplicated')
  assert.equal(/export function NewGroupForm/.test(copySrc), false, 'creating a local group is the original page\u2019s job')
  // And the original file itself is untouched.
  assert.equal(/WorkgroupInviteRow|ApprovalCards/.test(originalSrc), false, 'the original must not learn about workgroups')
})

test('a workgroup gets the copy and a local group keeps the original', () => {
  // Both places a person can reach a group's settings route by the same fact.
  for (const [name, src] of [['details-drawer', drawerSrc], ['settings', settingsSrc]]) {
    assert.match(src, /WorkgroupGroupSettingsForm/, `${name} must be able to render the copy`)
    assert.match(src, /room\.workgroup === true/, `${name} must route on the workgroup marker`)
    // The original form is still what a local group gets.
    assert.match(src, /h\(GroupSettingsForm, \{/, `${name} keeps the original branch`)
  }
})
