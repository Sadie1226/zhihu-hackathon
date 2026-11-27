// 目标位置：lib/chat/transport.ts
// 客户端传输层：把 lib/chat/send.ts 的 ChatTransport 接到正式 POST /api/chat。
// 只确认「主人消息已持久化」的四键回执；不产出、不冒充狗的回复（生成另需契约）。
// 示例通道 b4-chat-fixture.ts 继续独立运行，默认不切换；本适配器在 A 发布 v9 基线后启用。
import type { ChatOutbound, ChatSendResult, ChatResponse } from './types.ts'

/** 把 HTTP 响应映射为 send.ts 的四类结果；任何不符合契约的内容都不当成功。 */
export function interpretChatResponse(status: number, body: unknown): ChatSendResult {
  if (status === 200) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'retriable', reason: 'server' }
    const r = body as Record<string, unknown>
    const keys = ['id', 'dogId', 'text', 'createdAt'] as const
    if (Object.keys(r).length !== keys.length ||
      !keys.every(key => Object.hasOwn(r, key) && typeof r[key] === 'string')) {
      return { kind: 'retriable', reason: 'server' }
    }
    const response: ChatResponse = {
      id: r.id as string, dogId: r.dogId as string,
      text: r.text as string, createdAt: r.createdAt as string,
    }
    if (!response.id.trim() || !response.dogId.trim() ||
      !response.createdAt.trim() || !Number.isFinite(Date.parse(response.createdAt))) {
      return { kind: 'retriable', reason: 'server' }
    }
    return { kind: 'ok', response }
  }
  if (status === 409) return { kind: 'conflict' }
  if (status === 404) return { kind: 'forbidden' }
  return { kind: 'retriable', reason: status >= 500 || status === 0 ? 'network' : 'server' }
}

/** 真实传输层。同源请求由浏览器携带 Cookie；客户端为一次意图固定键，重试逐字不变。 */
export function createChatTransport(fetchImpl: typeof fetch = fetch) {
  return async function chatTransport(outbound: ChatOutbound): Promise<ChatSendResult> {
    try {
      const response = await fetchImpl('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dogId: outbound.dogId, text: outbound.text, clientMessageId: outbound.clientMessageId,
        }),
      })
      const body: unknown = await response.json().catch(() => null)
      return interpretChatResponse(response.status, body)
    } catch {
      return { kind: 'retriable', reason: 'network' }
    }
  }
}
