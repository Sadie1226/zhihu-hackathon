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
    const response: ChatResponse = {
      id: String(r.id ?? ''), dogId: String(r.dogId ?? ''),
      text: String(r.text ?? ''), createdAt: String(r.createdAt ?? ''),
    }
    if (!response.id || !response.dogId || !response.createdAt) return { kind: 'retriable', reason: 'server' }
    // 四键严格：多字段或字段类型异常的 200 不采信，避免把诊断/生成字段当确认。
    if (Object.keys(r).length !== 4) return { kind: 'retriable', reason: 'server' }
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
