// 目标位置：lib/chat/send.ts
// B 侧真实聊天的客户端业务逻辑（纯函数 + 注入的传输层，不连库、不 import 未合契约）。
// 设计依据见 team/2026-11-25/b/1125-b-聊天存储字段-幂等与失败恢复-设计-v1.md：
//   - 一次意图一个 clientMessageId，超时/断连/503 一律原键原文重试；
//   - 只有收到 200 且回执与目标/文本一致才算 confirmed；
//   - 生成失败只改 generation，不碰 delivery、不重发、不换键。
// A 审合并发布精确 SHA 后，把传输层接到 POST /api/chat、替换示例入口即可。

import type {
  ChatOptimisticItem,
  ChatOutbound,
  ChatSendResult,
} from './types.ts'

/** 本轮自定的客户端退避上限（不是契约字段，也不落库）。 */
export const MAX_CHAT_ATTEMPTS = 5
export const RETRY_DELAYS_MS = [0, 500, 1000, 2000, 5000] as const

/** 乐观上屏项。text 只做 trim()，与契约的规范化口径一致。 */
export function createChatItem(input: {
  dogId: string
  text: string
  clientMessageId: string
}): ChatOptimisticItem {
  return {
    clientMessageId: input.clientMessageId,
    dogId: input.dogId,
    text: input.text.trim(),
    delivery: 'pending',
    generation: 'none',
    serverId: null,
    createdAt: null,
    attempts: 0,
  }
}

/** 重试请求体逐字不变：换 dogId、改文本或换键都不是重试，而是新意图。 */
export function retryOutbound(item: ChatOptimisticItem): ChatOutbound {
  return {
    dogId: item.dogId,
    text: item.text,
    clientMessageId: item.clientMessageId,
  }
}

/** 进入在途并计一次尝试；终态项不再发送。 */
export function markSending(item: ChatOptimisticItem): ChatOptimisticItem {
  if (item.delivery === 'confirmed' || item.delivery === 'conflict' || item.delivery === 'forbidden') {
    return item
  }
  return { ...item, delivery: 'sending', attempts: item.attempts + 1 }
}

/** 传输结果到状态的唯一入口。200 回执与目标或文本不符时按冲突处理，不确认错误内容。 */
export function applySendResult(
  item: ChatOptimisticItem,
  result: ChatSendResult,
): ChatOptimisticItem {
  if (item.delivery === 'confirmed' || item.delivery === 'conflict' || item.delivery === 'forbidden') {
    return item
  }
  switch (result.kind) {
    case 'ok': {
      const response = result.response
      if (response.dogId !== item.dogId || response.text !== item.text) {
        return { ...item, delivery: 'conflict' }
      }
      return {
        ...item,
        delivery: 'confirmed',
        serverId: response.id,
        createdAt: response.createdAt,
      }
    }
    case 'conflict':
      return { ...item, delivery: 'conflict' }
    case 'forbidden':
      return { ...item, delivery: 'forbidden' }
    case 'retriable':
      return { ...item, delivery: 'uncertain' }
  }
}

/** 只有结果不明且未超上限才允许重试。409/404/已确认项不可重试。 */
export function canRetry(item: ChatOptimisticItem): boolean {
  return item.delivery === 'uncertain' && item.attempts < MAX_CHAT_ATTEMPTS
}

/** 面板卸载或用户取消：在途项转不确定并保留键，重开后按同键重试。 */
export function cancelInFlight(item: ChatOptimisticItem): ChatOptimisticItem {
  if (item.delivery === 'sending' || item.delivery === 'pending') {
    return { ...item, delivery: 'uncertain' }
  }
  return item
}

/** 第 attempts 次失败后的退避；超出上限取封顶值。 */
export function retryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 0), RETRY_DELAYS_MS.length - 1)
  return RETRY_DELAYS_MS[index]
}

/** 同键去重：confirmed 优先，其余保留第一次出现的项，顺序稳定。 */
export function dedupeItems(items: ChatOptimisticItem[]): ChatOptimisticItem[] {
  const byKey = new Map<string, ChatOptimisticItem>()
  for (const item of items) {
    const previous = byKey.get(item.clientMessageId)
    if (!previous) {
      byKey.set(item.clientMessageId, item)
    } else if (previous.delivery !== 'confirmed' && item.delivery === 'confirmed') {
      byKey.set(item.clientMessageId, item)
    }
  }
  return [...byKey.values()]
}

/** 生成只能发生在已确认的消息上；失败只改 generation，不动投递状态与键。 */
export function applyGenerationOutcome(
  item: ChatOptimisticItem,
  outcome: 'pending' | 'failed' | 'done',
): ChatOptimisticItem {
  if (item.delivery !== 'confirmed') return item
  return { ...item, generation: outcome }
}

export type ChatTransport = (outbound: ChatOutbound) => Promise<ChatSendResult>

/** 发送一次。传输层抛错（超时/断连）按结果不明处理，绝不吞成已送达。 */
export async function sendChatOnce(
  item: ChatOptimisticItem,
  transport: ChatTransport,
): Promise<ChatOptimisticItem> {
  const inFlight = markSending(item)
  if (inFlight === item) return item
  let result: ChatSendResult
  try {
    result = await transport(retryOutbound(inFlight))
  } catch {
    result = { kind: 'retriable', reason: 'network' }
  }
  return applySendResult(inFlight, result)
}
