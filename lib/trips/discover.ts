import type { DatabaseSync } from 'node:sqlite'
import { CATEGORY_KEYWORDS, INTEREST_CATEGORIES } from '../../contracts/types.ts'
import type { InterestCategory } from '../../contracts/types.ts'
import { TripError } from './errors.ts'
import { readBlockedTopics, readOwnerFindTrip } from './find-scope.ts'
import type { OwnerFindScope } from './find-scope.ts'
import { createFindStore, isDiscoveryConfirmed } from './finds.ts'
import { createMemorySearchCache } from './search-cache.ts'
import { blockedBy, searchForTrip } from './search-proof.ts'
import type { SearchCacheOptions, SearchProvider } from './search-proof.ts'

const processCache = createMemorySearchCache()

/** Trusted server configuration supplies the provider. Search only, outside the write lock. */
export function createTripDiscoverySearch(db: DatabaseSync, provider?: SearchProvider,
  { cache = processCache, now }: SearchCacheOptions = {}) {
  return async function search(tripId: string, scope: OwnerFindScope) {
    if (db.isTransaction) throw new Error('Trip discovery search requires a committed trip')
    const trip = readOwnerFindTrip(db, tripId, scope)
    if (trip.status !== 'running' || typeof trip.startedAt !== 'string') {
      throw new TripError('CONFLICT', '这次出行尚未运行或已经结束')
    }
    if (isDiscoveryConfirmed(db, tripId)) {
      return { ok: true as const, proof: null, proofs: [], httpStatus: null, fetchedAt: null }
    }
    const blockedTopics = readBlockedTopics(trip.blockedTopics)
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
    return searchForTrip({ tripId, dogId: trip.dogId, ownerId: trip.ownerId, ...candidate, blockedTopics }, provider, { cache, now })
  }
}

/** Single Find compatibility entry. HTTP callers pass the same request to both phases. */
export function createTripDiscoverer(db: DatabaseSync, options: SearchCacheOptions & { provider?: SearchProvider } = {}) {
  const search = createTripDiscoverySearch(db, options.provider, options)
  return async function discover(tripId: string, scope: OwnerFindScope) {
    const result = await search(tripId, scope)
    if (!result.ok) return result
    const finds = result.proof ? [createFindStore(db, options).writeVerified(result.proof, scope)] : []
    return { ok: true as const, finds, httpStatus: result.httpStatus, fetchedAt: result.fetchedAt,
      ...('degradation' in result && { degradation: result.degradation }) }
  }
}
