import type { ContractError, Find } from '../../contracts/types.ts'

export const SEARCH_ENDPOINT = 'https://developer.zhihu.com/api/v1/content/zhihu_search'
export type SearchContent = Pick<Find, 'title' | 'excerpt' | 'authorityLevel' | 'voteUpCount'> & {
  sourceUrl: string
  sourceMode: 'live'
}
export type SearchResult = {
  ok: true
  items: SearchContent[]
  httpStatus: number
  fetchedAt: string
  responseFields: { envelope: string[]; data: string[]; item: string[] }
} | {
  ok: false
  error: ContractError
  httpStatus: number | null
  upstreamCode: number | null
  /** AUTH/RATE_LIMITED stay internal; a later C9 caller supplies truthfully labeled fallback. */
  fallback: 'cache-or-fixture' | null
  alert: boolean
}

type Options = {
  accessSecret: string | undefined
  fetch?: typeof globalThis.fetch
  now?: () => number
  timeoutMs?: number
}
type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function failure(code: ContractError['code'], httpStatus: number | null = null, upstreamCode: number | null = null): SearchResult {
  const details: Partial<Record<ContractError['code'], string>> = {
    AUTH: 'Zhihu credentials unavailable or rejected', RATE_LIMITED: 'Zhihu rate limit reached',
    CONFLICT: 'Invalid Zhihu search parameters', NETWORK: 'Zhihu search unavailable or invalid response',
  }
  return { ok: false, error: { code, detail: details[code] ?? '', retriable: code === 'NETWORK' },
    httpStatus, upstreamCode, fallback: code === 'AUTH' || code === 'RATE_LIMITED' ? 'cache-or-fixture' : null,
    alert: code === 'AUTH' }
}

/** Returned text is plain data: remove upstream highlighting/HTML; never render it as HTML. */
function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity =>
    ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity]!)
    .trim()
}

/** Preserve the upstream path/answer ID; never invent a URL from a title or query. */
function contentUrl(value: unknown): string | null {
  if (typeof value !== 'string' || /\s|\\/.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    const valid = (['www.zhihu.com', 'zhihu.com'].includes(url.hostname) &&
      /^\/question\/[1-9][0-9]*(?:\/answer\/[1-9][0-9]*)?\/?$/.test(url.pathname)) ||
      (url.hostname === 'zhuanlan.zhihu.com' && /^\/p\/[1-9][0-9]*\/?$/.test(url.pathname))
    if (!valid) return null
    url.search = ''; url.hash = ''
    return url.href
  } catch { return null }
}

/** Protocol core: server supplies the secret; no env access, logging, retries, storage or HTTP route here.
 * Data.Items and string AuthorityLevel were verified against a real response on 2026-11-19.
 */
export function createZhihuSearchClient(options: Options) {
  const timeoutMs = options.timeoutMs ?? 15000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) {
    throw new Error('timeoutMs must be between 1 and 60000')
  }
  return async function search(query: string, count = 3): Promise<SearchResult> {
    if (typeof query !== 'string' || !query.trim() || !Number.isSafeInteger(count) || count < 1 || count > 10) {
      return failure('CONFLICT')
    }
    const secret = options.accessSecret?.trim()
    if (!secret) return failure('AUTH')
    const url = new URL(SEARCH_ENDPOINT)
    url.searchParams.set('Query', query.trim())
    url.searchParams.set('Count', String(count))
    let httpStatus: number | null = null
    try {
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${secret}`,
          'X-Request-Timestamp': String(Math.floor((options.now ?? Date.now)() / 1000)),
          Accept: 'application/json', 'Content-Type': 'application/json' },
      })
      httpStatus = response.status
      // Read once, keeping HTTP authentication/rate-limit meaning even for a non-JSON body.
      let body: unknown
      try { body = await response.json() } catch { body = null }
      const rawCode = object(body) ? body.Code : null
      const code = typeof rawCode === 'number' && Number.isSafeInteger(rawCode) ? rawCode
        : typeof rawCode === 'string' && /^\d+$/.test(rawCode) ? Number(rawCode) : null
      if (httpStatus === 429 || code === 30001) return failure('RATE_LIMITED', httpStatus, code)
      if (httpStatus === 401 || httpStatus === 403 || code === 20001) return failure('AUTH', httpStatus, code)
      if (code === 10001) return failure('CONFLICT', httpStatus, code)
      if (!response.ok || code !== 0 || !object(body) || !object(body.Data) || !Array.isArray(body.Data.Items)) {
        return failure('NETWORK', httpStatus, code)
      }
      const items: SearchContent[] = []
      const seen = new Set<string>()
      for (const item of body.Data.Items) {
        if (!object(item)) return failure('NETWORK', httpStatus, code)
        const sourceUrl = contentUrl(item.Url)
        // Never return an unsafe link, raw metadata, or any upstream reflection of the credential.
        if (!sourceUrl || typeof item.Title !== 'string' || !plainText(item.Title) ||
            (item.ContentText !== undefined && item.ContentText !== null && typeof item.ContentText !== 'string')) {
          return failure('NETWORK', httpStatus, code)
        }
        const title = plainText(item.Title)
        const excerpt = typeof item.ContentText === 'string' ? plainText(item.ContentText) : null
        if ([item.Title, item.ContentText, title, excerpt, sourceUrl]
          .some(value => typeof value === 'string' && value.includes(secret))) {
          return failure('NETWORK', httpStatus, code)
        }
        // The live API returns AuthorityLevel as "1".."4"; K stores a numeric enum.
        const authority = typeof item.AuthorityLevel === 'string' && /^[1-4]$/.test(item.AuthorityLevel)
          ? Number(item.AuthorityLevel) : item.AuthorityLevel
        const votes = item.VoteUpCount
        if (authority !== undefined && authority !== null && ![1, 2, 3, 4].includes(authority as number)) {
          return failure('NETWORK', httpStatus, code)
        }
        if (votes !== undefined && votes !== null && (typeof votes !== 'number' || !Number.isSafeInteger(votes) || votes < 0)) {
          return failure('NETWORK', httpStatus, code)
        }
        if (!seen.has(sourceUrl)) {
          seen.add(sourceUrl)
          items.push({ title, excerpt,
            sourceUrl, sourceMode: 'live', authorityLevel: (authority ?? null) as Find['authorityLevel'],
            voteUpCount: (votes ?? null) as number | null })
        }
      }
      items.sort((a, b) => (b.authorityLevel ?? 0) - (a.authorityLevel ?? 0) ||
        (b.voteUpCount ?? 0) - (a.voteUpCount ?? 0))
      const fields = (value: ObjectValue, allowed: string[]) => allowed.filter(key => Object.hasOwn(value, key))
      return { ok: true, items: items.slice(0, count), httpStatus, fetchedAt: new Date((options.now ?? Date.now)()).toISOString(),
        responseFields: { envelope: fields(body, ['Code', 'Message', 'Data']),
          data: fields(body.Data, ['Items', 'HasMore', 'SearchHashId']),
          item: object(body.Data.Items[0]) ? fields(body.Data.Items[0], ['Title', 'ContentText', 'Url', 'AuthorityLevel', 'VoteUpCount']) : [] } }
    } catch {
      // Transport exceptions may contain request headers: do not retain cause/message or response bodies.
      return failure('NETWORK', httpStatus)
    }
  }
}
