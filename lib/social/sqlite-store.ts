/**
 * sqlite-store.ts —— `SocialStore` 的真实实现（对接 `contracts/schema.sql`）
 *
 * 为什么要有这一份：
 *   c 11/19 的答复要求「Mock 验收与真实信箱验收**分开记录**」。只有 MemoryStore 时，
 *   验的是「我的逻辑自洽」，验不到「真库的 CHECK / 触发器 / 字段名认不认」。
 *   有了这个适配器，同一套 gift.ts 可以分别跑在内存和真库上，两边结果对得上才算过。
 *
 * 它也只做四件事之外的一件读：isSample。理由见 store.ts 里的注释。
 *
 * **注意 `relation.id` 的形状**：本文件用 `store.ts` 的 `relationId()`（`rel_a__b`，可读），
 * 而 `meet.ts` 现在用的是 `rel_<shortHash>`。两者不会同时写同一张表 —— 11-20 适配器化时
 * 统一到这一份，那时 `meet.ts` 的 id 形状会跟着变一次（id 没有外部引用，安全）。
 */

import type { DatabaseSync } from 'node:sqlite'
import { pairKey, relationId } from './store.ts'
import type { ExchangeRow, RelationRow, RelationUpsertResult, SocialStore } from './store.ts'

export function createSqliteStore(db: DatabaseSync): SocialStore {
  return {
    insertExchange(row: ExchangeRow): 'inserted' | 'duplicate' {
      // 幂等靠主键：同 id 再来静默跳过，不报错、不产生第二条。
      const res = db
        .prepare(
          `INSERT INTO exchange
             (id, from_dog, to_dog, kind, payload,
              deliver_after_trip_seq, created_at, delivered_at, replied_at, read_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          row.id,
          row.fromDog,
          row.toDog,
          row.kind,
          JSON.stringify(row.payload),
          row.deliverAfterTripSeq,
          row.createdAt,
        )
      return Number(res.changes) === 1 ? 'inserted' : 'duplicate'
    },

    upsertRelation({ dogA, dogB, at }): RelationUpsertResult {
      const [lo, hi] = pairKey(dogA, dogB)
      const row = db
        .prepare(
          `INSERT INTO relation (id, dog_a, dog_b, first_met_at, last_met_at, met_count, is_blocked, blocked_at)
           VALUES (?, ?, ?, ?, ?, 1, 0, NULL)
           ON CONFLICT(dog_a, dog_b) DO UPDATE
             SET met_count   = relation.met_count + 1,
                 last_met_at = excluded.last_met_at
           RETURNING id, dog_a, dog_b, first_met_at, last_met_at, met_count, is_blocked, blocked_at`,
        )
        .get(relationId(lo, hi), lo, hi, at, at) as Record<string, unknown>

      const relation: RelationRow = {
        id: String(row.id),
        dogA: String(row.dog_a),
        dogB: String(row.dog_b),
        firstMetAt: String(row.first_met_at),
        lastMetAt: String(row.last_met_at),
        metCount: Number(row.met_count),
        isBlocked: Number(row.is_blocked) === 1 ? 1 : 0,
        blockedAt: row.blocked_at === null ? null : String(row.blocked_at),
      }
      // met_count === 1 只可能是刚 INSERT 进去的那次；老关系 bump 之后最小是 2。
      return { relation, firstTime: relation.metCount === 1 }
    },

    isBlocked(a, b) {
      const [lo, hi] = pairKey(a, b)
      const row = db
        .prepare('SELECT is_blocked FROM relation WHERE dog_a = ? AND dog_b = ?')
        .get(lo, hi) as { is_blocked: number } | undefined
      return row !== undefined && Number(row.is_blocked) === 1
    },

    currentSeq(dogId) {
      const row = db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM trip WHERE dog_id = ?')
        .get(dogId) as { s: number } | undefined
      return Number(row?.s ?? 0)
    },

    isSample(dogId) {
      const row = db.prepare('SELECT is_sample FROM dog WHERE id = ?').get(dogId) as
        | { is_sample: number }
        | undefined
      return row !== undefined && Number(row.is_sample) === 1
    },
  }
}
