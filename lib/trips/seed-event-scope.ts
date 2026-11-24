import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { TripError } from './service.ts'

/** Also used by the sample lifecycle once C8 is on the shared base. */
export function seedIntentTripId(dogId: string, intentId: string): string {
  if (typeof dogId !== 'string' || !dogId.trim() ||
      typeof intentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(intentId)) {
    throw new TripError('CONFLICT', '种子狗出行意图无效')
  }
  return 'trip_seed_intent_' + createHash('sha256').update(JSON.stringify([dogId, intentId])).digest('hex')
}

/** Called only inside the selector's write transaction, with the server-held intent. */
export function requireRunningSeedEventTrip(
  db: DatabaseSync,
  { dogId, tripId, intentId }: { dogId: string; tripId: string; intentId: string },
) {
  if (!db.isTransaction) throw new Error('Seed event authorization requires a transaction')
  const row = tripId === seedIntentTripId(dogId, intentId) && db.prepare(`
    SELECT t.status, t.started_at AS startedAt,
      d.interest_categories AS interestCategories, d.blocked_topics AS blockedTopics
    FROM trip t JOIN dog d ON d.id = t.dog_id
    WHERE t.id = ? AND d.id = ? AND t.trigger = 'auto' AND d.is_sample = 1 AND d.owner_id IS NULL
  `).get(tripId, dogId)
  if (!row) throw new TripError('NOT_FOUND', '这条记录不在这里')
  if (row.status !== 'running' || typeof row.startedAt !== 'string') {
    throw new TripError('CONFLICT', '这次出行尚未运行或已经结束')
  }
  return {
    startedAt: row.startedAt,
    interestCategories: row.interestCategories === null ? null : String(row.interestCategories),
    blockedTopics: String(row.blockedTopics),
  }
}
