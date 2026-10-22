// The workgroup client entry: the "Bot" top-level sidebar entry, and the panel it opens.
//
// Placement follows the evidence in docs/g1/slot-probe.md:
//   * `sidebar.panellist` is the official top-level nav slot (`kind: 'list'`), and the
//     shipped "plugins" entry is registered into it with `id: 'plugins'`, `order: 0`;
//     the scheduled-tasks entry uses `order: 10`.
//   * So this entry registers into the SAME slot with an `order` between them, which
//     puts it directly below "plugins" without touching that entry or the shell.
//   * Its `id` must match a panel registered in the keyed `main` slot, or selecting it
//     throws (layout/lib/client.js guards this), so both are registered together.
//
// Nothing here replaces an original slot: the local team's own surfaces come from
// src/client/, which stays untouched.
import { createElement as h, useEffect } from 'react'
import { BotPanel, refreshWorkgroups } from './panel.js'

// The rail entry's id, which must also be a keyed `main` key (layout refuses otherwise).
export const PANEL_ID = 'workgroup-bot'
// The workgroup panel's own `main` key. It has no rail entry: it is reached from the
// Bot sidebar's workgroup rows, so it never appears as a second first-level icon.
export const WG_PANEL_KEY = 'workgroup-room'
// Between plugins (0) and schedules (10), i.e. directly below "plugins".
export const PANEL_ORDER = 5

// A small mark for the nav rail. Kept text-free so it needs no locale entry.
function BotPanelIcon({ size = 18 }) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true,
  },
  h('path', { d: 'M6 7V5.5A1.5 1.5 0 0 1 7.5 4h5A1.5 1.5 0 0 1 14 5.5V7' }),
  h('rect', { x: 3.5, y: 7, width: 13, height: 9, rx: 2 }),
  h('path', { d: 'M7.5 10.5h.01M12.5 10.5h.01' }))
}

// `ctx` is the client plugin context. Registers the nav entry and the panel, and
// returns one disposer that withdraws both.
//
// Both shapes are copied from the shipped plugin-manager entry
// (dsh-client-ui-plugin-manager lib/client.js:4411 and :4477), which is the only
// known-good pair of registrations to compare against:
//
//   // the panel in the ROOT-scoped keyed `main` slot — note `key`, not `id`
//   ctx.slots.inject("main", function* () {
//     const handle = createNavigationStore(), instance = handle.create()
//     yield ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS,
//                                store: {...handle, create: () => instance}, ... })
//   })
//   // the nav row in the list slot
//   ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
//     name: "sidebar.panellist", id: PANEL_ID, order: 0,
//     label: () => t("panel"), locale: NS }))
//
// Two details are easy to get wrong and both silently produce "nothing appears":
// the keyed slot addresses its entry by `key` (an `id` there registers nothing), and
// the outlet needs a `locale` to scope the row. A `store` is also required for the
// panel to have any state of its own.
export function installWorkgroupClient(ctx, { roster, onEnterBot } = {}) {
  const disposers = []
  const problems = []

  const attempt = (label, install) => {
    try {
      disposers.push(install())
    } catch (error) {
      // Never silent: a shape this DSH version rejects must be visible in the console,
      // not just absent from the UI.
      problems.push(`${label}: ${error?.message ?? error}`)
      console.error(`[ds-bot] workgroup client could not install ${label}`, error)
    }
  }

  // What the "Bot" rail entry does.
  //
  // The user asked for this entry to open **DS Bot itself**, not a panel of its own: the
  // Bot team, its private chats, its local groups — and, in the sidebar, its workgroups.
  // So the keyed `main` entry is a *door*, not a destination:
  //
  //   1. the rail's click selects this key (layout requires a `main` entry per panel id,
  //      or `selectPanel` throws, so the entry must exist);
  //   2. the door mounts, switches the surface to Bot (which is what installs the whole
  //      DS Bot shell: sidebar, chats, groups, styles);
  //   3. it hands the centre column straight back to the conversation with
  //      `selectPanel(null)`, which is the documented "return to the Conversation".
  //
  // Nothing is faked: no DOM is moved, no CSS hides a panel, and the two calls are the
  // same public API the shipped entries use (`setSurface` is ds-bot's own action,
  // `selectPanel(null)` is what opening any ordinary chat does).
  function BotDoor({ onEnterBot }) {
    useEffect(() => { onEnterBot?.() }, [onEnterBot])
    return null
  }

  attempt('main panel', () => ctx.slots.inject('main', function* registerMain() {
    // The rail entry's key: a door into DS Bot itself.
    yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: 'ds-bot' },
      () => h(BotDoor, { onEnterBot }))
    // The workgroup panel's key. `inject` hands it the local roster observable, so the
    // create form offers the team's own Bots as members — a workgroup with no members
    // cannot answer.
    yield ctx.slots.register({
      name: 'main',
      key: WG_PANEL_KEY,
      locale: 'ds-bot',
      ...(roster === undefined ? {} : { inject: () => ({ roster }) }),
    }, props => h(BotPanel, { roster: props?.roster ?? roster }))
  }))

  // The nav row, in the list slot the shipped plugins and schedules entries use.
  attempt('sidebar entry', () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => 'Bot',
    locale: 'ds-bot',
  }, BotPanelIcon)))

  // Warm the list once so the entry can show whether any workgroup exists.
  void refreshWorkgroups()

  if (problems.length > 0) console.warn('[ds-bot] workgroup client problems:', problems)

  return () => {
    for (const dispose of [...disposers].reverse()) {
      try { dispose?.() } catch (error) { console.warn('[ds-bot] workgroup client', error) }
    }
    disposers.length = 0
  }
}
