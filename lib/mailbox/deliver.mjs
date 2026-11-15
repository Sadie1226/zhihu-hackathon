/**
 * 投递器 —— 全系统唯一会写 exchange.delivered_at 的地方。
 * 出 c，11-16。c8 的骨架，11-21 接上页面。
 *
 * 三条不许改的：
 *   1. **只有这个文件能写 delivered_at。** 别处一律不许碰这一列。
 *   2. **不写 replied_at。** 那是 b 的回应能力独占的。顺手写一下就会出现
 *      「礼物到了但显示已回应」的错状态。
 *   3. **判断到达用 seq，不用时钟。** 写成 now > 某个时间戳，
 *      演示时延后礼物永远不会到。
 *
 * 到达语义：收件狗下一次出行开始的那一刻。三种 kind 同一时刻。
 */

/**
 * 把「该到的」全部标记为已到。幂等：重复调用不会覆盖已有的 delivered_at。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dogId      收件狗
 * @param {number} tripSeq    这一次出行的 seq（收件狗的第几次出行）
 * @param {string} at         ISO 时间，写进 delivered_at
 * @returns {{ deliveredIds: string[] }}  本次真正投递了哪些
 */
export function deliverOnTripStart(db, dogId, tripSeq, at) {
  if (!Number.isInteger(tripSeq) || tripSeq < 1) {
    throw new Error(`tripSeq 必须是 >=1 的整数，收到 ${tripSeq}`)
  }

  // 先取出来，为了能向上层返回「这次到了哪些」。
  // 但**写入以 UPDATE 为准**，不是以这次查询为准 —— 两个请求并发时，
  // 查询结果可能都是 2 条，UPDATE 的 WHERE 会把第二次过滤成 0 条。
  const candidates = db.prepare(`
    SELECT id FROM exchange
     WHERE to_dog = ?
       AND delivered_at IS NULL
       AND deliver_after_trip_seq <= ?
     ORDER BY created_at ASC
  `).all(dogId, tripSeq)

  if (candidates.length === 0) return { deliveredIds: [] }

  // 幂等的关键在 `delivered_at IS NULL`：
  // 不用「先查再写」（两个请求会各写一次），而是让数据库来裁决。
  const upd = db.prepare(`
    UPDATE exchange
       SET delivered_at = ?
     WHERE id = ?
       AND delivered_at IS NULL
  `)

  const deliveredIds = []
  for (const { id } of candidates) {
    const r = upd.run(at, id)
    if (r.changes === 1) deliveredIds.push(id)
  }

  return { deliveredIds }
}

/**
 * 一条 exchange 到没到。**只读，不改。**
 * 给 d / e 查「我的礼物到了没」，别自己写 now > x。
 *
 * 和 types.ts 的 isDeliverable() 同一套语义，这里是从库直接查。
 */
export function isArrived(db, exchangeId) {
  const row = db.prepare(`
    SELECT e.id,
           e.delivered_at,
           e.deliver_after_trip_seq,
           EXISTS (
             SELECT 1 FROM trip t
              WHERE t.dog_id = e.to_dog
                AND t.started_at IS NOT NULL
                AND t.seq >= e.deliver_after_trip_seq
           ) AS should_have_arrived
      FROM exchange e
     WHERE e.id = ?
  `).get(exchangeId)

  if (!row) return null
  return {
    id: row.id,
    arrived: row.delivered_at !== null,
    // 该到但没到 = 投递器漏跑了。这是个真 bug，不是正常状态。
    overdue: row.delivered_at === null && row.should_have_arrived === 1,
    deliveredAt: row.delivered_at,
    deliverAfterTripSeq: row.deliver_after_trip_seq,
  }
}

/**
 * 收件狗的收件箱，按「在路上 / 已到」分开。
 * e 的来信页直接用这个，不要自己按 delivered_at 筛。
 */
export function inbox(db, dogId) {
  const rows = db.prepare(`
    SELECT id, from_dog, kind, payload, deliver_after_trip_seq,
           created_at, delivered_at, replied_at, read_at
      FROM exchange
     WHERE to_dog = ?
     ORDER BY created_at DESC
  `).all(dogId)

  return rows.map((r) => ({
    ...r,
    payload: JSON.parse(r.payload),
    // 三态。⚠️ `replied_at` 也算已读 —— 回应过一件东西，必然是看过了。
    // 不这么写会出现「已回应但未读」这种谁也解释不了的状态，
    // 因为 read_at 只有 e 写，而回应是 b 的能力，两者不一定同时发生。
    state:
      r.delivered_at === null ? 'onTheWay'
      : r.read_at !== null || r.replied_at !== null ? 'read'
      : 'arrived',
  }))
}
