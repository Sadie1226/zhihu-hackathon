// 目标位置：app/api/dogs/[id]/wishes/route.ts
// B 的薄 HTTP 适配层。业务边界复用 C 的 lib/wishes/contract.ts，不在路由里另写 wishDto / 撤销。
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getDatabase } from '@/lib/db/index'
import { readSessionId } from '@/lib/auth/session'
import { ownerWishFields, wishDto, WishContractError } from '@/lib/wishes/contract'
import type { Wish } from '@/contracts/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }
type WishRow = Parameters<typeof wishDto>[0]

const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ code, detail, retriable: status >= 500 }, { status, headers })
}
const missing = (): Response => fail(404, 'NOT_FOUND', '这条记录不在这里')
const conflict = (detail: string): Response => fail(409, 'CONFLICT', detail)
const offline = (): Response => fail(503, 'NETWORK', '这次没连上，可以再试一次')

/** C 的契约错误在 HTTP 边界统一翻译成状态码；其余异常不当作业务成功。 */
function contractFail(error: unknown): Response {
  if (error instanceof WishContractError) {
    return error.code === 'NOT_FOUND' ? missing() : conflict('心愿内容不符合要求')
  }
  return offline()
}

function ownedDog(db: DatabaseSync, dogId: string, sessionId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM dog WHERE id = ? AND session_id = ?').get(dogId, sessionId))
}

function crossSite(request: Request): boolean {
  const url = new URL(request.url)
  const expectedOrigin = request.headers.has('host') ? `${url.protocol}//${request.headers.get('host')}` : url.origin
  return request.headers.get('sec-fetch-site') === 'cross-site' ||
    (request.headers.has('origin') && request.headers.get('origin') !== expectedOrigin)
}

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const sessionId = readSessionId(request)
    if (!sessionId) return missing()

    const url = new URL(request.url)
    const keys = [...url.searchParams.keys()]
    if (keys.some(key => key !== 'includeRevoked') ||
        url.searchParams.getAll('includeRevoked').length > 1) {
      return conflict('请求参数不符合心愿接口')
    }
    const raw = url.searchParams.get('includeRevoked') ?? 'false'
    if (raw !== 'true' && raw !== 'false') return conflict('includeRevoked 只能为 true 或 false')
    const includeRevoked = raw === 'true'

    const db = getDatabase()
    const dogId = (await context.params).id
    if (!ownedDog(db, dogId, sessionId)) return missing()

    // 有效心愿读 C 的视图；私有历史读基础表。两张表的列一致，DTO 仍由 C 提供。
    const source = includeRevoked ? 'wish' : 'v_wish_active'
    const rows = db.prepare(
      `SELECT * FROM ${source} WHERE dog_id = ? ORDER BY created_at DESC, id DESC`,
    ).all(dogId) as WishRow[]
    const wishes: Wish[] = rows.map(wishDto)
    return Response.json({ wishes }, { headers })
  } catch (error) {
    return contractFail(error)
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const sessionId = readSessionId(request)
    if (!sessionId) return missing()
    if (crossSite(request)) return conflict('请求来源不匹配')
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return conflict('请求需要 JSON 内容')
    }

    const value: unknown = await request.json().catch(() => null)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return conflict('请求需要 JSON 对象')
    const body = value as Record<string, unknown>
    // 公共表单只收 text / category；来源字段由 C 的 ownerWishFields 固定为 owner/null。
    if (Object.keys(body).some(key => key !== 'text' && key !== 'category')) {
      return conflict('请求包含未定义字段')
    }
    const fields = ownerWishFields({
      text: typeof body.text === 'string' ? body.text.trim() : body.text,
      category: body.category,
    })

    const db = getDatabase()
    const dogId = (await context.params).id
    if (!ownedDog(db, dogId, sessionId)) return missing()

    const at = new Date().toISOString()
    const id = `wish_${randomUUID()}`
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `INSERT INTO wish (id, dog_id, text, category, created_at, revoked_at, source, source_url)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(id, dogId, fields.text, fields.category, at, fields.source, fields.sourceUrl)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      if (String(error).includes('CONSTRAINT')) throw new WishContractError('CONFLICT', '心愿写入被契约拒绝')
      throw error
    }
    const row = db.prepare('SELECT * FROM wish WHERE id = ?').get(id) as WishRow
    return Response.json({ wish: wishDto(row) }, { headers })
  } catch (error) {
    return contractFail(error)
  }
}
