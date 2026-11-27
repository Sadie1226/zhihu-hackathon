import type { DatabaseSync } from 'node:sqlite'
import { resolveAuthContext } from '../auth/session.ts'
import { TripError } from './errors.ts'

/** Pass the original request on HTTP paths. A string is a server-authorized owner ID. */
export type OwnerFindScope = Request | string
export type SeedFindScope = { dogId: string; tripId: string; intentId: string }

export function readOwnerFindTrip(db: DatabaseSync, tripId: string, scope: OwnerFindScope) {
  const ownerId = typeof scope === 'string' ? scope
    : scope instanceof Request ? resolveAuthContext(scope, db)?.ownerId : undefined
  const trip = ownerId && tripId && db.prepare(`
    SELECT t.status, t.dog_id AS dogId, t.started_at AS startedAt, d.blocked_topics AS blockedTopics,
      d.interest_categories AS interestCategories, w.text AS wishText, w.category AS wishCategory
    FROM trip t JOIN dog d ON d.id = t.dog_id
    LEFT JOIN wish w ON t.trigger = 'wish' AND t.wish_id = w.id AND w.dog_id = d.id
    WHERE t.id = ? AND d.owner_id = ? AND d.is_sample = 0
  `).get(tripId, ownerId)
  if (!trip) throw new TripError('NOT_FOUND', '这条记录不在这里')
  return { ownerId, dogId: String(trip.dogId), status: trip.status, startedAt: trip.startedAt,
    blockedTopics: trip.blockedTopics, interestCategories: trip.interestCategories,
    wishText: trip.wishText, wishCategory: trip.wishCategory }
}

export function readBlockedTopics(value: unknown): string[] {
  const topics: unknown = typeof value === 'string' ? JSON.parse(value) : null
  if (!Array.isArray(topics) || topics.some(topic => typeof topic !== 'string')) {
    throw new Error('Invalid stored blocked topics')
  }
  return topics
}
