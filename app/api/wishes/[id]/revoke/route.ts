// 目标位置：app/api/wishes/[id]/revoke/route.ts
// 撤销的归属、事务与首次时间守卫全部复用 C 的 revokeWish；本文件只做 HTTP 边界。
import { getDatabase } from '@/lib/db/index'
import { resolveAuthContext } from '@/lib/auth/session'
import { revokeWish, WishContractError } from '@/lib/wishes/contract'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ code, detail, retriable: status >= 500 }, { status, headers })
}
const missing = (): Response => fail(404, 'NOT_FOUND', '这条记录不在这里')
const conflict = (detail: string): Response => fail(409, 'CONFLICT', detail)
const offline = (): Response => fail(503, 'NETWORK', '这次没连上，可以再试一次')

function contractFail(error: unknown): Response {
  if (error instanceof WishContractError) {
    return error.code === 'NOT_FOUND' ? missing() : conflict('撤销请求不符合要求')
  }
  return offline()
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  try {
    if (!resolveAuthContext(request, getDatabase)) return missing()

    const url = new URL(request.url)
    const expectedOrigin = request.headers.has('host') ? `${url.protocol}//${request.headers.get('host')}` : url.origin
    if (request.headers.get('sec-fetch-site') === 'cross-site' ||
        (request.headers.has('origin') && request.headers.get('origin') !== expectedOrigin)) {
      return conflict('请求来源不匹配')
    }
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return conflict('请求需要 JSON 内容')
    }
    const value: unknown = await request.json().catch(() => null)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return conflict('请求需要 JSON 对象')
    if (Object.keys(value as Record<string, unknown>).length > 0) {
      return conflict('请求包含未定义字段')
    }

    const wishId = (await context.params).id
    const db = getDatabase()
    const auth = resolveAuthContext(request, db)
    if (!auth) return missing()
    // revokeWish 自带 BEGIN IMMEDIATE / 归属 / 首次时间守卫，调用方不再包事务。
    const wish = revokeWish(db, wishId, auth.ownerId, new Date().toISOString())
    return Response.json({ wish }, { headers })
  } catch (error) {
    return contractFail(error)
  }
}
