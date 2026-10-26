import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isMainOf } from './sources.js'
import { currentPart } from './text.js'
import { GearIcon, PinIcon, UnreadIcon, PencilIcon, StarLineIcon, CopyIcon, HideIcon, TrashIcon, DuplicateIcon, ArrowUpIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { useViewport, viewBottom } from './motion.js'
import { t } from './i18n.js'

export function ContextMenu({ menu, roster, actions, leaving = false }) {
  useEscape(() => actions.closeMenu())
  useEffect(() => {
    const onDown = (event) => { if (!(event.target instanceof Element) || !event.target.closest('.bt-menu')) actions.closeMenu() }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])
  const ref = useRef(null)
  const [place, setPlace] = useState({ left: menu.x, top: menu.y })
  const tick = useViewport()
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    setPlace({ left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(menu.y, viewBottom() - box.height - 8)) })
  }, [menu.x, menu.y, tick])
  if (menu.kind === 'agent' || menu.kind === 'agent-session') return h(AgentMenu, { menu, roster, actions, leaving })
  const bot = roster.byId[menu.id]
  const room = roster.roomsById[menu.id]
  const entry = bot ?? room
  if (entry === undefined) return null
  // A workgroup row is shown in this same list on purpose: the plan reuses the original
  // group UI rather than growing a second one. But a workgroup is NOT a local group — its
  // id is not in `state.rooms`, and its changes go through `api/workgroup`. Calling the
  // local actions with a workgroup id answered "Unknown group chat", so the entries below
  // branch on `entry.workgroup`, which `sources.js` sets for exactly this purpose.
  const workgroup = room !== undefined && room.workgroup === true
  const isMainBot = isMainOf(roster, menu.id)
  const isTile = roster.mainBotId === menu.id
  const mainCount = (roster.mainBotIds ?? []).length
  const groups = [
    [
      isTile ? null : [entry.pinned ? t('Unpin') : t('Pin'), PinIcon, () => actions.setFlags(menu.id, { pinned: !entry.pinned })],
      [t('Mark as Unread'), UnreadIcon, () => actions.markUnread(menu.id)],
    ],
    [
      bot ? [t('Rename Bot'), PencilIcon, () => actions.renameBot(bot.id)] : null,
      bot ? [t('Edit Bot'), GearIcon, () => actions.openSettings('bots', bot.id)] : null,
      room && !workgroup ? [t('Group settings'), GearIcon, () => actions.openSettings('groups', room.id)] : null,
      workgroup ? [t('Workgroup settings'), GearIcon, () => actions.openWorkgroupSettings(room.id)] : null,
      room ? [t('Rename group'), PencilIcon, () => (workgroup ? actions.renameWorkgroup(room.id) : actions.renameBot(room.id))] : null,
      // Upgrading creates a LINKED workgroup; it never changes this group's type and never
      // uploads its history. A workgroup has nothing to upgrade.
      room && !workgroup && actions.upgradeRoom ? [t('Upgrade to a workgroup'), ArrowUpIcon, () => actions.upgradeRoom(room.id)] : null,
      bot ? [t('Duplicate'), DuplicateIcon, async () => { const copy = await actions.duplicateBot(bot.id); actions.openSession(copy.id) }] : null,
      bot && !isMainBot ? [t('Make Main Bot'), StarLineIcon, () => actions.setMain(bot.id, true)] : null,
      bot && isMainBot && mainCount > 1 ? [t('Remove Main Bot role'), StarLineIcon, () => actions.setMain(bot.id, false)] : null,
    ],
    [[t('Copy conversation ID'), CopyIcon, () => navigator.clipboard?.writeText(bot ? currentPart(bot) : menu.id)]],
    [
      isMainBot ? null : [t('Hide from sidebar'), HideIcon, () => actions.setFlags(menu.id, { hidden: true })],
      isMainBot ? null : [room ? t('Delete group') : t('Delete'), TrashIcon, () => (bot ? actions.deleteBot(bot.id) : workgroup ? actions.deleteWorkgroup(menu.id) : actions.deleteRoom(menu.id)), true],
    ],
  ].map(group => group.filter(Boolean)).filter(group => group.length > 0)
  return h('div', { ref, className: 'bt-menu', role: 'menu', 'aria-label': t('{name} actions', { name: bot?.name ?? room.name }), style: place, 'data-leaving': leaving || undefined },
    groups.map((group, index) => h(Fragment, { key: index },
      index > 0 ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
      group.map(([label, Icon, run, danger]) => h('button', {
        key: label, type: 'button', role: 'menuitem', className: danger ? 'bt-danger' : undefined,
        onClick: () => { actions.closeMenu(); void Promise.resolve(run()).catch(error => actions.reportError(error, 'menu')) },
      }, h(Icon), label)))))
}

// Menus for the DSH Agent row and its Sessions; none of the Bot entries apply.
function AgentMenu({ menu, roster, actions, leaving }) {
  const ref = useRef(null)
  const [place, setPlace] = useState({ left: menu.x, top: menu.y })
  const tick = useViewport()
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    setPlace({ left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(menu.y, viewBottom() - box.height - 8)) })
  }, [menu.x, menu.y, tick])
  const agent = roster.agentsById[menu.kind === 'agent' ? menu.id : menu.agentId]
  if (agent === undefined) return null
  const groups = menu.kind === 'agent'
    ? [
        [
          [agent.pinned ? t('Unpin') : t('Pin'), PinIcon, () => actions.setFlags(agent.id, { pinned: !agent.pinned })],
        ],
        [
          [t('Remove DSH Agent'), TrashIcon, () => actions.removeAgent(agent.id), true],
        ],
      ]
    : [
        [
          [t('Rename'), PencilIcon, () => actions.beginAgentRename(menu.id)],
        ],
        [
          [t('Archive'), TrashIcon, () => actions.archiveAgentSession(agent.id, menu.id), true],
        ],
      ]
  return h('div', { ref, className: 'bt-menu', role: 'menu', 'aria-label': menu.kind === 'agent' ? 'DSH Agent' : t('Session actions'), style: place, 'data-leaving': leaving || undefined },
    groups.map((group, index) => h(Fragment, { key: index },
      index > 0 ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
      group.map(([label, Icon, run, danger]) => h('button', {
        key: label, type: 'button', role: 'menuitem', className: danger ? 'bt-danger' : undefined,
        onClick: () => { actions.closeMenu(); void Promise.resolve(run()).catch(error => console.warn('[ds-bot]', error)) },
      }, h(Icon), label)))))
}
