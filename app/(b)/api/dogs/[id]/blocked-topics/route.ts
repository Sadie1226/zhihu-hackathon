// 目标位置：app/(b)/api/dogs/[id]/blocked-topics/route.ts
// B7 屏蔽主题的读写专口。DogView（GET /api/dogs/:id）不含 blockedTopics，故单独给设置正文读写入口。
// 只更新 dog.blocked_topics 这一列（写入方 b，契约 api.md 第五节）；不新建表/字段（errors.md 禁区三）。
// 屏蔽的过滤实现在 C（出行前）、D（交换/邻居）、E（展示）——本路由只负责把主人选的词如实存下来。
import { getDatabase } from '@/lib/db/index'
import { readSessionId } from '@/lib/auth/session'
import { normalizeBlockedTopics } from '@/lib/preferences/blocked-topics'
import {
  ownedDog, readBlockedTopics, writeBlockedTopics,
} from '@/lib/preferences/blocked-topics-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }
const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }

function fail(status: number, code: string, detail: string): Response {
  return Response.json({ code, detail, retriable: status >= 500 }, { status, headers })
}
const missing = (): Response => fail(404, 'NOT_FOUND', '这只伙伴不在这里')
const conflict = (detail: string): Response => fail(409, 'CONFLICT', detail)
const offline = (): Response => fail(503, 'NETWORK', '这次没连上，可以再试一次')

function crossSite(request: Request): boolean {
  const url = new URL(request.url)
  const expectedOrigin = request.headers.has('host')
    ? `${url.protocol}//${request.headers.get('host')}`
    : url.origin
  return request.headers.get('sec-fetch-site') === 'cross-site' ||
    (request.headers.has('origin') && request.headers.get('origin') !== expectedOrigin)
}

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const sessionId = readSessionId(request)
    if (!sessionId) return missing()
    const url = new URL(request.url)
    if ([...url.searchParams.keys()].length > 0) return conflict('这个入口不接受查询参数')
    const dogId = (await context.params).id
    const db = getDatabase()
    if (!ownedDog(db, dogId, sessionId)) return missing()
    return Response.json({ blockedTopics: readBlockedTopics(db, dogId) }, { headers })
  } catch {
    return offline()
  }
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  try {
    const sessionId = readSessionId(request)
    if (!sessionId) return missing()
    if (crossSite(request)) return conflict('请求来源不匹配')
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return conflict('请求需要 JSON 内容')
    }
    const value: unknown = await request.json().catch(() => null)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return conflict('请求需要 JSON 对象')
    }
    const body = value as Record<string, unknown>
    // 只收 blockedTopics 一个键；来源/会话字段不接受客户端注入（沿用 b6 心愿路由的同源口径）。
    if (Object.keys(body).some((key) => key !== 'blockedTopics')) {
      return conflict('这个入口只接收屏蔽主题')
    }
    const normalized = normalizeBlockedTopics(body.blockedTopics)
    if (!normalized.ok) return conflict(normalized.detail)

    const dogId = (await context.params).id
    const db = getDatabase()
    if (!ownedDog(db, dogId, sessionId)) return missing()

    let stored
    try {
      stored = writeBlockedTopics(db, dogId, sessionId, normalized.topics)
    } catch (error) {
      if (String(error).includes('CONSTRAINT')) return conflict('屏蔽主题没通过契约校验')
      throw error
    }
    if (!stored.ok) return missing()
    return Response.json({ blockedTopics: stored.blockedTopics }, { headers })
  } catch {
    return offline()
  }
}
