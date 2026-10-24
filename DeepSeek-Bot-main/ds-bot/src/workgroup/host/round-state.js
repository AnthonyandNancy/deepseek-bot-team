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
    if (round?.id === undefined) return undefined
    const record = {
      roundId: round.id,
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
    rounds()[round.id] = record
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
}
