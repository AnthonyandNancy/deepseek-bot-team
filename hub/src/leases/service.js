// The single coordinator lease (plan §9.5).
//
// "V1 一个工作群同时只允许一个有效调度者" is a fencing problem, not a UI one. The Hub hands out an
// epoch; a round commit names the epoch it ran under; the Hub refuses one that is not the current
// epoch. That is the whole mechanism, and it is deliberately small:
//
//   * one row per group (the table's primary key), so "two coordinators" cannot be represented;
//   * `epoch` only moves forward, so a fence value can never become valid again;
//   * the holder is a user AND a device, because a person with two machines must not be able to run
//     two rounds by being the same person;
//   * a lease expires, and an expired lease is treated as absent — the plan's "its offline means
//     human chat continues and automatic rounds wait" is exactly that.
//
// What the Hub does NOT do: start a round, pick a coordinator, or revoke a lease because a device
// went offline. The lease is a fence the client asks to be measured against.
import { randomUUID } from 'node:crypto'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { prepared } from '../db/prepared.js'

const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '')}`

export const DEFAULT_LEASE_MS = 60 * 1000
export const MAX_LEASE_MS = 10 * 60 * 1000

export function createLeaseService({ db, audit, now = () => Date.now(), workgroups } = {}) {
  const stmt = prepared(db)
  const iso = () => new Date(now()).toISOString()

  const byGroup = stmt('SELECT * FROM round_leases WHERE workgroup_id = ?')
  const upsert = stmt(`INSERT INTO round_leases (workgroup_id, epoch, holder_user_id, holder_device_id, lease_until, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (workgroup_id) DO UPDATE SET
      epoch = excluded.epoch, holder_user_id = excluded.holder_user_id,
      holder_device_id = excluded.holder_device_id, lease_until = excluded.lease_until,
      updated_at = excluded.updated_at`)

  const publicLease = row => (row === undefined ? null : {
    workgroupId: row.workgroup_id,
    epoch: row.epoch,
    holderUserId: row.holder_user_id,
    holderDeviceId: row.holder_device_id,
    leaseUntil: row.lease_until,
  })

  const live = row => row !== undefined && row.lease_until > iso()

  const service = {
    current({ workgroupId }) {
      return { lease: publicLease(byGroup.get(workgroupId)) }
    },

    // Acquire, or renew if this device already holds it. Renewing keeps the epoch (the fence is
    // still this holder's); acquiring after an expiry takes the next epoch, so a commit from the
    // previous holder is refused even if its clock says it is still running.
    acquire({ userId, deviceId, workgroupId, leaseMs }) {
      if (!workgroups.isMember(workgroupId, userId)) throw notFound('workgroup/not-found', 'No such workgroup.')
      const requested = Number.isFinite(leaseMs) ? Math.floor(leaseMs) : DEFAULT_LEASE_MS
      if (requested <= 0) throw badRequest('lease/invalid-duration', 'A lease needs a positive duration.')
      const duration = Math.min(MAX_LEASE_MS, requested)

      const existing = byGroup.get(workgroupId)
      const mine = live(existing) && existing.holder_device_id === deviceId && existing.holder_user_id === userId
      if (live(existing) && !mine) {
        // Somebody else is the coordinator right now. A 409 with the current holder is a better
        // answer than silently taking over: the client can wait or show who has it.
        throw conflict('lease/held', `Another device of this group holds the lease until ${existing.lease_until}.`)
      }
      const epoch = mine ? existing.epoch : (existing?.epoch ?? 0) + 1
      const at = now()
      upsert.run(workgroupId, epoch, userId, deviceId, new Date(at + duration).toISOString(), new Date(at).toISOString())
      audit.record({ actorId: userId, deviceId, action: 'lease.acquire', targetId: workgroupId, result: String(epoch) })
      return { lease: publicLease(byGroup.get(workgroupId)) }
    },

    // Explicit release. Kept so a clean shutdown does not leave the group waiting for an expiry.
    //
    // The row is KEPT and its `lease_until` is moved into the past rather than deleted. Deleting it
    // would restart the epoch at 1, and a round the releasing device had in flight would then find
    // its old fence value current again — the one thing a fence must never allow.
    release({ userId, deviceId, workgroupId }) {
      const existing = byGroup.get(workgroupId)
      if (existing === undefined || existing.holder_device_id !== deviceId) {
        throw forbidden('lease/not-holder', 'Only the device holding the lease may release it.')
      }
      const at = now()
      // One millisecond before now, so `live()` is false but the epoch is preserved.
      db.prepare('UPDATE round_leases SET lease_until = ?, updated_at = ? WHERE workgroup_id = ?')
        .run(new Date(at - 1).toISOString(), new Date(at).toISOString(), workgroupId)
      audit.record({ actorId: userId, deviceId, action: 'lease.release', targetId: workgroupId, result: 'ok' })
      return { released: true, workgroupId, epoch: existing.epoch }
    },

    // The fence check a round commit goes through. Returns a refusal instead of throwing because the
    // socket path answers with an error frame, not an HTTP status.
    checkFence({ userId, deviceId, workgroupId, epoch }) {
      const existing = byGroup.get(workgroupId)
      if (existing === undefined) return { ok: false, code: 'lease/none', detail: 'This group has no coordinator lease; acquire one first.' }
      if (!live(existing)) return { ok: false, code: 'lease/expired', detail: 'The coordinator lease has expired; the round may not commit.' }
      if (existing.holder_device_id !== deviceId || existing.holder_user_id !== userId) {
        return { ok: false, code: 'lease/not-holder', detail: 'This device does not hold the group lease.' }
      }
      if (Number.isFinite(epoch) && epoch !== existing.epoch) {
        // The one that matters: a stale round reporting a result with an old epoch is refused, even
        // though it really did run.
        return { ok: false, code: 'lease/stale-epoch', detail: `That round ran under epoch ${epoch}; the lease is at ${existing.epoch}.` }
      }
      return { ok: true, lease: publicLease(existing) }
    },

    // Every live lease this device holds, so a reconnecting client can tell whether it is still the
    // coordinator without a request per group.
    mineFor({ userId, deviceId }) {
      const rows = stmt('SELECT * FROM round_leases WHERE holder_user_id = ? AND holder_device_id = ?').all(userId, deviceId)
      return { leases: rows.filter(live).map(publicLease) }
    },

    // Expired rows are not deleted: the epoch has to survive an expiry or a stale fence value could
    // become valid again. `sweep` is therefore not needed, and deliberately absent.
    count(workgroupId) {
      return byGroup.get(workgroupId) === undefined ? 0 : 1
    },
  }

  return service
}
