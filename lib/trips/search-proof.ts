import type { ContractError } from '../../contracts/types.ts'
import type { SearchResult } from '../zhihu/client.ts'
import { canonicalZhihuContentUrl } from '../wishes/contract.ts'
import { ownerDiscoveryIntent } from './discovery-receipt.ts'
import type { FindInput } from './finds.ts'
import { TripError } from './errors.ts'

/** Trusted server dependency injection only. Never select a provider from HTTP input. */
export type SearchProvider = (query: string, count: number) => Promise<SearchResult>
export type SearchProof = Readonly<{ readonly verifiedSearch: true }>
type SearchScope = { tripId: string; dogId: string; ownerId: string }
type Evidence = SearchScope & { intentId: string; query: string; category: string; input: FindInput }
const evidence = new WeakMap<SearchProof, Evidence>()
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

/** The default operation always calls the existing server-only C5 entry. Tests inject
 * synthetic operations explicitly; their outputs are not real integration evidence.
 */
export async function searchForTrip(context: SearchScope & { intentId?: string; query: string;
  category: string; blockedTopics: string[] }, provider?: SearchProvider): Promise<
  { ok: true; proof: SearchProof | null; proofs: readonly SearchProof[]; httpStatus: number; fetchedAt: string } |
  { ok: false; error: ContractError; httpStatus: number | null; fallback: 'cache-or-fixture' | null; alert: boolean }
> {
  const intentId = ownerDiscoveryIntent(context.tripId, context.intentId)
  try {
    const search = provider ?? (await import('../zhihu/index.ts')).searchZhihu
    const result = await search(context.query, 3)
    if (!result.ok) return { ok: false, error: result.error, httpStatus: result.httpStatus,
      fallback: result.fallback, alert: result.alert }
    if (!Number.isInteger(result.httpStatus) || result.httpStatus < 200 || result.httpStatus >= 300 ||
        !Number.isFinite(Date.parse(result.fetchedAt)) || !Array.isArray(result.items)) throw new Error('Invalid operation')
    // Validate the whole returned collection before any write, including injected providers.
    const inputs = result.items.map(item => {
      if (!item || item.sourceMode !== 'live' || typeof item.title !== 'string' || !item.title.trim() ||
          !(item.excerpt === null || typeof item.excerpt === 'string') ||
          (item.authorityLevel !== null && ![1, 2, 3, 4].includes(item.authorityLevel)) ||
          (item.voteUpCount !== null && (!Number.isSafeInteger(item.voteUpCount) || item.voteUpCount < 0))) {
        throw new Error('Invalid content')
      }
      return { tripId: context.tripId, kind: 'zhihu' as const, title: item.title.trim(), excerpt: item.excerpt,
        sourceUrl: canonicalZhihuContentUrl(item.sourceUrl), sourceMode: 'live' as const,
        authorityLevel: item.authorityLevel, voteUpCount: item.voteUpCount, assetPath: null }
    })
    // C9 can add a separate proof producer here after validating the original fetchedAt and cache scope.
    const proofs = inputs.filter(item => !blockedBy(context.blockedTopics, item.title, item.excerpt ?? ''))
      .map(input => {
        const proof: SearchProof = Object.freeze({ verifiedSearch: true })
        evidence.set(proof, { tripId: context.tripId, dogId: context.dogId, ownerId: context.ownerId, intentId,
          query: context.query, category: context.category, input: Object.freeze(input) })
        return proof
      })
    return { ok: true, proof: proofs[0] ?? null, proofs, httpStatus: result.httpStatus, fetchedAt: result.fetchedAt }
  } catch {
    // Never retain provider exceptions, tokens, request headers or private wish text.
    return { ok: false, error: network(), httpStatus: null, fallback: null, alert: false }
  }
}

/** The store calls this under the write lock with the current owner, dog and blocks. */
export function eligibleSearchInput(proof: SearchProof, scope: SearchScope & { intentId: string }, blockedTopics: string[]) {
  const value = proof && evidence.get(proof)
  if (!value || value.ownerId !== scope.ownerId || value.dogId !== scope.dogId || value.tripId !== scope.tripId ||
      value.intentId !== scope.intentId) {
    throw new TripError('CONFLICT', '发现来源验证未通过')
  }
  if (blockedBy(blockedTopics, value.query, value.category, value.input.title, value.input.excerpt ?? '')) return null
  return { input: { ...value.input },
    filter: ['search', normalizeBlockedText(value.query), normalizeBlockedText(value.category)] as const }
}

export function verifiedSearchInput(proof: SearchProof, scope: SearchScope & { intentId: string }, blockedTopics: string[]): FindInput {
  const verified = eligibleSearchInput(proof, scope, blockedTopics)
  if (!verified) throw new TripError('CONFLICT', '发现来源验证未通过')
  return verified.input
}

export function proofTripId(proof: SearchProof): string {
  const value = proof && evidence.get(proof)
  if (!value) throw new TripError('CONFLICT', '发现来源验证未通过')
  return value.tripId
}
