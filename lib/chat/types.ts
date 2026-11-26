// 目标位置：lib/chat/types.ts
// B 侧聊天业务逻辑的客户端结构类型。正式契约已在 main（contracts/chat.ts、
// contracts/types.ts 的 ChatRequest/ChatResponse，SHA 56c63474），路由侧已直接取用。
// 这里保留结构等价的本地类型，供纯业务逻辑与 node --test 独立运行（不依赖 '@/'
// 路径别名）；字段与正式契约严格一一对应，无需在客户端逻辑里重复解析契约。

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
