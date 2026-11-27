// 目标位置：lib/chat/server-store.ts
// POST /api/chat 的服务端持久化：在一个 BEGIN IMMEDIATE 写事务内完成
//   授权复检 → 按 (owner_id, client_message_id) 查重 → 同值回放/异值冲突 → 首存 INSERT → COMMIT。
// 严格遵循 main 已合契约 contracts/api.md 第十一项与 C 的 chat_message v9 表结构：
//   - 六字段 id/owner_id/client_message_id/dog_id/text/created_at，唯一键 (owner_id, client_message_id)；
//   - 授权先于幂等；会话、狗归属在事务内重新验证；
//   - 只有命中目标唯一键冲突可回读当重放，主键/外键/CHECK/提交异常一律失败；
//   - COMMIT 成功后才返回 created/replay，数据库故障返回 failed（路由映射 503）。
// B 不建表、不改 contracts/、不占迁移编号：表由 C 的 v9 迁移提供。表不存在时按 503 处理。
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { ChatRecord, ChatWriteDecision } from './types.ts'
import { decideChatWrite } from './write-decision.ts'

export interface ChatWriteInput {
  ownerId: string
  dogId: string
  /** 已完成 parseChatRequest 的 trim() 文本；逐码元保存，不归一化。 */
  text: string
  clientMessageId: string
}

export type ChatWriteResult =
  | ({ kind: 'created' | 'replay' } & { record: ChatRecord })
  | { kind: 'conflict' }
  | { kind: 'forbidden' }
  | { kind: 'failed' }

/** 判断异常是否「目标唯一键冲突」——只有这一种可回读当重放。 */
export function isOwnerKeyConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /chat_message\.owner_id,\s*chat_message\.client_message_id/.test(message) ||
    /chat_message \(owner_id, client_message_id\)/.test(message)
}

function rowToRecord(row: unknown): ChatRecord | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.owner_id !== 'string' ||
      typeof r.client_message_id !== 'string' || typeof r.dog_id !== 'string' ||
      typeof r.text !== 'string' || typeof r.created_at !== 'string') return null
  return {
    id: r.id, ownerId: r.owner_id, clientMessageId: r.client_message_id,
    dogId: r.dog_id, text: r.text, createdAt: r.created_at,
  }
}

/**
 * 会话有效性由调用方在事务外先析出入参 ownerId；这里在事务内再次验证：
 *   1) 会话 token 仍有效（调用方把 revalidate 回调传入，传 db 以支持事务内重查）；
 *   2) dog.id = dogId AND dog.owner_id = ownerId AND dog.is_sample = 0；
 *   3) 再查幂等记录、比较、写入。
 * revalidateSession 返回 false 表示会话在事务开始时已失效 → forbidden。
 */
export function writeChatOnce(
  db: DatabaseSync,
  input: ChatWriteInput,
  revalidateSession: (db: DatabaseSync) => boolean,
): ChatWriteResult {
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!revalidateSession(db)) {
        db.exec('ROLLBACK')
        return { kind: 'forbidden' }
      }
      const owned = db.prepare(
        'SELECT 1 FROM dog WHERE id = ? AND owner_id = ? AND is_sample = 0',
      ).get(input.dogId, input.ownerId)
      if (!owned) {
        db.exec('ROLLBACK')
        return { kind: 'forbidden' }
      }

      const existing = rowToRecord(db.prepare(
        `SELECT id, owner_id, client_message_id, dog_id, text, created_at
         FROM chat_message WHERE owner_id = ? AND client_message_id = ?`,
      ).get(input.ownerId, input.clientMessageId))
      const decision: ChatWriteDecision = decideChatWrite({
        dogAuthorized: true,
        existing,
        dogId: input.dogId,
        text: input.text,
      })
      if (decision.kind === 'forbidden') {
        db.exec('ROLLBACK')
        return { kind: 'forbidden' }
      }
      if (decision.kind === 'conflict') {
        db.exec('ROLLBACK')
        return { kind: 'conflict' }
      }
      if (decision.kind === 'replay') {
        db.exec('COMMIT')
        return { kind: 'replay', record: decision.record }
      }

      const record: ChatRecord = {
        id: `chat_${randomUUID()}`,
        ownerId: input.ownerId,
        clientMessageId: input.clientMessageId,
        dogId: input.dogId,
        text: input.text,
        createdAt: new Date().toISOString(),
      }
      try {
        db.prepare(
          `INSERT INTO chat_message (id, owner_id, client_message_id, dog_id, text, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(record.id, record.ownerId, record.clientMessageId, record.dogId, record.text, record.createdAt)
      } catch (error) {
        db.exec('ROLLBACK')
        // 并发同键：只有目标唯一键冲突可回读比较；其他异常（主键/外键/CHECK/锁）不得当成功。
        if (isOwnerKeyConflict(error)) {
          const concurrent = rowToRecord(db.prepare(
            `SELECT id, owner_id, client_message_id, dog_id, text, created_at
             FROM chat_message WHERE owner_id = ? AND client_message_id = ?`,
          ).get(input.ownerId, input.clientMessageId))
          const verdict = decideChatWrite({
            dogAuthorized: true, existing: concurrent, dogId: input.dogId, text: input.text,
          })
          if (verdict.kind === 'replay') return { kind: 'replay', record: verdict.record }
          if (verdict.kind === 'conflict') return { kind: 'conflict' }
        }
        return { kind: 'failed' }
      }
      db.exec('COMMIT')
      return { kind: 'created', record }
    } catch {
      try { db.exec('ROLLBACK') } catch { /* 事务可能已结束 */ }
      return { kind: 'failed' }
    }
  } catch {
    // BEGIN 失败（如表不存在、数据库锁）→ 503，绝不返回成功。
    return { kind: 'failed' }
  }
}

/** 把首存记录投影为契约的四键成功体，不输出 owner/key/诊断/生成字段。 */
export function toChatResponse(record: ChatRecord) {
  return { id: record.id, dogId: record.dogId, text: record.text, createdAt: record.createdAt }
}
