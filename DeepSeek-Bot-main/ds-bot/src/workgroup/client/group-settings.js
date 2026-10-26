// COPY OF THE ORIGINAL (`src/client/group-settings.js`, 180 lines at the time of copying).
//
// Plan §5.1 lists this file in the "copy and keep equivalent" set, with the changes it expects:
// "真人角色/邀请/Hub/群记忆/退出" — real people, INVITES, Hub, group memory, leaving. Until now no copy
// existed, so a workgroup could only be shown the original settings form, which knows nothing about
// inviting a person (its member picker offers this machine's own Bots and nothing else).
//
// What differs from the original, and nothing else:
//   1. the members card ends with `WorkgroupInviteRow`, which invites a person by phone number or
//      Hub user id;
//   2. `NewGroupForm` is NOT copied: creating a local group belongs to the original settings page,
//      and a workgroup is created from the new-chat composer.
// `GROUP_SETTINGS_CSS` is not re-exported either: the original stylesheet is already installed once by
// src/client/index.js, and a second copy would be a second thing to keep in step.
//
// Everything else is the original text. `actions.updateRoom`/`deleteRoom`/`setFlags` already route
// a workgroup id to this domain (src/client/index.js), so those calls need no change here.
import { createElement as h, useEffect, useState } from 'react'
import { isMainOf } from '../../client/sources.js'
import { PlusIcon, ChevronRightIcon } from '../../client/icons.js'
// `AdminStar` came from the original alongside the rest; it was only used by `NewGroupForm`, which this
// copy does not include, so it is not imported.
import { BotAvatar, BotMark, RoomAvatar } from '../../client/mark.js'
import { Card, Row, InlineText, SwitchRow } from '../../client/bot-settings.js'
import { Segmented } from '../../client/motion.js'
import { FolderMenu } from '../../client/folder-menu.js'
import { PermissionPicker } from '../../client/permission-picker.js'
import { t } from '../../client/i18n.js'
import { WorkgroupInviteRow } from './invite.js'
import { ApprovalCards } from './tasks.js'

export const ROOM_MODES = [
  ['admin', 'Admin leads', 'Plain messages go to the admin, who calls others with @Name.'],
  ['everyone', 'Everyone', 'Every member answers in turn, admin first.'],
]

// A workgroup's member list is already a list of RECORDS (`{ id, name, kind }`) and its admin is
// `adminId`; the local-team form this was copied from uses ids plus `room.admin`. Reading the local
// shape here silently dropped every member row and printed "No admin" for a workgroup that has one.
// This normalises both shapes in one place, leaving the original form's contract untouched.
const memberRecords = (room, roster) => (room.members ?? [])
  .map(member => (member !== null && typeof member === 'object' ? member : roster.byId[member]))
  .filter(Boolean)
const adminIdOf = room => room.adminId ?? room.admin ?? null
const adminOf = (room, roster) => {
  const id = adminIdOf(room)
  return id === null ? undefined : roster.byId[id] ?? memberRecords(room, roster).find(member => member.id === id)
}

// Without an admin the host answers as everyone, whatever the stored mode says.
export const shownMode = (room, roster) => (adminOf(room, roster) ? room.mode : 'everyone')

export function roomSubtitle(room, roster) {
  const admin = adminOf(room, roster)
  return [t('{count} members', { count: memberRecords(room, roster).length }), admin ? t('Admin {name}', { name: admin.name }) : t('No admin')].join(' · ')
}

// One preset for every member in the group, or each member's own. Turning it on starts
// from DSH's default preset.
function GroupPermission({ room, catalog, update }) {
  if (!catalog?.options?.length) return null
  const shared = room.permission !== undefined
  return h(Card, { title: t('Permissions') },
    h(SwitchRow, {
      label: t('Same for every member'), hint: t("Replaces each member's own permissions in this group."), on: shared,
      onChange: on => update({ permission: on ? catalog.defaultPreset ?? catalog.options[0].value : null }),
    }),
    shared ? h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack bt-gs-perm bt-veil' },
      h(PermissionPicker, { catalog, saved: room.permission, onPick: permission => update({ permission }) })) : null)
}

// One guard a group keeps: how many Bot turns may answer Bot calls since the user
// last wrote in it, after which the group pauses until the user goes on or writes.
function RelayLimitRow({ room, update }) {
  const [draft, setDraft] = useState(room.relayLimit ?? '')
  useEffect(() => setDraft(room.relayLimit ?? ''), [room.relayLimit])
  const save = () => {
    const text = String(draft).trim()
    if (text === '') {
      if (room.relayLimit !== undefined && room.relayLimit !== null) update({ relayLimit: null })
      return
    }
    const limit = Number(text)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || limit === room.relayLimit) { setDraft(room.relayLimit ?? ''); return }
    update({ relayLimit: limit })
  }
  return h(Row, { label: t('Pause Bot relays after'), hint: t('Counted since your last message in this group.') },
    h('input', {
      className: 'bt-bs-input bt-bs-num', type: 'number', min: 1, max: 200,
      placeholder: String(room.relayLimitDefault ?? ''), value: draft,
      'aria-label': t('Pause Bot relays after'),
      onChange: event => setDraft(event.target.value),
      onBlur: save,
      onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } },
    }))
}

// A group chat's settings as grouped cards: its name and notice, who answers, its
// members and admin, its permissions, its sidebar place, and deleting it. The user may
// change all of it; the host enforces what Bots may change.
export function GroupSettingsForm({ room, roster, actions, run, onDeleted }) {
  const [adding, setAdding] = useState(false)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  const members = memberRecords(room, roster)
  const memberIds = new Set(members.map(member => member.id))
  const outside = roster.bots.filter(bot => !memberIds.has(bot.id))
  const admin = adminOf(room, roster)
  const mode = shownMode(room, roster)
  const modeHint = ROOM_MODES.find(([id]) => id === mode)?.[2] ?? ''
  const update = patch => run(actions.updateRoom(room.id, patch))
  const openBot = (id) => { actions.closeSettings(); actions.openSession(id) }
  const remove = () => {
    if (!confirming) { setConfirming(true); return }
    void Promise.resolve(run(actions.deleteRoom(room.id))).then((done) => { if (done) onDeleted?.() })
  }
  return h('div', { className: 'bt-bs' },
    h('div', { className: 'bt-bs-hero' },
      h(RoomAvatar, { room, roster, size: 64 }),
      h('div', { className: 'bt-bs-who' },
        h('span', { className: 'bt-bs-name' }, room.name),
        h('span', { className: 'bt-bs-sub' }, roomSubtitle(room, roster)))),
    h(Card, { title: t('Profile') },
      h(Row, { label: t('Name'), hint: t('Leave it empty to name the group after its members.') },
        h(InlineText, { label: t('Group name'), value: room.named ? room.name : '', placeholder: t('Name after members'), maxLength: 60, onSave: name => update({ name }) })),
      h(Row, { label: t('Notice'), hint: t('Every member reads it before speaking in this group.'), stack: true },
        h(InlineText, { label: t('Group notice'), value: room.notice, multiline: true, maxLength: 2000, placeholder: t('Shared instructions every member reads before speaking…'), onSave: notice => update({ notice }) }))),
    h(Card, { title: t('Who answers') },
      h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
        h(Segmented, { label: t('Who answers'), value: mode }, ROOM_MODES.map(([id, label]) => h('button', {
          key: id, type: 'button', 'aria-pressed': mode === id, disabled: id === 'admin' && !admin,
          title: id === 'admin' && !admin ? t('Choose an admin first') : undefined,
          onClick: () => { if (mode !== id) void update({ mode: id }) },
        }, t(label)))),
        h('span', { key: mode, className: 'bt-set-hint bt-veil' }, `${t(modeHint)} ${t('@mentions always pick who answers.')}`))),
    // The group's one guard, copied from the original's RelayLimitRow: how many Bot
    // turns may answer Bot calls since the user last wrote, before the group pauses.
    h(Card, { title: t('Bot relays') },
      h(RelayLimitRow, { room, update })),
    h(Card, { title: t('Working folder') },
      h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Folder'))),
        h(FolderMenu, { value: room.workDir, group: true, actions, run, onPick: workDir => update({ workDir }) }))),
    h(GroupPermission, { room, catalog: roster.permissions, update }),
    h(Card, { title: t('Members · {count}', { count: members.length }) },
      members.map((member) => {
        const leads = adminIdOf(room) === member.id
        return h('div', { key: member.id, className: 'bt-set-row bt-bs-row bt-gs-member' },
          h('button', { type: 'button', className: 'bt-gs-who', title: t("Open {name}'s chat", { name: member.name }), onClick: () => openBot(member.id) },
            h(BotAvatar, { bot: member, size: 26, main: isMainOf(roster, member.id), admin: leads, live: false }),
            h('span', { className: 'bt-row-title' }, member.name),
            leads ? h('span', { className: 'bt-tag' }, t('Admin')) : null),
          leads
            ? h('button', { type: 'button', className: 'bt-mini', title: t('Leave the group without an admin'), onClick: () => update({ admin: null }) }, t('Unset'))
            : h('button', { type: 'button', className: 'bt-mini', onClick: () => update({ admin: member.id }) }, t('Make admin')),
          members.length > 2 ? h('button', { type: 'button', className: 'bt-x', 'aria-label': t('Remove {name} from the group', { name: member.name }), title: t('Remove from group'), onClick: () => update({ remove: [member.id] }) }, '×') : null)
      }),
      adding
        ? [...outside.map(bot => h('button', { key: bot.id, type: 'button', className: 'bt-set-row bt-bs-row bt-gs-pick', onClick: () => { setAdding(false); void update({ add: [bot.id] }) } },
            h(BotMark, { bot, size: 22 }),
            h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, bot.name)),
            h('span', { className: 'bt-set-hint' }, t('Add')))),
          h('button', { key: 'cancel', type: 'button', className: 'bt-set-row bt-bs-row bt-gs-add', onClick: () => setAdding(false) }, t('Cancel'))]
        : outside.length > 0
          ? h('button', { type: 'button', className: 'bt-set-row bt-bs-row bt-gs-add', onClick: () => setAdding(true) }, h(PlusIcon), t('Add member'))
          : null,
      // —— DIFFERS FROM THE ORIGINAL (plan §5.1: 邀请) ——
      // Directly below "Add member", because that is where a person looks for it: adding a Bot and
      // inviting a colleague are the same intent. Always rendered, even when this machine cannot
      // invite yet, so the reason is on screen instead of the control simply being absent.
      h(WorkgroupInviteRow, { room }),
      h('div', { className: 'bt-set-row bt-gs-note' }, h('span', { className: 'bt-set-hint' },
        // The host checks for two members on every change, even a rename.
        members.length < 2 ? t('Add a Bot first: a group chat needs at least two.')
          : admin ? t('{name} leads this group: it can call members with @Name, change the group, and post here.', { name: admin.name })
            : t('No admin yet. An admin can call members with @Name, change the group, and post here.')))),
    // —— DIFFERS FROM THE ORIGINAL (G5:审批可达) ——
    // Work another person asked this machine to do. It lives here because this drawer is the one a
    // person actually reaches: opening a workgroup goes through the original conversation view, and
    // its gear opens this form. `ApprovalCards` renders nothing when there is nothing waiting.
    h(ApprovalCards, null),
    h(Card, { title: t('Sidebar') },
      h(SwitchRow, { label: t('Pin'), hint: t('Kept above the other chats.'), on: room.pinned === true, onChange: pinned => run(actions.setFlags(room.id, { pinned })) }),
      h(SwitchRow, { label: t('Hide from sidebar'), hint: t('Search still finds it.'), on: room.hidden === true, onChange: hidden => run(actions.setFlags(room.id, { hidden })) })),
    h(Card, { title: t('Manage') },
      h('button', { type: 'button', className: 'bt-set-row bt-bs-row bt-bs-danger', 'data-confirm': confirming || undefined, onClick: remove },
        h('span', { className: 'bt-set-copy' },
          h('span', { className: 'bt-bs-label' }, confirming ? t('Delete {name}?', { name: room.name }) : t('Delete group')),
          h('span', { className: 'bt-set-hint' }, confirming ? t('Click again to delete. Its history is archived.') : t('Removes the group chat. Its members stay on the team.'))),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))))
}

// `NewGroupForm` is deliberately NOT copied: creating a local group is the original settings
// page's job, and a workgroup is created from the new-chat composer. Nothing here needs it.
