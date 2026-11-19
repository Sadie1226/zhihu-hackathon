// 目标位置：lib/b4/wish-service.ts
// b4 · 心愿读写。唯一写入方：b。字段、类目、错误码全部取自 contracts/。
import 'server-only'
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  INTEREST_CATEGORIES,
  type InterestCategory,
  type Wish,
} from '@/contracts/types'

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

/**
 * GET：默认只回生效心愿。includeRevoked=true 回全部（手账要能翻回去）。
 * 只读，不更新任何状态，也不依赖尚未落地的 v_wish_active 视图。
 */
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
