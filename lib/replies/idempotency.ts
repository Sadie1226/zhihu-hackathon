// lib/replies/idempotency.ts —— 回应写入的幂等核心（从 Route 抽出，行为等价，便于单测）
//
// 契约现状（待 A/B/C 收口，B 不改 contracts/）：
//   首次写入 → { kind: 'created', reply }
//   同一来源重复提交 → { kind: 'duplicate', reply: 库中真实记录 }，HTTP 层映射为 200
//   `duplicate: true` 是真实回执标识，不是假 ID；库里始终 1 行，首次内容不被覆盖。
//
// 这里只做「目标来源唯一约束冲突 = 幂等重放」；其它约束失败一律 returned failed，
// 绝不把外键/CHECK 错误当成功。请求体/来源归属/图片归属的校验留在 Route（依赖会话与 fs）。

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Reply } from '../../contracts/types'

export type ReplySource = { kind: 'exchange' | 'invitation'; id: string }

export type ReplyCore = {
  id: string
  exchange_id: string | null
  invitation_id: string | null
  text: string | null
  photo_url: string | null
  kind: Reply['kind']
  created_at: string
}

export type WriteReplyInput = {
  source: ReplySource
  text: string | null
  photoUrl: string | null
}

export type WriteReplyDeps = {
  now?: () => Date
  newId?: () => string
}

export type WriteReplyResult =
  | { kind: 'created'; reply: Reply }
  | { kind: 'duplicate'; reply: Reply }
  | { kind: 'failed' }

export function replyDto(row: ReplyCore): Reply {
  return {
    id: row.id,
    exchangeId: row.exchange_id,
    invitationId: row.invitation_id,
    text: row.text,
    photoUrl: row.photo_url,
    kind: row.kind,
    createdAt: row.created_at,
  }
}

function looksLikeUniqueViolation(error: unknown): boolean {
  const code = String((error as { code?: string })?.code ?? '')
  return code.includes('CONSTRAINT') || String(error).toLowerCase().includes('unique')
}

/**
 * 在给定 db 上写入一条回应；同一来源重复提交返回库中真实记录（duplicate）。
 * 不碰会话、不碰 fs —— 便于用临时库直接单测幂等语义。
 */
export function writeReply(
  db: DatabaseSync,
  input: WriteReplyInput,
  deps: WriteReplyDeps = {},
): WriteReplyResult {
  const { source, text, photoUrl } = input
  const id = deps.newId?.() ?? `r_${randomUUID().replace(/-/g, '')}`
  const createdAt = (deps.now?.() ?? new Date()).toISOString()

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `INSERT INTO reply (id, exchange_id, invitation_id, text, photo_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      source.kind === 'exchange' ? source.id : null,
      source.kind === 'invitation' ? source.id : null,
      text,
      photoUrl,
      createdAt,
    )
    // 回应 exchange 的同时记 replied_at；WHERE 保留首次时间，重放不覆盖。
    if (source.kind === 'exchange') {
      db.prepare('UPDATE exchange SET replied_at = ? WHERE id = ? AND replied_at IS NULL')
        .run(createdAt, source.id)
    }
    db.exec('COMMIT')
    const row = db.prepare('SELECT * FROM reply WHERE id = ?').get(id) as ReplyCore
    return { kind: 'created', reply: replyDto(row) }
  } catch (error) {
    db.exec('ROLLBACK')
    if (looksLikeUniqueViolation(error)) {
      // 只把目标来源的唯一约束当幂等重放；其它约束失败一律不当成功。
      const column = source.kind === 'exchange' ? 'exchange_id' : 'invitation_id'
      const existing = db.prepare(`SELECT * FROM reply WHERE ${column} = ?`).get(source.id) as
        ReplyCore | undefined
      if (existing) return { kind: 'duplicate', reply: replyDto(existing) }
    }
    return { kind: 'failed' }
  }
}
