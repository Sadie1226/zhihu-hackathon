// 目标位置：lib/chat/types.ts
// B 侧聊天业务逻辑的本地结构类型。刻意不 import contracts/chat.ts：
// C 的 POST /api/chat 契约仍在 c-chat-contract-1125、尚未合 main，
// 正式取用须等 A 审合后发布的精确 SHA。这些类型与 C 交付稿结构等价，
// 待 A 发布后替换为共享类型即可，业务逻辑无需改动。

/** chat_message 的一行（仅首次确认的消息；字段名与契约 DDL 对齐）。 */
export interface ChatRecord {
  id: string
  ownerId: string
  clientMessageId: string
  dogId: string
  /** 已完成 trim() 的原文；不做 Unicode 归一化、不合并内部空白。 */
  text: string
  /** 首次成功提交的服务端 UTC，ISO 毫秒且以 Z 结束。 */
  createdAt: string
}

/** 200 成功体固定四键，不含 replyText。 */
export interface ChatResponse {
  id: string
  dogId: string
  text: string
  createdAt: string
}

/** 一次写事务的业务裁决。调用方负责在同一事务内完成授权、查重与写入。 */
export type ChatWriteDecision =
  | { kind: 'created' }
  | { kind: 'replay'; record: ChatRecord }
  | { kind: 'conflict' }
  | { kind: 'forbidden' }

/** 客户端投递状态；不落库，chat_message 没有 status 列。 */
export type ChatDelivery =
  | 'pending'
  | 'sending'
  | 'confirmed'
  | 'uncertain'
  | 'conflict'
  | 'forbidden'

/** 与投递正交的未来生成状态；首版恒为 none。 */
export type ChatGeneration = 'none' | 'pending' | 'failed' | 'done'

/** 客户端为一次意图保留的数据。clientMessageId 终局不变。 */
export interface ChatOptimisticItem {
  clientMessageId: string
  dogId: string
  text: string
  delivery: ChatDelivery
  generation: ChatGeneration
  serverId: string | null
  createdAt: string | null
  attempts: number
}

/** 实际发出的请求体；重试时三字段逐字不变。 */
export interface ChatOutbound {
  dogId: string
  text: string
  clientMessageId: string
}

/** 传输层结果：只接受契约允许的四种归类。 */
export type ChatSendResult =
  | { kind: 'ok'; response: ChatResponse }
  | { kind: 'conflict' }
  | { kind: 'forbidden' }
  | { kind: 'retriable'; reason: 'network' | 'server' }
