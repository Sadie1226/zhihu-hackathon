// b4 · 心愿契约层。字段、类目、错误码全部取自 contracts/，路由只做转发。
// 唯一写入方：b。撤销＝填 revoked_at，不物理删除（手账要能翻回去）。
import 'server-only'
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { readSessionId } from '@/lib/auth/session'
import {
  INTEREST_CATEGORIES,
  type InterestCategory,
  type Wish,
} from '@/contracts/types'

type GetDatabase = () => DatabaseSync
export type WishErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'NETWORK'

export class WishError extends Error {
  constructor(
    readonly code: WishErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export const wishHeaders = {
  'Cache-Control': 'no-store',
  Vary: 'Cookie',
} as const

type WishRow = {
  id: string
  dog_id: string
  text: string
  category: string
  created_at: string
  revoked_at: string | null
}

/** 全项目时间口径：UTC ISO-8601，不带毫秒。 */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 数据库 snake_case → API camelCase，只在边界转换一次。 */
export function fromWishRow(row: WishRow): Wish {
  if (!(INTEREST_CATEGORIES as readonly string[]).includes(row.category)) {
    throw new WishError('NETWORK', '心愿类目无法识别', 503)
  }
  return {
    id: row.id,
    dogId: row.dog_id,
    text: row.text,
    category: row.category as InterestCategory,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }
}

function assertOwnedDog(db: DatabaseSync, dogId: string, sessionId: string): void {
  const found = db
    .prepare('SELECT 1 AS ok FROM dog WHERE id = ? AND session_id = ?')
    .get(dogId, sessionId)
  if (!found) throw new WishError('NOT_FOUND', '这条记录不在这里', 404)
}

function isForeignKeyError(error: unknown): boolean {
  return error instanceof Error && /FOREIGN KEY/i.test(error.message)
}

/** GET：默认只回生效心愿。includeRevoked=true 回全部。不依赖尚未落地的视图。 */
export function listWishes(
  db: DatabaseSync,
  dogId: string,
  sessionId: string,
  includeRevoked: boolean,
): Wish[] {
  assertOwnedDog(db, dogId, sessionId)
  const sql =
    'SELECT id, dog_id, text, category, created_at, revoked_at FROM wish WHERE dog_id = ? ' +
    (includeRevoked ? '' : 'AND revoked_at IS NULL ') +
    'ORDER BY created_at DESC, id DESC'
  const rows = db.prepare(sql).all(dogId) as WishRow[]
  return rows.map(fromWishRow)
}

/** POST：text 1–200 字（去空白，标点算一字）；category 必须取自契约六类。 */
export function createWish(
  db: DatabaseSync,
  dogId: string,
  sessionId: string,
  body: unknown,
): Wish {
  assertOwnedDog(db, dogId, sessionId)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WishError('CONFLICT', '请求需要 JSON 对象', 409)
  }
  const input = body as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.length !== 2 || !keys.includes('text') || !keys.includes('category')) {
    throw new WishError('CONFLICT', '请求包含未定义字段', 409)
  }
  const { text, category } = input
  if (typeof text !== 'string') {
    throw new WishError('CONFLICT', '心愿请写 1 到 200 字', 409)
  }
  const value = text.trim()
  const length = Array.from(value).length
  if (length < 1 || length > 200) {
    throw new WishError('CONFLICT', '心愿请写 1 到 200 字', 409)
  }
  if (
    typeof category !== 'string' ||
    !(INTEREST_CATEGORIES as readonly string[]).includes(category)
  ) {
    throw new WishError('CONFLICT', '类目不在可选范围内', 409)
  }

  const wish: Wish = {
    id: `wish_${randomBytes(12).toString('hex')}`,
    dogId,
    text: value,
    category: category as InterestCategory,
    createdAt: nowIso(),
    revokedAt: null,
  }
  try {
    db.prepare(
      `INSERT INTO wish (id, dog_id, text, category, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(wish.id, wish.dogId, wish.text, wish.category, wish.createdAt)
  } catch (error) {
    if (isForeignKeyError(error)) {
      throw new WishError('NOT_FOUND', '这条记录不在这里', 404)
    }
    throw new WishError('CONFLICT', '心愿没能存下，请检查内容', 409)
  }
  return wish
}

/**
 * PATCH：撤销＝填 revoked_at，不物理删除。
 * WHERE 带 revoked_at IS NULL，重复撤销不覆盖第一次的时间戳（手账要能翻回去）。
 */
export function revokeWish(
  db: DatabaseSync,
  wishId: string,
  sessionId: string,
): Wish {
  const read = () =>
    db.prepare(
      `SELECT w.id, w.dog_id, w.text, w.category, w.created_at, w.revoked_at
       FROM wish w JOIN dog d ON d.id = w.dog_id
       WHERE w.id = ? AND d.session_id = ?`,
    ).get(wishId, sessionId) as WishRow | undefined

  const current = read()
  if (!current) throw new WishError('NOT_FOUND', '这条记录不在这里', 404)
  if (current.revoked_at !== null) return fromWishRow(current)

  const revokedAt = nowIso()
  const result = db.prepare(
    `UPDATE wish SET revoked_at = ?
     WHERE id = ? AND revoked_at IS NULL
       AND dog_id IN (SELECT id FROM dog WHERE session_id = ?)`,
  ).run(revokedAt, wishId, sessionId)

  if (Number(result.changes) === 0) {
    const latest = read()
    if (!latest) throw new WishError('NOT_FOUND', '这条记录不在这里', 404)
    return fromWishRow(latest)
  }
  return { ...fromWishRow(current), revokedAt }
}

function fail(error: unknown): Response {
  if (error instanceof WishError) {
    return Response.json(
      {
        code: error.code,
        detail: error.message,
        retriable: error.code === 'NETWORK',
      },
      { status: error.status, headers: wishHeaders },
    )
  }
  return Response.json(
    { code: 'NETWORK', detail: '这次没连上，可以再试一次', retriable: true },
    { status: 503, headers: wishHeaders },
  )
}

function requireSession(request: Request): string {
  const session = readSessionId(request)
  if (!session) throw new WishError('NOT_FOUND', '这条记录不在这里', 404)
  return session
}

function checkOrigin(request: Request): void {
  const url = new URL(request.url)
  const origin = request.headers.get('origin')
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (origin !== null && origin !== url.origin)
  ) {
    throw new WishError('CONFLICT', '请求来源不匹配', 409)
  }
}

/** GET /api/dogs/:id/wishes?includeRevoked=false */
export async function handleWishList(
  request: Request,
  dogId: string,
  getDatabase: GetDatabase,
): Promise<Response> {
  try {
    const session = requireSession(request)
    const url = new URL(request.url)
    const raw = url.searchParams.get('includeRevoked') ?? 'false'
    const keys = [...url.searchParams.keys()]
    if (
      keys.some((key) => key !== 'includeRevoked') ||
      url.searchParams.getAll('includeRevoked').length > 1 ||
      (raw !== 'true' && raw !== 'false')
    ) {
      throw new WishError('CONFLICT', '请求参数不符合心愿接口', 409)
    }
    const wishes = listWishes(getDatabase(), dogId, session, raw === 'true')
    return Response.json({ wishes }, { headers: wishHeaders })
  } catch (error) {
    return fail(error)
  }
}

/** POST /api/dogs/:id/wishes */
export async function handleWishCreate(
  request: Request,
  dogId: string,
  getDatabase: GetDatabase,
): Promise<Response> {
  try {
    const session = requireSession(request)
    checkOrigin(request)
    const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      throw new WishError('CONFLICT', '请求需要 JSON 内容', 409)
    }
    const body: unknown = await request.json().catch(() => {
      throw new WishError('CONFLICT', 'JSON 内容格式不正确', 409)
    })
    const wish = createWish(getDatabase(), dogId, session, body)
    return Response.json({ wish }, { headers: wishHeaders })
  } catch (error) {
    return fail(error)
  }
}

/** PATCH /api/wishes/:id/revoke —— 入参是 {}，不接收客户端时间或归属。 */
export async function handleWishRevoke(
  request: Request,
  wishId: string,
  getDatabase: GetDatabase,
): Promise<Response> {
  try {
    const session = requireSession(request)
    checkOrigin(request)
    const wish = revokeWish(getDatabase(), wishId, session)
    return Response.json({ wish }, { headers: wishHeaders })
  } catch (error) {
    return fail(error)
  }
}
