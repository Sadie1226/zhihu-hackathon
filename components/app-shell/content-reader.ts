import type { Find } from '../../contracts/types.ts'

export class ContentReadError extends Error {
  status: number
  constructor(status: number) {
    super(status === 404 || status === 401 || status === 403 ? '这条记录不可访问。' : '暂时没读到，可以再试一次。')
    this.status = status
  }
}

/** GET only. Never call finish to obtain return content or replace failures with fixtures. */
export async function readFinds(tripId: string, signal: AbortSignal): Promise<Find[]> {
  const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/finds`, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
  })
  if (!response.ok) throw new ContentReadError(response.status)
  const value = await response.json() as { finds?: Find[] }
  if (!Array.isArray(value.finds) || value.finds.some(row => row.tripId !== tripId))
    throw new ContentReadError(503)
  return value.finds
}

/** Retain source order except for the valid representative; deduplicate by identity. */
export function orderFinds(finds: Find[], representative?: string | null): Find[] {
  const seen = new Set<string>()
  const rows = finds.filter(row => !seen.has(row.id) && !!seen.add(row.id))
  const index = rows.findIndex(row => row.id === representative)
  return index > 0 ? [rows[index], ...rows.slice(0, index), ...rows.slice(index + 1)] : rows
}

export function internalReturnTo(value: string, fallback = '/home'): string {
  // Accept only known application routes, never protocol-relative URLs or encoded escapes.
  return [...value].every(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127) &&
    /^\/(?:home|trip|mailbox|journal)(?:[?#][^\\]*)?$/.test(value) ? value : fallback
}
