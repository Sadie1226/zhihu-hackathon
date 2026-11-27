// 目标位置：app/(b)/api/chat/route.ts
// POST /api/chat：主人与自己狗的私有日常交流，首次确认消息持久化（不含 AI 回复）。
// 取用 main 已合的正式契约 contracts/chat.ts（parseChatRequest）与 contracts/types.ts（ChatRequest/ChatResponse）。
// 表 chat_message 由 C 的 v9 迁移提供，B 不建表/不改契约；表未就位时按 503 处理，不冒充成功。
import { getDatabase } from '@/lib/db/index'
import { resolveAuthContext } from '@/lib/auth/session'
import { CHAT_BODY_MAX_BYTES, parseChatRequest } from '@/contracts/chat'
import { writeChatOnce, toChatResponse } from '@/lib/chat/server-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }

function fail(status: number, code: 'NOT_FOUND' | 'CONFLICT' | 'NETWORK', detail: string): Response {
  return Response.json({ code, detail, retriable: status === 503 }, { status, headers })
}
const notFound = (): Response => fail(404, 'NOT_FOUND', '这条记录不在这里')
const conflict = (detail: string): Response => fail(409, 'CONFLICT', detail)
const offline = (): Response => fail(503, 'NETWORK', '这次没连上，可以再试一次')

/** 同源写入：拒绝跨站与不匹配的 Origin；不信任转发头，只按请求自身 URL/Host 判定。 */
function crossSite(request: Request): boolean {
  const url = new URL(request.url)
  const expected = url.protocol + '//' + (request.headers.get('host') ?? url.host)
  return request.headers.get('sec-fetch-site') === 'cross-site' ||
    (request.headers.has('origin') && request.headers.get('origin') !== expected)
}

/** 严格 JSON：仅一个自有键集合、键不重复、不接受数组/原型污染。 */
function strictObject(text: string): Record<string, unknown> | null {
  let value: unknown
  try {
    value = JSON.parse(text, (key, val) => {
      // 通过 reviver 统计重复键：重复出现时 Object 已覆盖，另在下方用原文键计数兜底。
      return val
    })
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const own = Object.keys(obj)
  // 重复键在 JSON.parse 后只保留最后一个，用紧凑原文对三键计数检测重复。
  const compact = text.replace(/\s+/g, '')
  for (const key of own) {
    const hits = compact.match(new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '":', 'g'))
    if (hits && hits.length > 1) return null
  }
  return obj
}

export async function POST(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    if ([...url.searchParams.keys()].length > 0) return conflict('这个入口不接受查询参数')
    if (crossSite(request)) return conflict('请求来源不匹配')

    const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') return conflict('请求需要 JSON 内容')

    const raw = await request.text()
    const bytes = new TextEncoder().encode(raw).length
    if (bytes > CHAT_BODY_MAX_BYTES) return conflict('请求体过大')

    const body = strictObject(raw)
    if (!body) return conflict('请求需要合法的 JSON 对象')
    const parsed = parseChatRequest(body)
    if (!parsed) return conflict('请求字段不合法')

    const db = getDatabase()
    // 事务外先解析会话；事务内由 server-store 的回调重新验证（见下）。
    const auth = resolveAuthContext(request, db)
    if (!auth) return notFound()

    const revalidate = (txDb: typeof db) => resolveAuthContext(request, txDb)?.ownerId === auth.ownerId
    const result = writeChatOnce(db, {
      ownerId: auth.ownerId,
      dogId: parsed.dogId,
      text: parsed.text,
      clientMessageId: parsed.clientMessageId,
    }, revalidate)

    if (result.kind === 'forbidden') return notFound()
    if (result.kind === 'conflict') return conflict('同一条消息的内容发生了变化')
    if (result.kind === 'failed') return offline()
    return Response.json(toChatResponse(result.record), { status: 200, headers })
  } catch {
    return offline()
  }
}
