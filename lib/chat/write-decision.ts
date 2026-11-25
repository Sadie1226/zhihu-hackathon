// 目标位置：lib/chat/write-decision.ts
// 服务端写事务内的业务裁决（纯函数，无 IO、不连库）。
// 契约要求：授权检查 → 按 (owner_id, client_message_id) 查重 → 同值比较 →
// 写入/回读 全部在同一个 BEGIN IMMEDIATE 写事务内完成，COMMIT 后才返回 200。
// 本模块只负责「查到了什么、该给什么裁决」；会话解析、狗归属、SQL 由路由负责。

import type { ChatRecord, ChatWriteDecision } from './types.ts'

export interface DecideInput {
  /** 调用方在同一事务内重新解析会话并校验 dog.id/dog.owner_id/is_sample 的结果。 */
  dogAuthorized: boolean
  /** 必须按当前已授权 owner 作用域查出；不得跨 owner 查同键记录。 */
  existing: ChatRecord | null
  dogId: string
  /** 已完成 trim() 的文本；内部空白与 Unicode 码元逐字比较。 */
  text: string
}

/**
 * 授权先于幂等：未授权目标一律 forbidden，不进入同键比较，
 * 避免借幂等查询探测同键是否存在。同键同值回放首次记录，
 * 同键改目标或改内容一律 conflict（不可重试）。
 */
export function decideChatWrite(input: DecideInput): ChatWriteDecision {
  if (!input.dogAuthorized) return { kind: 'forbidden' }
  const { existing, dogId, text } = input
  if (!existing) return { kind: 'created' }
  if (existing.dogId !== dogId || existing.text !== text) return { kind: 'conflict' }
  return { kind: 'replay', record: existing }
}

/**
 * 并发同键写入时，只允许「目标唯一键冲突」回读当重放。
 * 其他数据库异常（磁盘、外键、约束、锁超时）不得吞成成功。
 */
export function isChatKeyConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // 兼容 SQLite 两种报错写法：
  //   UNIQUE constraint failed: chat_message.owner_id, chat_message.client_message_id
  //   UNIQUE constraint failed: chat_message (owner_id, client_message_id)
  return /UNIQUE constraint failed:.*chat_message[.\s(]+owner_id[,\s]+(?:chat_message\.)?client_message_id/i.test(message)
}
