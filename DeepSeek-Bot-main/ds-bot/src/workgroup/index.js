// The Workgroup domain: an independent copy of the original group-chat subsystem,
// installed once, into the single DS Bot runtime.
//
// Rules this file enforces (they are the G0 audit's P0 findings, see
// docs/g0/reference-classification.md):
//   * installed exactly once — a second install throws instead of registering a
//     second set of tools/listeners;
//   * never runs the original MODULES again — it only *references* the one runtime;
//   * its own maps (roomWaiters / roomProgress / roomInbox / sessionOwners) instead
//     of the original rt.roomWaiters and friends, so a local group and a workgroup
//     can never touch each other's turns;
//   * its own state file, its own RPC route, its own source kind, its own tool names.
import * as state from './host/state.js'
import * as ownership from './host/ownership.js'
import * as tasks from './host/tasks.js'
import * as taskRunner from './host/task-runner.js'
import * as handoffs from './host/handoffs.js'
import * as roundState from './host/round-state.js'
import * as groups from './host/groups.js'
import * as hub from './host/hub.js'
import * as bridge from './host/bridge.js'
import * as memorySync from './host/memory-sync.js'
import * as upgrade from './host/upgrade.js'
import * as channel from './host/channel.js'

// Order matters the same way it does in ../../index.js: state and ownership before
// anything that resolves a Session, tasks and groups before the route that exposes them.
// tasks installs before groups because it claims task Sessions through ownership and
// chains onto the same `onStateLoaded` hook groups never touches.
// `taskRunner` installs right after tasks: it is what drives the registry from the wire, and it
// registers the tool guard at install time — after groups, a task turn could start before the guard
// existed, which is the one ordering plan §10.4 cannot tolerate.
// `hub` installs after groups and before channel: the channel answers the `hub-*` endpoints and
// needs `wg.hub` to exist, while nothing in groups depends on the Hub.
// `bridge` installs after `hub` (it is a client of that client) and before `channel` (the channel
// exposes its status). It starts nothing at install time: a team with no Hub pays nothing, and a
// Hub that is down cannot slow a startup.
// `upgrade` installs after `bridge` (an upgrade calls the Hub through it) and before `channel` (the
// `upgrade-room` endpoint belongs to it).
// `handoffs` installs BEFORE groups, the same order the original uses (`index.js`: handoffs, then
// groups): groups calls `closeWork` when a round that a post waited on ends, so the ledger must
// already exist. It needs only `wg.state` and this domain's maps, so nothing else constrains it.
const WG_MODULES = [state, ownership, tasks, taskRunner, handoffs, roundState, groups, hub, bridge, memorySync, upgrade, channel]

export function installWorkgroup(rt) {
  if (rt === undefined || rt === null) throw new Error('ds-bot: installWorkgroup needs the runtime')
  if (rt.workgroup !== undefined) {
    // One runtime, one Workgroup. Duplicated installs are the exact failure the plan
    // forbids: two sets of tools with the same names and two event consumers.
    throw new Error('ds-bot: the Workgroup domain is already installed in this runtime')
  }

  const wg = {
    rt,                   // the one real runtime; never a copy of it
    ctx: rt.ctx,
    state: null,          // filled by host/state.js
    sessionOwners: new Map(),
    roomWaiters: new Map(),
    roomProgress: new Map(),
    roomInbox: new Map(),
    tasks: new Map(),
    // Filled by host/bridge.js: the Hub socket, its outbox and its inbox. G1 left this `null` as
    // the seam for cross-device delivery, G3 filled it with the HTTP client alone because there was
    // nothing to bridge yet, and G4 installs the real connection.
    bridge: null,
    installedAt: Date.now(),
  }
  rt.workgroup = wg

  // A failure here must not take the original Bot team down with it. The plan's
  // §7.1 requires the local team to keep working when a network-bound feature cannot;
  // the same applies to this domain's own wiring. The failure is reported loudly and
  // `rt.workgroup` is cleared, so callers see "not installed" rather than a half-built
  // domain, and the reason is visible in the diagnostics log.
  try {
    for (const module of WG_MODULES) module.install(wg)
    // The original memory engine reports every completed write through this observer. One indirection
    // so a domain that was not installed yet, or has been torn down, is simply no observer.
    rt.onMemoryWritten = change => { void rt.workgroup?.onMemoryWritten?.(change) }
  } catch (error) {
    delete rt.workgroup
    rt.warn?.('ds-bot: the Workgroup domain did not install; the local team keeps working: %s', error?.message ?? error)
    wg.installError = error
    return undefined
  }
  return wg
}

export { WG_MODULES }
