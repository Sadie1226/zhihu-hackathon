import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { INTEREST_CATEGORIES } from '../../contracts/types.ts'
import type { Find } from '../../contracts/types.ts'
import { canonicalZhihuContentUrl } from '../wishes/contract.ts'
import { DiscoveryReceiptIntegrityError, readDiscoveryReceipt } from '../trips/discovery-receipt.ts'
import type { MemberFilter } from '../trips/discovery-receipt.ts'
import { TripError } from '../trips/errors.ts'
import { readBlockedTopics, readOwnerFindTrip } from '../trips/find-scope.ts'
import type { OwnerFindScope } from '../trips/find-scope.ts'
import { createFindStore, LegacyDiscoveryHoldError } from '../trips/finds.ts'
import { blockedBy } from '../trips/search-proof.ts'
import type { Experience, ExperienceHistory } from './a7-types.ts'

type StoredTrip = { id: string; dog_id: string; seq: number; started_at: string; ended_at: string }
type VisibleFind = { row: Find; category: string | null }

function instant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function category(filter: MemberFilter): string | null {
  if (filter[0] !== 'search' && filter[0] !== 'cache') return null
  return INTEREST_CATEGORIES.find(value => value === filter[2]) ?? null
}

/** A full C receipt projection is required before a row can become learning input. */
function confirmedArticles(db: DatabaseSync, trip: StoredTrip, ownerId: string, cutoff: string): VisibleFind[] {
  if (!instant(trip.started_at) || !instant(trip.ended_at) ||
      Date.parse(trip.ended_at) < Date.parse(trip.started_at) || Date.parse(trip.ended_at) > Date.parse(cutoff)) return []
  const stored = db.prepare('SELECT owner_id, intent_id, completed_at FROM trip_discovery_receipt WHERE trip_id=?')
    .get(trip.id)
  if (!stored || stored.owner_id !== ownerId || typeof stored.intent_id !== 'string' ||
      !instant(stored.completed_at) || Date.parse(stored.completed_at) > Date.parse(trip.ended_at)) return []
  try {
    const projection = createFindStore(db, { now: () => new Date(cutoff) }).readConfirmation({
      tripId: trip.id, owner: ownerId, intentId: stored.intent_id,
    }, true)
    if (!projection) return []
    const receipt = readDiscoveryReceipt(db, {
      tripId: trip.id, dogId: trip.dog_id, ownerId, intentId: stored.intent_id,
    })
    if (!receipt) return []
    const filters = new Map(receipt.members.map(([id, , filter]) => [id, filter]))
    return projection.finds.flatMap(row => {
      const filter = filters.get(row.id)
      if (!filter || row.kind !== 'zhihu' || !row.sourceUrl ||
          (row.sourceMode !== 'live' && row.sourceMode !== 'cache')) return []
      return [{ row, category: category(filter) }]
    })
  } catch (error) {
    // Legacy, corrupt and currently inaccessible facts abstain; no repairing or rewriting history.
    if (error instanceof DiscoveryReceiptIntegrityError || error instanceof LegacyDiscoveryHoldError ||
        (error instanceof TripError && (error.code === 'CONFLICT' || error.code === 'NOT_FOUND'))) return []
    throw error
  }
}

function canonical(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try { return canonicalZhihuContentUrl(value) } catch { return null }
}

/**
 * Read-only A7 history at this departure's fixed time and sequence. No raw owner text,
 * unarrived gifts, failed trips or fixture articles are learning signals.
 * A supplied string is the existing trusted server-owner capability, never an HTTP field.
 */
export function readExperienceHistory(db: DatabaseSync, tripId: string, scope: OwnerFindScope): ExperienceHistory {
  const ownTransaction = !db.isTransaction
  if (ownTransaction) db.exec('BEGIN')
  try {
    const profile = readOwnerFindTrip(db, tripId, scope)
    const current = db.prepare('SELECT seq,started_at FROM trip WHERE id=? AND dog_id=?').get(tripId, profile.dogId)!
    if (profile.status !== 'running' || !instant(current.started_at) || !Number.isSafeInteger(current.seq)) {
      throw new TripError('CONFLICT', '当前出行尚未开始')
    }
    const beforeSeq = Number(current.seq)
    const cutoff = current.started_at
    const lower = Math.max(1, beforeSeq - 6)
    const blocked = readBlockedTopics(profile.blockedTopics)
    const entries: Experience[] = []
    const prior = db.prepare(`SELECT id,dog_id,seq,started_at,ended_at FROM trip
      WHERE dog_id=? AND seq>=? AND seq<? AND status='done' ORDER BY seq,id`)
      .all(profile.dogId, lower, beforeSeq) as StoredTrip[]
    for (const trip of prior) {
      for (const { row, category: queryCategory } of confirmedArticles(db, trip, profile.ownerId, cutoff)) {
        const sourceId = canonical(row.sourceUrl)
        if (!sourceId) continue
        entries.push(Object.freeze({ id: row.id, tripId: trip.id, seq: trip.seq, sourceId,
          title: row.title, excerpt: row.excerpt, category: queryCategory, kind: 'trip' }))
      }
    }

    // Only a shared Find carries the actual referenced content. A gift reference does not
    // grant access to its private source excerpt, so gift/greeting/owner-message abstain.
    const exchanges = db.prepare(`SELECT e.id,e.from_dog,e.payload,e.created_at,e.delivered_at,
      arrived.id AS arrival_trip_id,arrived.seq AS arrival_seq
      FROM exchange e JOIN trip arrived ON arrived.dog_id=e.to_dog
        AND arrived.seq=e.deliver_after_trip_seq
      WHERE e.to_dog=? AND e.kind='find' AND e.delivered_at IS NOT NULL
        AND arrived.started_at IS NOT NULL AND arrived.seq>=? AND arrived.seq<?
        AND NOT EXISTS (SELECT 1 FROM relation r WHERE r.is_blocked=1
          AND ((r.dog_a=e.from_dog AND r.dog_b=e.to_dog) OR (r.dog_b=e.from_dog AND r.dog_a=e.to_dog)))
      ORDER BY arrived.seq,e.id`).all(profile.dogId, lower, beforeSeq)
    for (const exchange of exchanges) {
      if (!instant(exchange.created_at) || !instant(exchange.delivered_at) ||
          Date.parse(exchange.created_at) > Date.parse(exchange.delivered_at) ||
          Date.parse(exchange.delivered_at) > Date.parse(cutoff)) continue
      const arrival = db.prepare('SELECT started_at FROM trip WHERE id=?').get(exchange.arrival_trip_id!)!
      if (!instant(arrival.started_at) || Date.parse(arrival.started_at) > Date.parse(exchange.delivered_at)) continue
      let payload: unknown
      try { payload = JSON.parse(String(exchange.payload)) } catch { continue }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
      const content = payload as Record<string, unknown>
      if (content.kind !== 'find' || typeof content.sourceFindId !== 'string' ||
          (content.sourceMode !== 'live' && content.sourceMode !== 'cache')) continue
      const source = db.prepare(`SELECT t.id,t.dog_id,t.seq,t.started_at,t.ended_at,d.owner_id
        FROM find f JOIN trip t ON t.id=f.trip_id JOIN dog d ON d.id=t.dog_id
        WHERE f.id=? AND t.dog_id=? AND t.status='done' AND d.is_sample=0`).get(content.sourceFindId, exchange.from_dog!)
      if (!source || typeof source.owner_id !== 'string') continue
      const shared = confirmedArticles(db, source as StoredTrip, source.owner_id, exchange.created_at)
        .find(({ row }) => row.id === content.sourceFindId)
      if (!shared || shared.row.sourceMode !== content.sourceMode || shared.row.title !== content.findTitle ||
          shared.row.excerpt !== content.findExcerpt || canonical(shared.row.sourceUrl) !== canonical(content.sourceUrl) ||
          blockedBy(blocked, shared.row.title, shared.row.excerpt ?? '', shared.category ?? '')) continue
      const sourceId = canonical(shared.row.sourceUrl)
      if (!sourceId) continue
      entries.push(Object.freeze({ id: String(exchange.id), tripId: String(exchange.arrival_trip_id),
        seq: Number(exchange.arrival_seq), sourceId, title: shared.row.title, excerpt: shared.row.excerpt,
        category: shared.category, kind: 'exchange' }))
    }

    entries.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id, 'en'))
    const tags = db.prepare('SELECT personality_tags FROM dog WHERE id=?').get(profile.dogId)!.personality_tags
    const fingerprint = createHash('sha256').update(JSON.stringify([
      'a7-history-v1', profile.ownerId, profile.dogId, tripId, beforeSeq, cutoff,
      profile.blockedTopics, profile.interestCategories, tags, entries,
    ])).digest('hex')
    const result = Object.freeze({ dogId: profile.dogId, beforeSeq, entries: Object.freeze(entries), fingerprint })
    if (ownTransaction) db.exec('COMMIT')
    return result
  } catch (error) {
    if (ownTransaction && db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}
