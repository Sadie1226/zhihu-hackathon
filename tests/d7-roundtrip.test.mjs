/**
 * d7 —— 捎话走完一个完整来回
 *
 * 已有用例覆盖的是**分段**：`gift.test.ts` 管规则（超长、种子狗禁言、幂等键），
 * `exchange-send.test.mjs` 管礼物的 HTTP 生命周期，`mailbox-delivery.test.mjs` 管投递器。
 * 没有一条证明过下面这句话：
 *
 *     主人写一句话 → 狗带出门 → 对面收到 → 对面回一句 → 原方看到回音
 *
 * 这正是 d7 的验收标准（「一个人能走完的完整来回」），也是 d9 双设备联调的前提 ——
 * 两台机器各跑一半，中间那半必须先在一台机器上跑通过一次。
 *
 * 三个断言值得单独说：
 *   1. **到达由 seq 决定**，不是时钟。第二趟不会把已到的再投一次。
 *   2. **原话只进 payload**：派生快照（狗能读到的全部）里不许出现那句话。
 *   3. **回音是寄件方视角**：`isWaitingForReply` 在对面回应后必须为 false，
 *      且重放回应不覆盖首次 `replied_at`。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTripService } from '../lib/trips/service.ts'
import { isWaitingForReply, readInbox, readOutbox } from '../lib/mailbox/service.ts'
import { handleExchangeSend } from '../lib/social/send-endpoint.ts'
import { writeReply } from '../lib/replies/idempotency.ts'
import { mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'

/** 主人原话。挑一句有辨识度的，好在快照里搜。 */
const WORDS = '楼下的桂花开了，你那边闻得到吗'

function post(db, cookie, body, key = 'd7-submit-1') {
  return handleExchangeSend(
    new Request('http://localhost/api/exchanges', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { cookie, 'content-type': 'application/json', 'idempotency-key': key },
    }),
    () => db,
  )
}

test('d7 来回：写话 → 出门 → 对面收到 → 对面回 → 原方看到回音', { timeout: 20000 }, async (t) => {
  const { db } = mailboxDatabase(t)
  const sender = ownedDog(db, 'dog_a')
  const receiver = ownedDog(db, 'dog_b')

  // 两个不同的 owner 才算「对面」，自查一遍，避免夹具退化成自问自答。
  assert.notEqual(sender.sessionId, receiver.sessionId)

  let clock = '2026-11-26T01:00:00Z'
  const trips = createTripService(db, { now: () => new Date(clock) })

  // ---- 一、写话并寄出 ----
  const sent = await post(db, sender.cookie, {
    fromDog: 'dog_a',
    toDog: 'dog_b',
    kind: 'co_owner_message',
    payload: { kind: 'co_owner_message', message: WORDS },
  })
  assert.equal(sent.status, 200)
  const out = (await sent.json()).exchange
  assert.equal(out.kind, 'co_owner_message')
  assert.equal(out.payload.message, WORDS)
  // 冗余但保留：读的人一眼知道这是谁的主人，不必回查。
  assert.equal(out.payload.fromOwnerOf, 'dog_a')
  // 收件狗还没出过门 → 应在它的第 1 趟到。寄出瞬间必须是「在路上」。
  assert.equal(out.deliverAfterTripSeq, 1)
  assert.equal(out.deliveredAt, null)
  assert.equal(isWaitingForReply(out), false, '还没到，谈不上等回音')

  // ---- 二、对面（收件狗）出门 ----
  // 出门前在收件箱里是「在路上」，不是「已到」。
  assert.deepEqual(readInbox(db, 'dog_b', receiver.sessionId, 'arrived').exchanges, [])
  assert.deepEqual(
    readInbox(db, 'dog_b', receiver.sessionId, 'onTheWay').exchanges.map((row) => row.id),
    [out.id],
  )

  const trip = trips.create('dog_b', receiver.sessionId, 'auto')
  assert.equal(trip.seq, 1)
  const started = trips.start(trip.id, receiver.sessionId)
  assert.deepEqual(started.delivered.map((row) => row.id), [out.id])

  const arrived = readInbox(db, 'dog_b', receiver.sessionId, 'arrived').exchanges
  assert.equal(arrived.length, 1)
  assert.equal(arrived[0].payload.message, WORDS, '原话送达，一字不改')
  assert.equal(arrived[0].payload.fromOwnerOf, 'dog_a')
  assert.ok(arrived[0].deliveredAt, '到达时间由投递器写')
  assert.equal(arrived[0].readAt, null)
  assert.equal(arrived[0].repliedAt, null)

  // 寄件方这时「在等回音」——这是陈述，不是待办。
  const waiting = readOutbox(db, 'dog_a', sender.sessionId).exchanges.filter(isWaitingForReply)
  assert.deepEqual(waiting.map((row) => row.id), [out.id])

  // ---- 三、对面回一句 ----
  clock = '2026-11-26T02:00:00Z'
  const replied = writeReply(db, { source: { kind: 'exchange', id: out.id }, text: '闻得到，风是从西边来的', photoUrl: null })
  assert.equal(replied.kind, 'created')
  const afterReply = db.prepare('SELECT delivered_at, replied_at FROM exchange WHERE id = ?').get(out.id)
  assert.equal(afterReply.delivered_at, arrived[0].deliveredAt, '回应不改到达时间')
  assert.equal(afterReply.replied_at, replied.reply.createdAt)

  // ---- 四、原方看到回音 ----
  const box = readOutbox(db, 'dog_a', sender.sessionId).exchanges
  const mine = box.find((row) => row.id === out.id)
  assert.equal(mine.repliedAt, replied.reply.createdAt)
  assert.equal(isWaitingForReply(mine), false, '回过就不再等了')

  // 重放回应：库里仍是一条，首次 replied_at 不被覆盖。
  clock = '2026-11-26T03:00:00Z'
  const replay = writeReply(db, { source: { kind: 'exchange', id: out.id }, text: '闻得到，风是从西边来的', photoUrl: null })
  assert.equal(replay.kind, 'duplicate')
  assert.equal(replay.reply.id, replied.reply.id)
  assert.equal(
    db.prepare('SELECT replied_at FROM exchange WHERE id = ?').get(out.id).replied_at,
    replied.reply.createdAt,
    '重放不许改写首次回应时间',
  )

  // ---- 五、第二趟不重复投递（d6 的阻断缺陷）----
  trips.finish(trip.id, receiver.sessionId, 'done')
  // 两次出发至少隔 6 小时（service 的既有约束），不是这回要验的东西，绕开即可。
  clock = '2026-11-26T09:00:00Z'
  const second = trips.create('dog_b', receiver.sessionId, 'auto')
  assert.equal(second.seq, 2)
  assert.deepEqual(trips.start(second.id, receiver.sessionId).delivered, [], '已到的不再投递')
  assert.equal(
    db.prepare('SELECT delivered_at FROM exchange WHERE id = ?').get(out.id).delivered_at,
    arrived[0].deliveredAt,
  )

  // ---- 六、原话只待在 exchange.payload ----
  // 这是不变量五的实现方式：原话不许进快照、不许进任何「狗能读到」的地方。
  // 与其逐个猜日志表，不如直接在**整库**搜这句话，只允许一处命中。
  const hits = findTextEverywhere(db, WORDS)
  assert.deepEqual(
    hits,
    [{ table: 'exchange', column: 'payload', rows: 1 }],
    '主人原话只许出现在 exchange.payload，别处一个字段都不许有',
  )
})

/**
 * 在整库所有表的文本列里搜一段字，返回命中的表/列/行数。
 *
 * 为什么要扫全库：原话泄漏不会只发生在某一处。今天可能是 `trip_event.text`，
 * 明天可能有人给 `snapshot` 加个字段，后天可能是某个诊断表。列白名单会漏，
 * 全库搜不会 —— 多花的这一秒很值。
 */
function findTextEverywhere(db, needle) {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all()
  const hits = []
  for (const { name: table } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all()
    for (const { name: column, type } of columns) {
      // 只看文本列：整型/布尔的 CAST 成文本也可能巧合命中，没必要。
      if (!/CHAR|CLOB|TEXT/i.test(String(type ?? ''))) continue
      const where = `WHERE CAST(${JSON.stringify(column)} AS TEXT) LIKE ?`
      const placeholders = `%${needle}%`
      let rows
      try {
        rows = db.prepare(`SELECT count(*) AS n FROM ${JSON.stringify(table)} ${where}`).get(placeholders).n
      } catch {
        // 有些表是 WITHOUT ROWID 或有奇怪约束；查不动就跳过，别因此误判「干净」。
        throw new Error(`扫描 ${table}.${column} 失败 —— 不能因为查不了就当作没命中`)
      }
      if (rows > 0) hits.push({ table, column, rows })
    }
  }
  return hits
}

