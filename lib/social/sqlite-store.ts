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
import type {
  ExchangeRow,
  FindSource,
  RelationRow,
  RelationUpsertResult,
  SocialStore,
} from './store.ts'

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

    readExchange(id) {
      const row = db.prepare('SELECT * FROM exchange WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined
      if (!row) return null
      return {
        id: String(row.id),
        fromDog: String(row.from_dog),
        toDog: String(row.to_dog),
        kind: String(row.kind) as ExchangeRow['kind'],
        payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
        deliverAfterTripSeq: Number(row.deliver_after_trip_seq),
        createdAt: String(row.created_at),
      }
    },

    readRelation(a, b) {
      const [lo, hi] = pairKey(a, b)
      const row = db
        .prepare(
          `SELECT id, dog_a, dog_b, first_met_at, last_met_at, met_count, is_blocked, blocked_at
             FROM relation WHERE dog_a = ? AND dog_b = ?`,
        )
        .get(lo, hi) as Record<string, unknown> | undefined
      if (!row) return null
      return {
        id: String(row.id),
        dogA: String(row.dog_a),
        dogB: String(row.dog_b),
        firstMetAt: String(row.first_met_at),
        lastMetAt: String(row.last_met_at),
        metCount: Number(row.met_count),
        isBlocked: Number(row.is_blocked) === 1 ? 1 : 0,
        blockedAt: row.blocked_at === null ? null : String(row.blocked_at),
      }
    },

    hasDog(dogId) {
      const row = db.prepare('SELECT 1 AS ok FROM dog WHERE id = ?').get(dogId) as
        | { ok: number }
        | undefined
      return row !== undefined
    },

    getTrip(tripId) {
      const row = db.prepare('SELECT id, dog_id, status, seq FROM trip WHERE id = ?').get(tripId) as
        | { id: string; dog_id: string; status: string; seq: number }
        | undefined
      if (!row) return null
      return {
        id: String(row.id),
        dogId: String(row.dog_id),
        status: String(row.status),
        seq: Number(row.seq),
      }
    },

    /**
     * 来源查询 —— 逐字用 api.md K v4 那节给的 SQL：
     *
     *   SELECT f.id, t.dog_id AS dogId, f.source_mode AS sourceMode
     *   FROM find f JOIN trip t ON t.id = f.trip_id
     *   WHERE f.id = :sourceFindId;
     *
     * `find` 表没有 dog_id，「来源属于谁」只能经 trip 反查。**不要**把 dogId 当入参，
     * 那就是让客户端自己声明归属。
     */
    getFindSource(findId) {
      const row = db
        .prepare(
          `SELECT f.id AS id, t.dog_id AS dogId, f.source_mode AS sourceMode
             FROM find f JOIN trip t ON t.id = f.trip_id
            WHERE f.id = ?`,
        )
        .get(findId) as { id: string; dogId: string; sourceMode: string | null } | undefined
      if (!row) return null
      return {
        id: String(row.id),
        dogId: String(row.dogId),
        sourceMode: row.sourceMode === null ? null : (String(row.sourceMode) as FindSource['sourceMode']),
      }
    },

    /**
     * 事务。用 `BEGIN IMMEDIATE`：一开始就拿写锁，避免「读到没有、写的时候已经有了」。
     *
     * **不暴露 commit/rollback 句柄** —— 只给一个回调，成不成由抛不抛错决定。
     * 这是 c 的要求：Mock 与适配器都不能自己决定「什么时候算落地」。
     */
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE')
      try {
        const value = fn()
        db.exec('COMMIT')
        return value
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
}
