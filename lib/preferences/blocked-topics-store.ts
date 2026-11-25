// 目标位置：lib/preferences/blocked-topics-store.ts
// B7 屏蔽主题的持久化边界：只写 dog.blocked_topics 现有列（写入方 b），不改其它列、不加字段。
// 从路由提取出来，便于用真实 SQLite 直接验证 owner 归属与列独占，无需起 Next 运行时。
import type { DatabaseSync } from 'node:sqlite'

export type StoreResult =
  | { ok: true; blockedTopics: string[] }
  | { ok: false; code: 'NOT_FOUND'; detail: string }

export function ownedDog(db: DatabaseSync, dogId: string, sessionId: string): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM dog WHERE id = ? AND session_id = ?').get(dogId, sessionId),
  )
}

export function readBlockedTopics(db: DatabaseSync, dogId: string): string[] {
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

/** 整列覆盖写入；WHERE 带 session_id，跨主人的 dogId 一律 0 行、不算成功。 */
export function writeBlockedTopics(
  db: DatabaseSync,
  dogId: string,
  sessionId: string,
  topics: string[],
): StoreResult {
  if (!ownedDog(db, dogId, sessionId)) {
    return { ok: false, code: 'NOT_FOUND', detail: '这只伙伴不在这里' }
  }
  const serialized = JSON.stringify(topics)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE dog SET blocked_topics = ? WHERE id = ? AND session_id = ?')
      .run(serialized, dogId, sessionId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { ok: true, blockedTopics: readBlockedTopics(db, dogId) }
}
