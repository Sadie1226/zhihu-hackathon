import type { DatabaseSync } from 'node:sqlite'
import type { Find } from '../../contracts/types.ts'
import { TripError } from './errors.ts'
import type { OwnerFindScope, SeedFindScope } from './find-scope.ts'
import { createFindStore } from './finds.ts'
import type { BatchFindCandidate } from './finds.ts'
import type { SearchProof } from './search-proof.ts'

/** The server executor supplies observations that it has actually verified for this trip. */
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
  eventOmission?: 'EVENT_TOPICS_UNVERIFIABLE' | 'EVENT_FIND_MISMATCH'
}

type CompositionInput = { searchProofs?: readonly SearchProof[]; observations?: readonly TripObservation[] }
type SeedCompositionInput = { observations?: readonly (TripObservation & { kind: 'scene' })[] }

function occurredWithin(at: string, start: string, end: string): boolean {
  const time = Date.parse(at)
  return time >= Date.parse(start) && time <= Date.parse(end)
}

/** Trusted server entry after start commits. Resolve all network inputs before composing. */
export function createTripDiscoveryComposer(db: DatabaseSync, options: { now?: () => Date } = {}) {
  const store = createFindStore(db, options)

  function composeBatch(tripId: string, input: CompositionInput, authorization:
    { owner: OwnerFindScope } | { seed: SeedFindScope }): DiscoveryComposition {
    const seed = 'seed' in authorization
    const select: Parameters<typeof store.writeBatch>[2] = ({ dogId, startedAt, at }) => {
      const candidates: BatchFindCandidate[] = (input.searchProofs ?? []).map(proof => ({ proof }))
      for (const fact of input.observations ?? []) {
        if (fact.tripId !== tripId || fact.dogId !== dogId || !occurredWithin(fact.happenedAt, startedAt, at) ||
            !(fact.kind === 'scene' || (!seed && fact.kind === 'moment')) ||
            typeof fact.id !== 'string' || !fact.id.trim() || fact.id !== fact.id.trim() ||
            (fact.topics !== undefined && (!Array.isArray(fact.topics) || fact.topics.some(topic => typeof topic !== 'string')))) {
          throw new TripError('CONFLICT', '发现事实与本次出行不符')
        }
        candidates.push({
          input: { tripId, kind: fact.kind, sourceKey: `observation:${fact.id}`, title: fact.title, excerpt: fact.excerpt,
            assetPath: fact.assetPath ?? null, sourceUrl: null, sourceMode: null, authorityLevel: null, voteUpCount: null },
          topics: fact.topics ?? [],
        })
      }
      return candidates
    }
    const { finds, eventOmission } = seed ? store.writeSeedBatch(authorization.seed, select)
      : store.writeBatch(tripId, authorization.owner, select)
    const reasons: DiscoveryComposition['reasons'] = []
    if (!seed && !finds.some(find => find.kind === 'zhihu')) reasons.push('NO_REAL_ZHIHU')
    if (finds.length < 3) reasons.push('INSUFFICIENT_FACTS')
    return { status: reasons.length ? 'partial' : 'complete', finds, reasons, ...(eventOmission && { eventOmission }) }
  }

  return Object.assign(
    (tripId: string, owner: OwnerFindScope, input: CompositionInput = {}) => composeBatch(tripId, input, { owner }),
    { forSeed: (seed: SeedFindScope, input: SeedCompositionInput = {}) => {
      // Also enforce the seed boundary for untyped server callers and batch replays.
      if ((input as CompositionInput).searchProofs !== undefined) {
        throw new TripError('CONFLICT', '种子狗出行不接受搜索证明')
      }
      return composeBatch(seed.tripId, input, { seed })
    } },
  )
}
