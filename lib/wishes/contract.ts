import type { DatabaseSync } from 'node:sqlite'
import type { Wish } from '../../contracts/types.ts'
import { INTEREST_CATEGORIES } from '../../contracts/types.ts'

export class WishContractError extends Error {
  code: 'NOT_FOUND' | 'CONFLICT'
  constructor(code: 'NOT_FOUND' | 'CONFLICT', message: string) {
    super(message)
    this.code = code
  }
}

/** Trusted server import boundary, not evidence that content exists or OAuth succeeded. */
export function canonicalZhihuContentUrl(input: unknown): string {
  const invalid = (): never => { throw new WishContractError('CONFLICT', 'Invalid Zhihu content URL') }
  if (typeof input !== 'string' || [...input].some(char =>
    char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === '\\')) return invalid()
  // Validate the raw authority/path before URL can normalize credentials, dot
  // segments, encoded hosts, backslashes or whitespace into a different address.
  const match = input.match(/^https:\/\/(www\.zhihu\.com|zhihu\.com|zhuanlan\.zhihu\.com)(\/[^?#]*)(?:[?#][^\s\\]*)?$/i)
  if (!match) return invalid()
  const host = match[1].toLowerCase()
  const path = match[2].replace(/\/$/, '')
  if (host === 'zhuanlan.zhihu.com' && /^\/p\/[1-9][0-9]*$/.test(path)) {
    return `https://zhuanlan.zhihu.com${path}`
  }
  if (host !== 'zhuanlan.zhihu.com' && /^\/question\/[1-9][0-9]*(?:\/answer\/[1-9][0-9]*)?$/.test(path)) {
    return `https://www.zhihu.com${path}`
  }
  return invalid()
}

type WishRow = {
  id: string; dog_id: string; text: string; category: Wish['category']
  created_at: string; revoked_at: string | null; source: Wish['source']; source_url: string | null
}
export function wishDto(row: WishRow): Wish {
  return { id: row.id, dogId: row.dog_id, text: row.text, category: row.category,
    createdAt: row.created_at, revokedAt: row.revoked_at, source: row.source, sourceUrl: row.source_url }
}

function requireDog(db: DatabaseSync, dogId: string, sessionId: string) {
  if (!sessionId || !db.prepare('SELECT 1 FROM dog WHERE id = ? AND session_id = ?').get(dogId, sessionId)) {
    throw new WishContractError('NOT_FOUND', 'Dog not found')
  }
}

/** B can reuse this strict public-body allowlist; this does not create a wish. */
export function ownerWishFields(input: unknown): Pick<Wish, 'text' | 'category' | 'source' | 'sourceUrl'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WishContractError('CONFLICT', 'Expected wish object')
  }
  const fields = input as Record<string, unknown>
  if (Object.keys(fields).some(key => !['text', 'category'].includes(key)) ||
      typeof fields.text !== 'string' || !fields.text.trim() || [...fields.text.trim()].length > 200 ||
      !INTEREST_CATEGORIES.includes(fields.category as Wish['category'])) {
    throw new WishContractError('CONFLICT', 'Expected only valid text and category')
  }
  return { text: fields.text, category: fields.category as Wish['category'], source: 'owner', sourceUrl: null }
}

/** Internal authorized collection pipeline only. B supplies verified OAuth material,
 * never a public request body. Caller holds its insertion transaction/ownership lock.
 * This validates provenance fields, not OAuth eligibility or extraction business rules.
 */
export function collectionWishFields(db: DatabaseSync, dogId: string, sessionId: string, sourceUrl: unknown)
  : Pick<Wish, 'source' | 'sourceUrl'> {
  requireDog(db, dogId, sessionId)
  return { source: 'collection', sourceUrl: canonicalZhihuContentUrl(sourceUrl) }
}

/** C5/C6 selection boundary. Call inside the trip-start write transaction.
 * Source priority only: blocked_topics filtering remains mandatory before search.
 * Deterministic tie-break among owner wishes: most recently created, then id ASC.
 */
export function selectActiveWish(db: DatabaseSync, dogId: string, sessionId: string): Wish | null {
  requireDog(db, dogId, sessionId)
  const row = db.prepare(`SELECT w.* FROM v_wish_active w JOIN dog d ON d.id = w.dog_id
    WHERE w.dog_id = ? AND d.session_id = ?
    ORDER BY CASE w.source WHEN 'owner' THEN 0 ELSE 1 END, julianday(w.created_at) DESC, w.id ASC
    LIMIT 1`).get(dogId, sessionId) as WishRow | undefined
  return row ? wishDto(row) : null
}

/** B's withdrawal boundary: one guarded write; returns the unchanged record on retry.
 * The authenticated session argument must come from lib/auth/session.ts, never HTTP fields.
 */
export function revokeWish(db: DatabaseSync, wishId: string, sessionId: string, at: string): Wish {
  db.exec('BEGIN IMMEDIATE')
  try {
    const owned = db.prepare(`SELECT w.* FROM wish w JOIN dog d ON d.id = w.dog_id
      WHERE w.id = ? AND d.session_id = ?`)
    if (!sessionId || !owned.get(wishId, sessionId)) throw new WishContractError('NOT_FOUND', 'Wish not found')
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at) || !Number.isFinite(Date.parse(at))) {
      throw new WishContractError('CONFLICT', 'Expected UTC timestamp')
    }
    db.prepare('UPDATE wish SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, wishId)
    const result = wishDto(owned.get(wishId, sessionId) as WishRow)
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Private history reader: deliberately reads wish, not v_wish_active. */
export function readTripWish(db: DatabaseSync, tripId: string, sessionId: string): Wish | null {
  const trip = db.prepare(`SELECT t.wish_id FROM trip t JOIN dog d ON d.id = t.dog_id
    WHERE t.id = ? AND d.session_id = ?`).get(tripId, sessionId)
  if (!sessionId || !trip) throw new WishContractError('NOT_FOUND', 'Trip not found')
  const row = db.prepare('SELECT * FROM wish WHERE id = ?').get(trip.wish_id) as WishRow | undefined
  return row ? wishDto(row) : null
}
