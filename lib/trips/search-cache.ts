import { createHmac, randomBytes } from 'node:crypto'
import type { SearchContent } from '../zhihu/client.ts'

export const ZHIHU_CACHE_PROVIDER = 'zhihu-search'
export const ZHIHU_CACHE_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000
// Use an opaque per-process index so private queries never appear in storage keys.
const indexKey = randomBytes(32)

export type SearchCacheRecord = Readonly<{
  provider: typeof ZHIHU_CACHE_PROVIDER
  version: typeof ZHIHU_CACHE_VERSION
  key: string
  ownerId: string
  fetchedAt: string
  items: readonly Readonly<SearchContent>[]
}>

/** Adapters store the original record identity. The proof producer validates all reads. */
export interface SearchCache {
  read(key: string): Promise<unknown>
  write(key: string, record: SearchCacheRecord): Promise<void>
}

export function searchCacheKey(ownerId: string, query: string, category: string, count: number): string {
  return createHmac('sha256', indexKey).update(JSON.stringify([
    ZHIHU_CACHE_PROVIDER, ZHIHU_CACHE_VERSION, ownerId, query.trim(), category, count,
  ])).digest('hex')
}

export function utcSearchTime(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return NaN
  const time = Date.parse(value)
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) =>
    `.${(fraction ?? '').padEnd(3, '0')}Z`)
  return Number.isFinite(time) && new Date(time).toISOString() === canonical ? time : NaN
}

export function isFreshSearchTime(fetchedAt: unknown, now: number): boolean {
  const age = now - utcSearchTime(fetchedAt)
  return age >= 0 && age < DAY_MS
}

/** Bounded, process-local storage. Reads preserve the original record and acquisition time. */
export function createMemorySearchCache(): SearchCache {
  const records = new Map<string, SearchCacheRecord>()
  return {
    async read(key) {
      return records.get(key)
    },
    async write(key, record) {
      const previous = records.get(key)
      if (previous && utcSearchTime(previous.fetchedAt) > utcSearchTime(record.fetchedAt)) return
      records.delete(key)
      records.set(key, record)
      if (records.size > 256) {
        const oldest = records.keys().next()
        if (!oldest.done) records.delete(oldest.value)
      }
    },
  }
}
