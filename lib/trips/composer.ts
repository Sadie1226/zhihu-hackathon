import type { DatabaseSync } from 'node:sqlite'
import type { Find } from '../../contracts/types.ts'
import { createFindStore, hasRealZhihu } from './finds.ts'
import type { BatchFindCandidate } from './finds.ts'
import type { SearchProof } from './search-proof.ts'
import { TripError } from './service.ts'

/** A verified observation from the executor, scoped to the trip that actually observed it. */
export type TripObservation = Readonly<{
  id: string
  tripId: string
  dogId: string
  kind: 'scene' | 'moment'
  happenedAt: string
  title: string
  excerpt: string | null
  assetPath?: string | null
  topics?: readonly string[]
}>

export type DiscoveryComposition = {
  status: 'complete' | 'partial'
  finds: Find[]
  reasons: ('NO_REAL_ZHIHU' | 'INSUFFICIENT_FACTS')[]
}

function observationInput(fact: TripObservation, tripId: string, namespace: 'observation' | 'trip-event'): BatchFindCandidate {
  return {
    input: {
      tripId, kind: fact.kind, sourceKey: `${namespace}:${fact.id}`,
      title: fact.title, excerpt: fact.excerpt, assetPath: fact.assetPath ?? null,
      sourceUrl: null, sourceMode: null, authorityLevel: null, voteUpCount: null,
    },
    topics: [...(fact.topics ?? [])],
  }
}

function occurredWithin(at: string, start: string, end: string): boolean {
  const time = Date.parse(at)
  return time >= Date.parse(start) && time <= Date.parse(end)
}

/** Trusted server call only. Resolve network inputs before calling this synchronous writer. */
export function createTripDiscoveryComposer(db: DatabaseSync, options: { now?: () => Date } = {}) {
  const store = createFindStore(db, options)
  return function compose(
    tripId: string,
    sessionId: string,
    input: { searchProofs?: readonly SearchProof[]; observations?: readonly TripObservation[] } = {},
  ): DiscoveryComposition {
    const finds = store.writeBatch(tripId, sessionId, ({ dogId, startedAt, at }) => {
      const candidates: BatchFindCandidate[] = (input.searchProofs ?? []).map(proof => ({ proof }))
      for (const fact of input.observations ?? []) {
        if (fact.tripId !== tripId || fact.dogId !== dogId || !occurredWithin(fact.happenedAt, startedAt, at) ||
            !['scene', 'moment'].includes(fact.kind) || typeof fact.id !== 'string' || !fact.id.trim() ||
            fact.id !== fact.id.trim()) {
          throw new TripError('CONFLICT', '发现事实与本次出行不符')
        }
        candidates.push(observationInput(fact, tripId, 'observation'))
      }
      // A pool row is a candidate. Only the matching trip_event records an occurrence.
      const events = db.prepare(`SELECT e.id, e.text, te.happened_at, e.place_tags, e.match_tags
        FROM trip_event te JOIN event e ON e.id=te.event_id
        WHERE te.trip_id=? AND te.dog_id=? ORDER BY te.happened_at, e.id`).all(tripId, dogId)
      for (const event of events) {
        const happenedAt = String(event.happened_at)
        if (!occurredWithin(happenedAt, startedAt, at)) continue
        candidates.push(observationInput({
          id: String(event.id), tripId, dogId, kind: 'moment', happenedAt,
          title: String(event.text), excerpt: null,
          topics: [...JSON.parse(String(event.place_tags)), ...JSON.parse(String(event.match_tags))],
        }, tripId, 'trip-event'))
      }
      return candidates
    })
    const reasons: DiscoveryComposition['reasons'] = []
    if (!finds.some(hasRealZhihu)) reasons.push('NO_REAL_ZHIHU')
    if (finds.filter(find => find.kind !== 'zhihu' || hasRealZhihu(find)).length < 3) reasons.push('INSUFFICIENT_FACTS')
    return { status: reasons.length ? 'partial' : 'complete', finds, reasons }
  }
}
