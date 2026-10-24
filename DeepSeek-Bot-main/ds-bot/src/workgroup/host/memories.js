// Group memory on this machine: a projection of the Hub's authoritative store.
//
// The projection exists for prompt freezing and for a quick view. It is never the authority: every
// read the panel makes goes through `wg.hub.memories` / `searchMemories`, and every write goes to
// the Hub first. An incoming `memory.*` event means "re-read", not "merge this payload locally".
export function install(wg) {
  const cache = () => {
    wg.state.memories ??= {}
    return wg.state.memories
  }

  async function refreshMemories(workgroupId) {
    const answer = await wg.hub.memories({ workgroupId })
    const entries = Array.isArray(answer?.memories) ? answer.memories : []
    cache()[workgroupId] = { entries, fetchedAt: Date.now() }
    await wg.save({ workgroupId, kind: 'memory' })
    return entries
  }

  function memoryCache(workgroupId) {
    return cache()[workgroupId]
  }

  async function onMemoryEvent({ workgroupId }) {
    // A socket handler must stay best-effort. A failed re-read leaves the last projection in place;
    // the next open or event will try again, and the Hub remains the answer.
    await refreshMemories(workgroupId).catch(() => {})
    wg.rt.workgroupStateSaved?.({ workgroupId, kind: 'memory' })
  }

  async function createMemory(args) {
    const answer = await wg.hub.createMemory(args)
    await refreshMemories(args.workgroupId).catch(() => {})
    return answer
  }

  async function correctMemory(args) {
    const answer = await wg.hub.correctMemory(args)
    await refreshMemories(args.workgroupId).catch(() => {})
    return answer
  }

  async function deleteMemory(args) {
    const answer = await wg.hub.deleteMemory(args)
    await refreshMemories(args.workgroupId).catch(() => {})
    return answer
  }

  Object.assign(wg, {
    memoryCache,
    refreshMemories,
    onMemoryEvent,
    createMemory,
    correctMemory,
    deleteMemory,
  })
}
