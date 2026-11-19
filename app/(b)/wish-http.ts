// 目标位置：lib/b4/wish-http.ts
// b4 · 心愿 HTTP 边界。会话归属、参数校验、错误映射都在这里，路由只做转发。
import type { DatabaseSync } from 'node:sqlite'
import { readSessionId } from '@/lib/auth/session'
import {
  WishError,
  wishHeaders,
  listWishes,
  createWish,
  revokeWish,
} from './wish-service'

type GetDatabase = () => DatabaseSync

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
