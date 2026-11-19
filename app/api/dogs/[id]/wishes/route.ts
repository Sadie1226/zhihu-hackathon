import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getDatabase } from '@/lib/db/index'
import { readSessionId } from '@/lib/auth/session'
import { INTEREST_CATEGORIES, type Wish, type InterestCategory } from '@/contracts/types'

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

/** Ownership check mirrors c's trips: an unknown dog or session is always 404. */
function ownedDog(db: DatabaseSync, dogId: string, sessionId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM dog WHERE id = ? AND session_id = ?').get(dogId, sessionId))
}

export async function GET(request: Request, context: Context) {
  try {
    const session = readSessionId(request)
    if (!session) return missing()
    const url = new URL(request.url)
    const keys = [...url.searchParams.keys()]
    if (keys.some(key => key !== 'includeRevoked') || url.searchParams.getAll('includeRevoked').length > 1) {
      return conflict('请求参数不符合心愿接口')
    }
    const raw = url.searchParams.get('includeRevoked') ?? 'false'
    if (raw !== 'true' && raw !== 'false') return conflict('includeRevoked 只能为 true 或 false')
    const includeRevoked = raw === 'true'

    const db = getDatabase()
    const dogId = (await context.params).id
    if (!ownedDog(db, dogId, session)) return missing()
    const rows = db.prepare(
      `SELECT * FROM wish WHERE dog_id = ?${includeRevoked ? '' : ' AND revoked_at IS NULL'}
       ORDER BY created_at DESC, id DESC`,
    ).all(dogId) as WishRow[]
    return Response.json({ wishes: rows.map(wishDto) }, { headers })
  } catch {
    return offline()
  }
}

export async function POST(request: Request, context: Context) {
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
    const body = value as Record<string, unknown>
    if (Object.keys(body).some(key => key !== 'text' && key !== 'category')) {
      return conflict('请求包含未定义字段')
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const length = [...text].length
    if (length < 1 || length > 200) return conflict('心愿请写 1 到 200 字')
    if (typeof body.category !== 'string' || !INTEREST_CATEGORIES.includes(body.category as InterestCategory)) {
      return conflict('category 不符合契约')
    }

    const db = getDatabase()
    const dogId = (await context.params).id
    if (!ownedDog(db, dogId, session)) return missing()

    const at = new Date().toISOString()
    const id = `wish_${randomUUID()}`
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT INTO wish (id, dog_id, text, category, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)')
        .run(id, dogId, text, body.category, at)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    const row = db.prepare('SELECT * FROM wish WHERE id = ?').get(id) as WishRow
    return Response.json({ wish: wishDto(row) }, { headers })
  } catch {
    return offline()
  }
}
