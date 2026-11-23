import type { ContractError } from '../../contracts/types.ts'
import type { SearchResult } from '../zhihu/client.ts'
import { canonicalZhihuContentUrl } from '../wishes/contract.ts'
import type { FindInput } from './finds.ts'
import { TripError } from './service.ts'

/** Trusted server dependency injection only. Never select a provider from HTTP input. */
export type SearchProvider = (query: string, count: number) => Promise<SearchResult>
export type SearchProof = Readonly<{ readonly verifiedSearch: true }>
type Evidence = { tripId: string; sessionId: string; query: string; category: string; input: FindInput }
const evidence = new WeakMap<SearchProof, Evidence>()
const network = (): ContractError => ({ code: 'NETWORK', detail: '这次没连上，可以再试一次', retriable: true })

export function blockedBy(topics: string[], ...texts: string[]): boolean {
  const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('zh-CN')
  return topics.some(topic => topic.trim() && texts.some(text => normalize(text).includes(normalize(topic.trim()))))
}

/** The default operation always calls the existing server-only C5 entry. Tests inject
 * synthetic operations explicitly; their outputs are not real integration evidence.
 */
export async function searchForTrip(context: { tripId: string; sessionId: string; query: string;
  category: string; blockedTopics: string[] }, provider?: SearchProvider): Promise<
  { ok: true; proof: SearchProof | null; proofs: readonly SearchProof[]; httpStatus: number; fetchedAt: string } |
  { ok: false; error: ContractError; httpStatus: number | null; fallback: 'cache-or-fixture' | null; alert: boolean }
> {
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
    const proofs = inputs.filter(item => !blockedBy(context.blockedTopics, item.title, item.excerpt ?? ''))
      .map(input => {
        const proof: SearchProof = Object.freeze({ verifiedSearch: true })
        evidence.set(proof, { tripId: context.tripId, sessionId: context.sessionId,
          query: context.query, category: context.category, input: Object.freeze(input) })
        return proof
      })
    return { ok: true, proof: proofs[0] ?? null, proofs, httpStatus: result.httpStatus, fetchedAt: result.fetchedAt }
  } catch {
    // Never retain provider exceptions, tokens, request headers or private wish text.
    return { ok: false, error: network(), httpStatus: null, fallback: null, alert: false }
  }
}

/** Called only inside the store write transaction. JSON/clones/foreign sessions fail. */
export function eligibleSearchInput(proof: SearchProof, sessionId: string, blockedTopics: string[]): FindInput | null {
  const value = proof && evidence.get(proof)
  if (!value || !sessionId || value.sessionId !== sessionId || value.input.tripId !== value.tripId) {
    throw new TripError('CONFLICT', '发现来源验证未通过')
  }
  if (blockedBy(blockedTopics, value.query, value.category, value.input.title, value.input.excerpt ?? '')) return null
  return { ...value.input }
}

export function verifiedSearchInput(proof: SearchProof, sessionId: string, blockedTopics: string[]): FindInput {
  const input = eligibleSearchInput(proof, sessionId, blockedTopics)
  if (!input) throw new TripError('CONFLICT', '发现来源验证未通过')
  return input
}

export function proofTripId(proof: SearchProof): string {
  const value = proof && evidence.get(proof)
  if (!value) throw new TripError('CONFLICT', '发现来源验证未通过')
  return value.tripId
}
