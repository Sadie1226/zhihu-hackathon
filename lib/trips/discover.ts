import type { DatabaseSync } from 'node:sqlite'
import { CATEGORY_KEYWORDS, INTEREST_CATEGORIES } from '../../contracts/types.ts'
import type { InterestCategory } from '../../contracts/types.ts'
import { readTripWish } from '../wishes/contract.ts'
import { createFindStore } from './finds.ts'
import { blockedBy, searchForTrip } from './search-proof.ts'
import type { SearchProvider } from './search-proof.ts'
import { createTripService, TripError } from './service.ts'

/** Internal server executor, not an HTTP handler or an automatic scheduler.
 * sessionId must come from readSessionId; no caller-supplied query/mode/time fields.
 * Provider/clock overrides are trusted server test configuration, never request data.
 */
export function createTripDiscoverer(db: DatabaseSync, options: { provider?: SearchProvider; now?: () => Date } = {}) {
  return async function discover(tripId: string, sessionId: string) {
    if (!sessionId || !tripId) throw new TripError('NOT_FOUND', '这条记录不在这里')
    const trip = createTripService(db).get(tripId, sessionId)
    if (trip.status !== 'running' || !trip.startedAt) throw new TripError('CONFLICT', '这次出行尚未运行或已经结束')
    const dog = db.prepare('SELECT interest_categories,blocked_topics,is_sample FROM dog WHERE id=? AND session_id=?')
      .get(trip.dogId, sessionId)!
    if (dog.is_sample === 1) throw new TripError('CONFLICT', '示例伙伴不执行真实搜索')
    const blockedTopics = JSON.parse(String(dog.blocked_topics)) as string[]
    let candidate: { query: string; category: string } | undefined
    const wish = trip.trigger === 'wish' ? readTripWish(db, tripId, sessionId) : null
    if (wish) {
      // Use only the wish fixed at start; do not replace historical provenance on retry.
      const query = wish.text.trim()
      if (!query || [...query].length > 200 || [...query].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
        throw new TripError('CONFLICT', '心愿搜索内容不符合要求')
      }
      if (!blockedBy(blockedTopics, query, wish.category)) candidate = { query, category: wish.category }
    } else {
      const categories = dog.interest_categories === null ? INTEREST_CATEGORIES
        : JSON.parse(String(dog.interest_categories)) as InterestCategory[]
      for (const category of categories) {
        if (!INTEREST_CATEGORIES.includes(category)) throw new TripError('CONFLICT', '兴趣类目不符合契约')
        const query = CATEGORY_KEYWORDS[category].find(text => !blockedBy(blockedTopics, category, text))
        if (query) { candidate = { query, category }; break }
      }
    }
    if (!candidate) return { ok: true as const, finds: [], httpStatus: null, fetchedAt: null }
    // No SQLite transaction spans this await. C4 can finish while the provider runs.
    const result = await searchForTrip({ tripId, sessionId, ...candidate, blockedTopics }, options.provider)
    if (!result.ok) return result // internal only: AUTH/RATE_LIMITED are never sent to UI here
    const finds = result.proof ? [createFindStore(db, { now: options.now }).writeVerified(result.proof, sessionId)] : []
    return { ok: true as const, finds, httpStatus: result.httpStatus, fetchedAt: result.fetchedAt }
  }
}
