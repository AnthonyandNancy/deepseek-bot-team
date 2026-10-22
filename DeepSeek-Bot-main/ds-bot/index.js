// DS Bot: a team of long-lived Bots on top of ordinary dsh root Sessions.
// Every Bot is one root Session; the roster, rooms, and the bot-to-bot exchange log live
// in one JSON file under DSH_HOME so they survive restarts without new Session event types.
import { join } from 'node:path'
import { createRequire } from 'node:module'
import * as diagnostics from './src/host/diagnostics.js'
import * as store from './src/host/store.js'
import * as models from './src/host/models.js'
import * as providers from './src/host/providers.js'
import * as permissions from './src/host/permissions.js'
import * as turns from './src/host/turns.js'
import * as handoffs from './src/host/handoffs.js'
import * as delivery from './src/host/delivery.js'
import * as roster from './src/host/roster.js'
import * as folders from './src/host/folders.js'
import * as agents from './src/host/agents.js'
import * as prompt from './src/host/prompt.js'
import * as timeContext from './src/host/time-context.js'
import * as tools from './src/host/tools.js'
import * as chatIndex from './src/host/chat-index.js'
import * as groups from './src/host/groups.js'
import * as approvals from './src/host/approvals.js'
import * as resume from './src/host/resume.js'
import * as memory from './src/host/memory.js'
import * as parts from './src/host/parts.js'
import * as images from './src/host/images.js'
import * as browser from './src/host/browser.js'
import * as secrets from './src/host/secrets.js'
import * as connectors from './src/host/connectors.js'
import * as capabilities from './src/host/capabilities.js'
import * as schedules from './src/host/schedules.js'
import * as usage from './src/host/usage.js'
import * as update from './src/host/update.js'
import * as dshUpdate from './src/host/dsh-update.js'
import * as thinking from './src/host/thinking.js'
import * as channel from './src/host/channel.js'
import * as feed from './src/host/feed.js'

export { COLORS } from './src/host/constants.js'

export const name = 'ds-bot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']

// Each module's install(rt) registers its listeners, tools, and effects, and puts on `rt`
// the functions other modules call; they call them through `rt` at run time, never during
// install. Listeners run and tools are listed in registration order, so this order holds:
// usage meters model requests after every listener that rewrites them.
const MODULES = [diagnostics, store, models, providers, permissions, turns, handoffs, delivery, roster, folders, agents, prompt, timeContext, tools, chatIndex, groups, approvals, resume, memory, parts, images, secrets, connectors, capabilities, schedules, browser, usage, update, dshUpdate, thinking, feed, channel]

export function apply(ctx, config = {}) {
  createRuntime(ctx, config)
}

export function createRuntime(ctx, config = {}) {
  const dshHome = folders.dshHomeOf(process.env.DSH_HOME)
  const home = config.home ?? join(dshHome, 'bot')
  const rt = {
    ctx,
    config,
    dshHome,
    home,
    statePath: join(home, 'state.json'),
    defaults: {
      mainName: config.mainName ?? 'Chief',
      mainRole: config.mainRole ?? 'Chief of Staff',
    },
  }
  for (const module of MODULES) module.install(rt)
  // The Workgroup domain installs once, after every original module, into this same
  // runtime. It never re-runs MODULES and never re-registers an original tool: see
  // src/workgroup/index.js. `config.workgroup === false` leaves it out entirely.
  //
  // It is loaded through require() rather than a static import ON PURPOSE. A static
  // import would let a broken Workgroup file take the whole plugin down: DSH then
  // reports "1 entry did not activate / ds-bot: failed" and nothing boots. The local
  // Bot team must stay usable, the same rule that keeps it usable when the Hub is
  // unreachable. require() also keeps createRuntime synchronous, which callers rely on.
  if (config.workgroup !== false) {
    try {
      loadWorkgroup(config).installWorkgroup(rt)
    } catch (error) {
      rt.warn?.('ds-bot: the Workgroup domain is unavailable; the local Bot team keeps working: %s', error?.message ?? error)
    }
  }
  return rt
}

// Loaded on first use and cached. A failure is not cached, so a repaired install can
// succeed without restarting the whole app.
const require = createRequire(import.meta.url)
let workgroupModule
function loadWorkgroup(config) {
  // `config.workgroupModule` is a test-only seam: it lets a test inject a module whose
  // install throws, the only way to prove the guarded failure path above.
  if (config?.workgroupModule !== undefined) return config.workgroupModule
  workgroupModule ??= require('./src/workgroup/index.js')
  return workgroupModule
}
