import type { DatabaseSync } from 'node:sqlite'
import { CATEGORY_KEYWORDS, INTEREST_CATEGORIES } from '../../contracts/types.ts'
import type { InterestCategory } from '../../contracts/types.ts'
import { TripError } from './errors.ts'
import type { OwnerFindScope } from './find-scope.ts'
import { createFindStore } from './finds.ts'
import { createMemorySearchCache } from './search-cache.ts'
import { blockedBy, searchForTrip } from './search-proof.ts'
import type { SearchCacheOptions, SearchProvider } from './search-proof.ts'

const processCache = createMemorySearchCache()

/** Trusted server configuration supplies the provider. Search only, outside the write lock. */
export function createTripDiscoverySearch(db: DatabaseSync, provider?: SearchProvider,
  { cache = processCache, now }: SearchCacheOptions = {}) {
  const store = createFindStore(db, { now })
  return async function search(tripId: string, scope: OwnerFindScope, intentId?: string) {
    if (db.isTransaction) throw new Error('Trip discovery search requires a committed trip')
    const trip = store.prepareOwnerSearch(tripId, scope, intentId)
    const { replay, blockedTopics } = trip
    if (replay) {
      return { ok: true as const, proof: null, proofs: [], httpStatus: null, fetchedAt: null, replay }
    }
    let candidate: { query: string; category: string } | undefined
    if (typeof trip.wishText === 'string' && typeof trip.wishCategory === 'string') {
      const category = trip.wishCategory
      const query = trip.wishText.trim()
      if (!query || [...query].length > 200 || [...query].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
        throw new TripError('CONFLICT', '心愿搜索内容不符合要求')
      }
      if (!blockedBy(blockedTopics, query, category)) candidate = { query, category }
    } else {
      const categories = trip.interestCategories === null ? INTEREST_CATEGORIES
        : JSON.parse(String(trip.interestCategories)) as InterestCategory[]
      for (const category of categories) {
        if (!INTEREST_CATEGORIES.includes(category)) throw new TripError('CONFLICT', '兴趣类目不符合契约')
        const query = CATEGORY_KEYWORDS[category].find(text => !blockedBy(blockedTopics, category, text))
        if (query) { candidate = { query, category }; break }
      }
    }
    if (!candidate) return { ok: true as const, proof: null, proofs: [], httpStatus: null, fetchedAt: null }
    return searchForTrip({ tripId, dogId: trip.dogId, ownerId: trip.ownerId, intentId: trip.intentId,
      ...candidate, blockedTopics }, provider, { cache, now })
  }
}

/** Single Find compatibility entry. HTTP callers pass the same request to both phases. */
export function createTripDiscoverer(db: DatabaseSync, options: SearchCacheOptions & { provider?: SearchProvider } = {}) {
  const store = createFindStore(db, options)
  const search = createTripDiscoverySearch(db, options.provider, options)
  return async function discover(tripId: string, scope: OwnerFindScope, intentId?: string) {
    const result = await search(tripId, scope, intentId)
    if (!result.ok) return result
    if ('replay' in result) return { ok: true as const, ...result.replay, httpStatus: null, fetchedAt: null }
    const saved = store.commitSearchSelection(tripId, result.proof, scope, intentId)
    const diagnostic = 'degradation' in result && { degradation: result.degradation }
    if ('confirmation' in saved) return { ok: true as const, ...saved, httpStatus: null, fetchedAt: null, ...diagnostic }
    return { ok: true as const, ...saved, httpStatus: result.httpStatus, fetchedAt: result.fetchedAt, ...diagnostic }
  }
}
