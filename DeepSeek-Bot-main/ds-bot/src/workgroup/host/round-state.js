// Round/slot projection: what a running round still owes, written down so it survives the process
// that started it.
//
// The round object itself is deliberately still in memory (`wg.roomProgress`): it holds AbortSignals,
// waiters and promise resolvers that cannot be serialized. What CAN be serialized is the obligation:
// which room, which slot, which exchange is still waiting for an answer, and whether the user stopped
// it. A restarted coordinator reads that projection and asks the Hub (the authority) for the answer
// rather than re-running any member.
export function install(wg) {
  const rounds = () => {
    wg.state.rounds ??= {}
    return wg.state.rounds
  }

  const roundOf = roundId => (roundId === undefined ? undefined : rounds()[roundId])

  // A SNAPSHOT, not the live arrays. The round mutates `slots`, `replies`, `passed` and `failed` in
  // place; retaining those references would make the persisted record change without a save and,
  // worse, survive a save that happened before the mutation. The plain copy is what makes "saved"
  // mean saved.
  const persistRound = (round) => {
    // Accept BOTH shapes: a live round (`id`) while it runs, and a recovered plain record
    // (`roundId`) from the reconciler. A recovered record has no live methods or arrays, and
    // rejecting it would make reconciliation unable to mark an answer posted.
    const roundId = round?.id ?? round?.roundId
    if (roundId === undefined) return undefined
    const record = {
      roundId,
      roomId: round.roomId,
      startSeq: round.startSeq,
      slots: (round.slots ?? []).map(slot => ({
        id: slot.id,
        name: slot.name,
        status: slot.status,
        ...(slot.exchangeId === undefined ? {} : { exchangeId: String(slot.exchangeId) }),
        ...(slot.by === undefined ? {} : { by: slot.by }),
        ...(slot.note === undefined ? {} : { note: slot.note }),
      })),
      turns: round.turns ?? 0,
      replies: (round.replies ?? []).map(reply => ({ ...reply })),
      passed: [...(round.passed ?? [])],
      failed: [...(round.failed ?? [])],
      state: round.state ?? 'open',
      updatedAt: Date.now(),
    }
    rounds()[roundId] = record
    void wg.save({ roomId: round.roomId, kind: 'round' }).catch(() => {})
    return record
  }

  const dropRound = (roundId) => {
    if (roundId === undefined || rounds()[roundId] === undefined) return false
    const { roomId } = rounds()[roundId]
    delete rounds()[roundId]
    void wg.save({ roomId, kind: 'round' }).catch(() => {})
    return true
  }

  Object.assign(wg, { roundOf, persistRound, dropRound })
  // The brief names this map on the domain, not buried in `state`. A getter keeps it the same
  // object that is saved, so callers cannot accidentally mutate a detached copy.
  Object.defineProperty(wg, 'rounds', {
    configurable: true,
    enumerable: false,
    get: rounds,
  })
}
