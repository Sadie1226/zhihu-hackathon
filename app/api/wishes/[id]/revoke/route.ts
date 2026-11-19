import type { DatabaseSync } from 'node:sqlite'
import { getDatabase } from '@/lib/db/index'
import { readSessionId } from '@/lib/auth/session'
import type { Wish, InterestCategory } from '@/contracts/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }
type WishRow = {
  id: string; dog_id: string; text: string; category: InterestCategory
  created_at: string; revoked_at: string | null
}

const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }
const missing = (): Response => Response.json(
  { code: 'NOT_FOUND', detail: '这条记录不在这里', retriable: false }, { status: 404, headers })
const conflict = (detail: string): Response => Response.json(
  { code: 'CONFLICT', detail, retriable: false }, { status: 409, headers })
const offline = (): Response => Response.json(
  { code: 'NETWORK', detail: '这次没连上，可以再试一次', retriable: true }, { status: 503, headers })

function wishDto(row: WishRow): Wish {
  return {
    id: row.id, dogId: row.dog_id, text: row.text, category: row.category,
    createdAt: row.created_at, revokedAt: row.revoked_at,
  }
}

/** Resolve a wish only through its owning dog + session; unknown means 404. */
function ownedWish(db: DatabaseSync, wishId: string, sessionId: string): WishRow | null {
  const row = db.prepare(`SELECT w.* FROM wish w JOIN dog d ON d.id = w.dog_id
    WHERE w.id = ? AND d.session_id = ?`).get(wishId, sessionId) as WishRow | undefined
  return row ?? null
}

export async function PATCH(request: Request, context: Context) {
  try {
    const session = readSessionId(request)
    if (!session) return missing()
    const url = new URL(request.url)
    if (request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.has('origin') && request.headers.get('origin') !== url.origin)) {
      return conflict('请求来源不匹配')
    }
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return conflict('请求需要 JSON 内容')
    }
    const value: unknown = await request.json().catch(() => conflict('JSON 内容格式不正确'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return conflict('请求需要 JSON 对象')
    if (Object.keys(value as Record<string, unknown>).length > 0) return conflict('请求包含未定义字段')

    const db = getDatabase()
    const wishId = (await context.params).id
    if (!ownedWish(db, wishId, session)) return missing()

    const at = new Date().toISOString()
    db.exec('BEGIN IMMEDIATE')
    let row: WishRow
    try {
      // Idempotent soft revoke: fill revoked_at, never physically delete.
      db.prepare('UPDATE wish SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, wishId)
      db.exec('COMMIT')
      row = ownedWish(db, wishId, session)!
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return Response.json({ wish: wishDto(row) }, { headers })
  } catch {
    return offline()
  }
}
