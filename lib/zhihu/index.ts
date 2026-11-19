import 'server-only'
import { createZhihuSearchClient } from './client.ts'

/** Server entry. Next.js loads .env; standalone verification explicitly loads its supplied .env path. */
export function searchZhihu(query: string, count = 3) {
  return createZhihuSearchClient({ accessSecret: process.env.ZHIHU_ACCESS_SECRET })(query, count)
}

export type { SearchContent, SearchResult } from './client.ts'
