// Hand-offs in the Workgroup domain: the work Bots give each other, and what each Bot is
// doing right now.
//
// COPY OF THE ORIGINAL (`src/host/handoffs.js`), reading this domain's own state and
// ownership maps. The plan (§5.1) lists this file as an A-class copy that must keep its
// behaviour:
//
//   | `host/handoffs.js` 群交接部分 | `workgroup/host/handoffs.js` | Bot 任务交接、结果回报 |
//
// It existed only in the original domain until now, and that is not cosmetic. A workgroup
// member's `message_bot` and a member's post both ran through this domain's own paths,
// which never opened a work here; `reportRound` reads `post.sub` to close one and got
// `undefined` every time (`groups.js:1854` before this file). The chain A → B → A therefore
// stopped after B answered: nothing brought A back to the work, so the group went quiet
// mid-conversation — the symptom that made the copy necessary.
//
// THE ONE RULE the copy must not break: this domain's records are never written into the
// original's (`state.works`, `rt.live`, `rt.roomOwners`). Everything below reads and writes
// `wg.*` and `wg.state.works`, and the original's map stays untouched — the same
// cross-domain claim `host/ownership.js` exists to prevent.
import { WG_TEXT_KEPT } from '../shared/constants.js'
import { headOf } from '../../host/text.js'

const minutes = since => {
  const count = Math.floor((Date.now() - since) / 60_000)
  return count < 1 ? 'for less than a minute' : `for ${count} min`
}

export function install(wg) {
  const { rt } = wg
  // This domain's own state object. Reading it lazily (not at install) matters: `install`
  // runs before `state.js` has loaded the file, so a captured reference would be the
  // placeholder that gets replaced.
  const works = () => (wg.state.works ??= {})
  // What came back, whole; the state file keeps only the start of each.
  const whole = new Map()
  const save = () => void wg.save().catch(() => {})
  // The name of a Bot in THIS domain first, then the original's — a workgroup member may
  // be a local Bot (the original knows it) or a remote one (only this domain does, from
  // the roster). Falling back keeps a remote member's name out of the log as "undefined".
  const nameOf = id => wg.workgroupBotOf?.(id)?.name ?? rt.botOf(id)?.name

  const workOf = info => (info === undefined ? undefined
    : info.role === 'request' && info.audience !== 'user' ? info.exchangeId : info.work)

  function openWork(id, { from, to, parent, fromRoom, room }) {
    const above = parent === undefined ? undefined : works()[parent]
    works()[id] = { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(room ? { room } : {}), ...(above ? { parent } : {}), ...(fromRoom ? { fromRoom } : {}), open: [], results: [], at: Date.now() }
    if (above !== undefined) above.open.push(id)
    save()
  }

  function closeWork(id, name, text) {
    const work = works()[id]
    if (work === undefined) return undefined
    delete works()[id]
    for (const child of Object.values(works())) if (child.parent === id) delete child.parent
    const above = works()[work.parent]
    if (above !== undefined) {
      above.results.push({ id, name, text: headOf(text, WG_TEXT_KEPT), ...(text.length > WG_TEXT_KEPT ? { length: text.length } : {}) })
      whole.set(id, text)
    }
    for (const result of work.results) whole.delete(result.id)
    save()
    return above === undefined ? undefined : work.parent
  }
  const dropWork = (id) => {
    if (works()[id] === undefined) return
    const { parent } = works()[id]
    delete works()[id]
    const above = works()[parent]
    if (above !== undefined) above.open = above.open.filter(other => other !== id)
    save()
  }

  function taken(workId, id) {
    const work = works()[workId]
    if (work === undefined || !work.open.includes(id)) return
    work.open = work.open.filter(other => other !== id)
    save()
  }

  const owns = (botId, workId) => workId !== undefined && works()[workId]?.to === botId
  const waits = workId => (works()[workId]?.open.length ?? 0) > 0
  function hold(workId, text) {
    const work = works()[workId]
    if (work === undefined || text === '') return
    work.held = headOf(text, WG_TEXT_KEPT)
    save()
  }
  const askedBy = workId => {
    const work = works()[workId]
    return work === undefined ? undefined : { kind: 'bot', role: 'request', exchangeId: workId, senderSessionId: work.from, ...(work.fromRoom ? { senderRoomId: work.fromRoom } : {}) }
  }
  function answerText(workId, reply, botName) {
    const work = works()[workId]
    const said = reply !== '' ? reply : work?.held ?? ''
    const results = (work?.results ?? []).map(result => {
      const text = whole.get(result.id) ?? result.text
      const cut = whole.has(result.id) || result.length === undefined ? '' : `\n[cut at ${WG_TEXT_KEPT} characters by a restart]`
      return `${result.name}:\n${text}${cut}`
    })
    if (results.length === 0) return said || `${botName} finished without a reply.`
    return [said || `${botName} finished and wrote nothing more.`, `[Handed back to ${botName} for this work]`, ...results].join('\n\n')
  }

  function upstreamOf(workIds) {
    const bots = new Set()
    for (const workId of workIds) {
      const seen = new Set()
      for (let id = workId; id !== undefined && !seen.has(id) && works()[id] !== undefined; id = works()[id].parent) {
        seen.add(id)
        if (works()[id].from) bots.add(works()[id].from)
      }
    }
    return bots
  }

  const sameWork = (id, parent) => (works()[id]?.parent ?? undefined) === (works()[parent] === undefined ? undefined : parent)

  // The works their Bots wait on, outside a turn that does them (`busy`). The original reads
  // `rt.live`; a workgroup member Session is never in that map (see `ownership.js`), so the
  // domain's own `wg.live` answers here.
  const held = busy => Object.entries(works())
    .filter(([id, work]) => work.to !== undefined && work.open.length > 0 && !busy.has(id))
    .map(([id, work]) => ({ id, work, out: work.open.map(childId => works()[childId]).filter(Boolean) }))
  const busyWith = sessionIds => new Set(sessionIds.map(sessionId => wg.live?.get(sessionId)).filter(entry => entry?.turn !== undefined).map(entry => workOf(entry.info)).filter(Boolean))

  // Per Bot, the Bots and groups it waits for, and the Bots it does that work for.
  function waitingView() {
    const view = {}
    const add = (list, id) => { if (id !== undefined && !list.includes(id)) list.push(id) }
    for (const { work, out } of held(busyWith([...(wg.live?.keys() ?? [])]))) {
      if (out.length === 0) continue
      const entry = view[work.to] ??= { bots: [], rooms: [], for: [] }
      for (const child of out) add(child.room ? entry.rooms : entry.bots, child.room ?? child.to)
      add(entry.for, work.from)
    }
    return view
  }

  function forgetBot(botId) {
    const waiting = Object.entries(works()).filter(([, work]) => work.to === botId).map(([id]) => askedBy(id))
    for (const [id, work] of Object.entries(works())) if (work.from === botId && work.to !== botId) dropWork(id)
    return waiting
  }

  // What a Bot is doing, in one line for the Bots that work with it.
  function statusOf(botId) {
    const lines = []
    const running = [...(wg.live?.entries() ?? [])]
      .filter(([sessionId, entry]) => entry?.turn !== undefined && wg.sessionOwners.get(sessionId)?.botId === botId)
      .map(([sessionId]) => sessionId)
    const place = sessionId => {
      const room = wg.workgroupOf(wg.sessionOwners.get(sessionId)?.workgroupId)
      return room ? `in group "${room.name}"` : 'in its own chat'
    }
    for (const sessionId of running) {
      const entry = wg.live.get(sessionId)
      const what = entry?.tool ? `: running ${entry.tool}` : entry?.step ? `: "${String(entry.step).slice(0, 100)}"` : ''
      lines.push(`working ${place(sessionId)} ${minutes(entry.since ?? Date.now())}${what}`)
    }
    for (const { work, out } of held(busyWith(running))) {
      if (work.to !== botId) continue
      const forName = nameOf(work.from) ? `, for ${nameOf(work.from)}` : ''
      const on = [...new Set(out.map(child => (child.room ? `group "${wg.workgroupOf(child.room)?.name ?? 'a group'}"` : nameOf(child.to) ?? 'a teammate')))]
      lines.push(on.length > 0 ? `waiting for ${on.join(' and ')} to hand back work${forName}` : `about to go on with work${forName}, whose results came back`)
    }
    if (lines.length === 0) lines.push('idle')
    return lines.join('; ')
  }

  Object.assign(wg, { workOf, openWork, closeWork, dropWork, takenWork: taken, ownsWork: owns, waitsWork: waits, holdWork: hold, workAsker: askedBy, answerText, upstreamOf, sameWork, forgetBotWork: forgetBot, statusOf, waitingView })
}
