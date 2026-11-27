import type { ContractError } from '../../contracts/types.ts'
import type { SearchContent, SearchResult } from '../zhihu/client.ts'
import { canonicalZhihuContentUrl } from '../wishes/contract.ts'
import { ownerDiscoveryIntent } from './discovery-receipt.ts'
import type { MemberFilter } from './discovery-receipt.ts'
import { TripError } from './errors.ts'
import type { FindInput } from './finds.ts'
import { isFreshSearchTime, searchCacheKey, utcSearchTime, ZHIHU_CACHE_PROVIDER, ZHIHU_CACHE_VERSION } from './search-cache.ts'
import type { SearchCache, SearchCacheRecord } from './search-cache.ts'

/** Trusted server dependency injection only. */
export type SearchProvider = (query: string, count: number) => Promise<SearchResult>
export type SearchProof = Readonly<{ readonly verifiedSearch: true }>
type SearchScope = { tripId: string; dogId: string; ownerId: string }
type SearchQuery = SearchScope & { query: string; category: string; blockedTopics: string[] }
type ExecutionScope = SearchScope & { intentId: string }
type Evidence = ExecutionScope & { query: string; category: string; fetchedAt: string; input: Readonly<FindInput> }
type Degradation = { code: 'AUTH' | 'RATE_LIMITED'; alert: boolean }
export type SearchCacheOptions = { cache?: SearchCache; now?: () => Date }
type ProofResult = {
  ok: true
  proof: SearchProof | null
  proofs: readonly SearchProof[]
  httpStatus: number | null
  fetchedAt: string | null
  /** Internal only, including when the cache supplies results. */
  degradation?: Degradation
} | {
  ok: false
  error: ContractError
  httpStatus: number | null
  fallback: 'cache-or-fixture' | null
  alert: boolean
}

const evidence = new WeakMap<SearchProof, Evidence>()
const produced = new WeakSet<SearchCacheRecord>()
const count = 3
const network = (): ContractError => ({ code: 'NETWORK', detail: '这次没连上，可以再试一次', retriable: true })

export function normalizeBlockedText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('zh-CN')
}

export function blockedBy(topics: string[], ...texts: string[]): boolean {
  return blockedByNormalizedText(topics, ...texts.map(normalizeBlockedText))
}

export function blockedByNormalizedText(topics: string[], ...texts: string[]): boolean {
  return topics.some(topic => topic.trim() && texts.some(text => text.includes(normalizeBlockedText(topic.trim()))))
}

function verifiedContent(item: SearchContent): Readonly<SearchContent> {
  if (!item || item.sourceMode !== 'live' || typeof item.title !== 'string' || !item.title.trim() ||
      !(item.excerpt === null || typeof item.excerpt === 'string') ||
      (item.authorityLevel !== null && ![1, 2, 3, 4].includes(item.authorityLevel)) ||
      (item.voteUpCount !== null && (!Number.isSafeInteger(item.voteUpCount) || item.voteUpCount < 0))) {
    throw new Error('Invalid search content')
  }
  return Object.freeze({ title: item.title.trim(), excerpt: item.excerpt,
    sourceUrl: canonicalZhihuContentUrl(item.sourceUrl), sourceMode: 'live',
    authorityLevel: item.authorityLevel, voteUpCount: item.voteUpCount })
}

function success(context: SearchQuery & ExecutionScope, items: readonly Readonly<SearchContent>[], sourceMode: 'live' | 'cache',
  fetchedAt: string | null, httpStatus: number | null, degradation?: Degradation): ProofResult {
  const proofs: SearchProof[] = []
  if (fetchedAt !== null && !blockedBy(context.blockedTopics, context.query, context.category)) {
    for (const item of items) {
      if (blockedBy(context.blockedTopics, item.title, item.excerpt ?? '')) continue
      const proof: SearchProof = Object.freeze({ verifiedSearch: true })
      const { tripId, dogId, ownerId, intentId, query, category } = context
      evidence.set(proof, { tripId, dogId, ownerId, intentId, query, category, fetchedAt,
        input: Object.freeze({ ...item, tripId, kind: 'zhihu', sourceMode, assetPath: null }) })
      proofs.push(proof)
    }
  }
  return { ok: true, proof: proofs[0] ?? null, proofs, httpStatus, fetchedAt,
    ...(degradation && { degradation }) }
}

async function cachedResult(cache: SearchCache, key: string, ownerId: string, now: () => Date) {
  try {
    const record = await cache.read(key) as SearchCacheRecord | undefined
    if (record && produced.has(record) && record.key === key && record.ownerId === ownerId &&
        isFreshSearchTime(record.fetchedAt, now().getTime())) return record
  } catch {
    // Adapter errors may contain private data. A failed read yields no evidence.
  }
}

async function storeResult(cache: SearchCache, key: string, ownerId: string,
  fetchedAt: string, items: readonly Readonly<SearchContent>[], now: () => Date) {
  try {
    if (!isFreshSearchTime(fetchedAt, now().getTime())) return
    const record = Object.freeze({ provider: ZHIHU_CACHE_PROVIDER, version: ZHIHU_CACHE_VERSION,
      key, ownerId, fetchedAt, items: Object.freeze(items) })
    await cache.write(key, record)
    produced.add(record)
  } catch {
    // The verified live result remains usable if cache storage is unavailable.
  }
}

/** C5 is called once. Only AUTH and RATE_LIMITED may select a previously verified result. */
export async function searchForTrip(context: SearchQuery & { intentId?: string }, provider?: SearchProvider,
  { cache, now = () => new Date() }: SearchCacheOptions = {}): Promise<ProofResult> {
  const execution = { ...context, intentId: ownerDiscoveryIntent(context.tripId, context.intentId) }
  try {
    const search = provider ?? (await import('../zhihu/index.ts')).searchZhihu
    const result = await search(context.query, count)
    const key = cache ? searchCacheKey(context.ownerId, context.query, context.category, count) : ''
    if (!result.ok) {
      if ((result.httpStatus ?? 0) >= 500 && result.error.code !== 'NETWORK') {
        return { ok: false, error: network(), httpStatus: result.httpStatus, fallback: null, alert: false }
      }
      const { code } = result.error
      if (cache && (code === 'AUTH' || code === 'RATE_LIMITED')) {
        const record = await cachedResult(cache, key, context.ownerId, now)
        return success(execution, record?.items ?? [], 'cache', record?.fetchedAt ?? null, result.httpStatus,
          { code, alert: result.alert })
      }
      return { ok: false, error: result.error, httpStatus: result.httpStatus, fallback: result.fallback, alert: result.alert }
    }
    const { httpStatus, fetchedAt, items: rawItems } = result
    if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300 ||
        !Number.isFinite(utcSearchTime(fetchedAt)) || !Array.isArray(rawItems)) throw new Error('Invalid search response')
    // Validate the whole response before producing either kind of proof or a cache record.
    const items = rawItems.map(verifiedContent)
    if (cache) await storeResult(cache, key, context.ownerId, fetchedAt,
      items.filter(item => !blockedBy(context.blockedTopics, item.title, item.excerpt ?? '')), now)
    return success(execution, items, 'live', fetchedAt, httpStatus)
  } catch {
    return { ok: false, error: network(), httpStatus: null, fallback: null, alert: false }
  }
}

/** The store calls this under the write lock with the current scope and confirmation time. */
export function eligibleSearchInput(proof: SearchProof, scope: ExecutionScope, blockedTopics: string[],
  at: string): { input: FindInput; filter: MemberFilter } | null {
  const value = proof && evidence.get(proof)
  if (!value || value.ownerId !== scope.ownerId || value.dogId !== scope.dogId || value.tripId !== scope.tripId ||
      value.intentId !== scope.intentId) {
    throw new TripError('CONFLICT', '发现来源验证未通过')
  }
  if (value.input.sourceMode === 'cache' && !isFreshSearchTime(value.fetchedAt, Date.parse(at))) return null
  if (blockedBy(blockedTopics, value.query, value.category, value.input.title, value.input.excerpt ?? '')) return null
  const query = normalizeBlockedText(value.query)
  const category = normalizeBlockedText(value.category)
  return { input: { ...value.input }, filter: value.input.sourceMode === 'cache'
    ? ['cache', query, category, value.fetchedAt] : ['search', query, category] }
}

export function verifiedSearchInput(proof: SearchProof, scope: ExecutionScope, blockedTopics: string[], at: string): FindInput {
  const verified = eligibleSearchInput(proof, scope, blockedTopics, at)
  if (!verified) throw new TripError('CONFLICT', '发现来源验证未通过')
  return verified.input
}

export function proofTripId(proof: SearchProof): string {
  const value = proof && evidence.get(proof)
  if (!value) throw new TripError('CONFLICT', '发现来源验证未通过')
  return value.tripId
}
