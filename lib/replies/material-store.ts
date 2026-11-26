// 目标位置：lib/replies/material-store.ts
// b8 的写入桥：只在 C 落地 wish.source='reply' 与 origin_reply_id 后写库。
// 当前 main（92c1ee5）仍无这两个前置，本模块返回明确的 blocked，
// 绝不静默写 source='owner' 或用文本/来源列塞溯源标记（会污染搜索词与 provenance）。

import type { DatabaseSync } from 'node:sqlite'
import type { Reply } from '../../contracts/types.ts'
import {
  buildReplyWishDraft,
  extractReplyMaterial,
  isMaterialBlocked,
  type ReplyWishDraft,
} from './material.ts'

export type ReplyWishRow = {
  id: string
  dog_id: string
  text: string
  category: ReplyWishDraft['category']
  created_at: string
  revoked_at: string | null
  source: string
  source_url: string | null
  origin_reply_id: string
}

export type MaterializeResult =
  | { kind: 'materialized'; wish: ReplyWishDraft }
  | { kind: 'replay'; wish: ReplyWishDraft }
  | { kind: 'skipped'; reason: 'no-searchable-intent' | 'blocked' }
  | { kind: 'blocked'; reason: 'schema-precondition-missing'; missing: string[] }

export interface MaterializeDeps {
  now?: () => Date
  /** 默认从 dog.blocked_topics 读；注入便于规则测试。 */
  blockedTopics?: string[]
}

/** 检测 vNext schema 前置；不抛错、不改库，供写入前守卫与回交自检复用。 */
export function detectReplyWishSchema(db: DatabaseSync): { supported: boolean; missing: string[] } {
  const info = db.prepare("SELECT name FROM pragma_table_info('wish')").all() as { name: string }[]
  const columns = new Set(info.map((row) => row.name))
  const ddl = (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='wish'").get() as
    | { sql: string | null }
    | undefined)?.sql ?? ''
  const missing: string[] = []
  if (!columns.has('origin_reply_id')) missing.push('wish.origin_reply_id')
  if (!/'reply'/.test(ddl)) missing.push("wish.source CHECK 增加 'reply'")
  return { supported: missing.length === 0, missing }
}

export function replyWishDto(row: ReplyWishRow): ReplyWishDraft {
  return {
    id: row.id,
    dogId: row.dog_id,
    text: row.text,
    category: row.category,
    createdAt: row.created_at,
    revokedAt: row.revoked_at as null,
    source: 'reply',
    sourceUrl: null,
    originReplyId: row.origin_reply_id,
  }
}

function readBlockedTopics(db: DatabaseSync, dogId: string): string[] {
  const row = db.prepare('SELECT blocked_topics AS raw FROM dog WHERE id = ?').get(dogId) as
    | { raw: string | null }
    | undefined
  if (!row?.raw) return []
  try {
    const parsed: unknown = JSON.parse(row.raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/**
 * 回应成功后把可搜索意图转成一条 reply-wish（目标态）。前置未满足时只返回 blocked，
 * 一行都不写。同 reply 幂等：以 reply.id 派生 id，重复调用返回库中真实记录。
 */
export function materializeReplyWish(
  db: DatabaseSync,
  reply: Reply,
  dogId: string,
  deps: MaterializeDeps = {},
): MaterializeResult {
  const schema = detectReplyWishSchema(db)
  if (!schema.supported) {
    return { kind: 'blocked', reason: 'schema-precondition-missing', missing: schema.missing }
  }
  const material = extractReplyMaterial(reply)
  if (!material) return { kind: 'skipped', reason: 'no-searchable-intent' }
  const blockedTopics = deps.blockedTopics ?? readBlockedTopics(db, dogId)
  if (isMaterialBlocked(material, blockedTopics)) return { kind: 'skipped', reason: 'blocked' }

  const draft = buildReplyWishDraft(material, dogId, deps.now)
  const find = db.prepare('SELECT * FROM wish WHERE origin_reply_id = ?')
  const insert = db.prepare(
    `INSERT INTO wish
       (id, dog_id, text, category, created_at, revoked_at, source, source_url, origin_reply_id)
     VALUES (?, ?, ?, ?, ?, ?, 'reply', NULL, ?)`,
  )

  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = find.get(reply.id) as ReplyWishRow | undefined
    if (existing) {
      db.exec('COMMIT')
      return { kind: 'replay', wish: replyWishDto(existing) }
    }
    insert.run(
      draft.id,
      dogId,
      draft.text,
      draft.category,
      draft.createdAt,
      draft.revokedAt,
      draft.originReplyId,
    )
    const saved = find.get(reply.id) as ReplyWishRow
    db.exec('COMMIT')
    return { kind: 'materialized', wish: replyWishDto(saved) }
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    // 并发同 reply 抢写：只把目标唯一键冲突当幂等回读，其它异常抛出由调用方处理。
    const message = String(error)
    if (/UNIQUE constraint failed: wish\.origin_reply_id/i.test(message)) {
      const raced = find.get(reply.id) as ReplyWishRow | undefined
      if (raced) return { kind: 'replay', wish: replyWishDto(raced) }
    }
    throw error
  }
}
