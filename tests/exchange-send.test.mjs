/**
 * POST /api/exchanges —— d6「寄出 → 延后到达 → 等回应」的端到端验收。
 *
 * 这组用例不测 `gift.ts` 的业务规则（那边 `lib/social/gift.test.ts` 已经 40+ 条），
 * 只测一件事：**HTTP 这一层接上之后，一件东西能不能走完整个生命周期**，
 * 以及那些只有走到 HTTP 才会暴露的漏洞（冒名、跨站、静默覆盖入参）。
 *
 * 时间轴（全部是构造出来的，不用等真实时钟）：
 *   第 1 天 09:00  甲寄出礼物 → deliveredAt=null（在路上），应在乙的第 1 趟到
 *   第 1 天 10:00  乙出发        → 到达
 *   第 2 天 09:00  乙再出发      → 已到的不再投一次（d6 的阻断缺陷就是这个）
 *
 * 上面的钟点只是示意：**到达与否由 seq 决定，不由时间决定**。换成真实时钟也一样过，
 * 这正是 `deliver_after_trip_seq` 存在的理由 —— 若哪天有人改成「now > 某个时间戳」，
 * 第一条用例里「乙出发后立即到达」就会变成「永远在路上」。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTripService } from '../lib/trips/service.ts'
import { isWaitingForReply, readOutbox } from '../lib/mailbox/service.ts'
import { resolveAuthContext } from '../lib/auth/session.ts'
import { handleExchangeSend } from '../lib/social/send-endpoint.ts'
import { mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'

const GIFT = { kind: 'gift', giftName: '一小卷灰蓝色的毛线', note: '天气要冷了', imagePath: null, sourceFindId: null, sourceMode: null }
const MESSAGE = { kind: 'co_owner_message', message: '楼下的桂花开了，你那边闻得到吗' }

function post(db, cookie, body, { key = 'submit-1', headers = {} } = {}) {
  const all = { cookie, 'content-type': 'application/json', ...headers }
  if (key !== null) all['idempotency-key'] = key
  return handleExchangeSend(
    new Request('http://localhost/api/exchanges', { method: 'POST', body: JSON.stringify(body), headers: all }),
    () => db,
  )
}

async function json(response, status) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('vary'), 'Cookie')
  return response.json()
}

/** 寄件方视角里，「到了、在等回应」的那几条。判定式只有一份，见 `isWaitingForReply`。 */
const waitingFor = (rows) => rows.filter(isWaitingForReply)

test('一件礼物走完：在路上 → 下一次出行到达 → 寄件方在等回应', async (t) => {
  const { db } = mailboxDatabase(t)
  const sender = ownedDog(db, 'dog_a')
  const receiver = ownedDog(db, 'dog_b')

  // ---- 寄出 ----
  const sent = await json(await post(db, sender.cookie, { fromDog: 'dog_a', toDog: 'dog_b', kind: 'gift', payload: GIFT }), 200)
  assert.equal(sent.exchange.fromDog, 'dog_a')
  assert.equal(sent.exchange.toDog, 'dog_b')
  assert.equal(sent.exchange.kind, 'gift')
  assert.deepEqual(sent.exchange.payload, GIFT)
  // 收件狗还没出过门 → 应在它的第 1 趟到。
  assert.equal(sent.exchange.deliverAfterTripSeq, 1)
  // 关键：寄出的瞬间是「在路上」，不是「已到」。
  assert.equal(sent.exchange.deliveredAt, null)
  assert.equal(sent.exchange.repliedAt, null)
  assert.equal(sent.exchange.readAt, null)

  // 在路上时，寄件方不该有任何「在等回音」的感觉 —— 还没到，谈不上等。
  assert.deepEqual(waitingFor(readOutbox(db, 'dog_a', sender.sessionId).exchanges), [])

  // ---- 收件狗出发 ----
  const day1 = createTripService(db, { now: () => new Date('2026-11-24T10:00:00Z') })
  const delivered = day1.start(day1.create('dog_b', receiver.sessionId, 'auto').id, receiver.sessionId)
  assert.deepEqual(delivered.delivered.map((row) => row.id), [sent.exchange.id])
  const arrivedAt = delivered.delivered[0].deliveredAt
  assert.ok(Number.isFinite(Date.parse(arrivedAt)), '到达时间必须是真实写入的时间')

  // ---- 寄件方看到「到了，在等」 ----
  const outbox = readOutbox(db, 'dog_a', sender.sessionId).exchanges
  assert.equal(outbox.length, 1)
  assert.equal(outbox[0].deliveredAt, arrivedAt)
  assert.equal(outbox[0].repliedAt, null)
  assert.deepEqual(waitingFor(outbox).map((row) => row.id), [sent.exchange.id])

  // ---- 对方回应之后，就不再「在等」 ----
  // replied_at 归 b，这里只是把那一列改成已回应，验证判定式的另一半。
  db.prepare('UPDATE exchange SET replied_at = ? WHERE id = ?').run('2026-11-24T11:00:00Z', sent.exchange.id)
  assert.deepEqual(waitingFor(readOutbox(db, 'dog_a', sender.sessionId).exchanges), [])
})

test('幂等按「这次提交」算，不按「这份内容」算', async (t) => {
  const { db } = mailboxDatabase(t)
  const sender = ownedDog(db, 'dog_a')
  ownedDog(db, 'dog_b')
  const body = { fromDog: 'dog_a', toDog: 'dog_b', kind: 'gift', payload: GIFT }

  const first = await json(await post(db, sender.cookie, body, { key: 'submit-1' }), 200)
  // 断网重试：同一个 key，必须还是同一条，且不再写一行。
  const retry = await json(await post(db, sender.cookie, body, { key: 'submit-1' }), 200)
  assert.equal(retry.exchange.id, first.exchange.id)
  assert.equal(retry.exchange.deliverAfterTripSeq, first.exchange.deliverAfterTripSeq)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exchange').get().n, 1)

  // 真的想把同一份东西再送一次：换了 key，就该是新的一条。
  // 这条是反面用例 —— 如果哪天有人把「内容哈希」当幂等键，这里会变红。
  const second = await json(await post(db, sender.cookie, body, { key: 'submit-2' }), 200)
  assert.notEqual(second.exchange.id, first.exchange.id)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exchange').get().n, 2)
})

test('重复出发不会把同一件东西再投一次', async (t) => {
  const { db } = mailboxDatabase(t)
  const sender = ownedDog(db, 'dog_a')
  const receiver = ownedDog(db, 'dog_b')
  const { exchange } = await json(
    await post(db, sender.cookie, { fromDog: 'dog_a', toDog: 'dog_b', kind: 'co_owner_message', payload: MESSAGE }), 200)

  const day1 = createTripService(db, { now: () => new Date('2026-11-24T10:00:00Z') })
  const trip1 = day1.create('dog_b', receiver.sessionId, 'auto')
  const firstDelivery = day1.start(trip1.id, receiver.sessionId)
  assert.deepEqual(firstDelivery.delivered.map((row) => row.id), [exchange.id])
  const deliveredAt = firstDelivery.delivered[0].deliveredAt

  // 同一次出发重复 start：状态机直接短路，不会再投。
  assert.deepEqual(day1.start(trip1.id, receiver.sessionId).delivered, [])
  day1.finish(trip1.id, receiver.sessionId, 'done')

  // 第二天再出一趟门：已经到了的东西不该被重投，也不该改写到达时间。
  const day2 = createTripService(db, { now: () => new Date('2026-11-25T10:00:00Z') })
  const second = day2.start(day2.create('dog_b', receiver.sessionId, 'auto').id, receiver.sessionId)
  assert.deepEqual(second.delivered, [])
  assert.equal(db.prepare('SELECT delivered_at AS at FROM exchange WHERE id = ?').get(exchange.id).at, deliveredAt)
})

test('冒名、错 kind、缺幂等键、静默覆盖入参与跨站请求全部拒绝，且一行都不写', async (t) => {
  const { db } = mailboxDatabase(t)
  const sender = ownedDog(db, 'dog_a')
  ownedDog(db, 'dog_b')  // 属于另一个 owner
  db.prepare(`INSERT INTO dog(id, session_id, owner_id, personality_tags, assembly, is_sample, created_at)
    VALUES ('dog_seed_01', 'seed', NULL, '["好奇","看物","直给"]', '{"outfit":null,"cloth":"S02-leaf-cape","accessory":null,"face":"F01-neutral"}', 1, ?)`)
    .run('2026-11-24T00:00:00Z')

  const ok = { fromDog: 'dog_a', toDog: 'dog_b', kind: 'gift', payload: GIFT }
  const reject = async (body, options, status, code) => {
    const result = await json(await post(db, sender.cookie, body, options), status)
    assert.deepEqual(Object.keys(result).sort(), ['code', 'detail', 'retriable'])
    assert.equal(result.code, code)
    assert.equal(result.retriable, false)
  }

  // 冒名：拿甲的 session 用乙的狗寄东西。按「不存在」回答，不给「存在但无权」这种可探测的差别。
  await reject({ ...ok, fromDog: 'dog_b' }, {}, 404, 'NOT_FOUND')
  // 同理，种子狗背后没有主人，也没有任何 session 能拥有它。
  await reject({ ...ok, fromDog: 'dog_seed_01' }, {}, 404, 'NOT_FOUND')
  // 收件狗不存在。
  await reject({ ...ok, toDog: 'dog_nobody' }, {}, 409, 'CONFLICT')

  // find / greeting 是相遇时的当场产物，不能从这里凭空造一次相遇。
  await reject({ ...ok, kind: 'find', payload: { kind: 'find', findTitle: '一盏灯', findExcerpt: null, sourceUrl: null, sourceFindId: null, sourceMode: null } }, {}, 409, 'CONFLICT')
  await reject({ ...ok, kind: 'greeting', payload: { kind: 'greeting', line: '今天有风', weather: null } }, {}, 409, 'CONFLICT')

  // 幂等键缺失 / 畸形。
  await reject(ok, { key: null }, 409, 'CONFLICT')
  await reject(ok, { key: 'x'.repeat(129) }, 409, 'CONFLICT')
  await reject(ok, { key: 'has space' }, 409, 'CONFLICT')

  // 静默覆盖入参：payload 里塞一个同名的 fromDog，若不拒就会寄给另一个人且不报错。
  await reject({ ...ok, payload: { ...GIFT, fromDog: 'dog_b' } }, {}, 409, 'CONFLICT')
  await reject({ ...ok, payload: { ...GIFT, idempotencyKey: 'other' } }, {}, 409, 'CONFLICT')
  // 未知键（chatText 是主人聊天原文的形状）交给 rules 的白名单拒。
  await reject({ ...ok, payload: { ...GIFT, chatText: '我们昨晚说的那件事' } }, {}, 409, 'CONFLICT')

  // 长度由 rules.ts 卡：note 上限 40 字。
  await reject({ ...ok, payload: { ...GIFT, note: '很'.repeat(41) } }, {}, 409, 'CONFLICT')

  // 形状：多一个顶层字段、少一个、JSON 不是对象。
  await reject({ ...ok, extra: 1 }, {}, 409, 'CONFLICT')
  await reject({ fromDog: 'dog_a', toDog: 'dog_b', kind: 'gift' }, {}, 409, 'CONFLICT')

  // 跨站与查询参数。
  await reject(ok, { headers: { origin: 'https://foreign.example' } }, 409, 'CONFLICT')
  await reject(ok, { headers: { 'sec-fetch-site': 'cross-site' } }, 409, 'CONFLICT')
  const withQuery = await handleExchangeSend(new Request('http://localhost/api/exchanges?to_dog=dog_b', {
    method: 'POST', body: JSON.stringify(ok),
    headers: { cookie: sender.cookie, 'content-type': 'application/json', 'idempotency-key': 'k' },
  }), () => db)
  await json(withQuery, 409)

  // 没登录。
  const anonymous = await handleExchangeSend(new Request('http://localhost/api/exchanges', {
    method: 'POST', body: JSON.stringify(ok),
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
  }), () => db)
  await json(anonymous, 404)

  // 上面每一条都应该在写库之前被挡住。
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exchange').get().n, 0)

  // 对照组：同样的请求体、合法的身份与 key，就该成功 —— 免得上面的拒绝是因为别的原因。
  await json(await post(db, sender.cookie, ok, { key: 'submit-1' }), 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exchange').get().n, 1)
})

test('拉黑的一对不再互寄', async (t) => {
  const { db } = mailboxDatabase(t)
  const sender = ownedDog(db, 'dog_a')
  ownedDog(db, 'dog_b')
  db.prepare(`INSERT INTO relation(id, dog_a, dog_b, first_met_at, last_met_at, met_count, is_blocked, blocked_at)
    VALUES ('rel_a__b', 'dog_a', 'dog_b', ?, ?, 1, 1, ?)`)
    .run('2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z', '2026-11-23T00:00:00Z')

  const response = await post(db, sender.cookie, { fromDog: 'dog_a', toDog: 'dog_b', kind: 'gift', payload: GIFT })
  await json(response, 409)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exchange').get().n, 0)
})

for (const state of ['revoked', 'expired']) {
  test(`session ${state} while reading body cannot send`, async (t) => {
    const { db } = mailboxDatabase(t)
    const sender = ownedDog(db, 'dog_late_sender')
    ownedDog(db, 'dog_late_receiver')
    const request = new Request('http://localhost/api/exchanges', {
      method: 'POST', body: '{}', headers: { cookie: sender.cookie,
        'content-type': 'application/json', 'idempotency-key': `late-${state}` },
    })
    const auth = resolveAuthContext(request, db)
    assert.ok(auth)
    request.json = async () => {
      if (state === 'revoked') db.prepare('UPDATE owner_session SET revoked_at = created_at WHERE token_hash = ?').run(auth.tokenHash)
      else db.prepare('UPDATE owner_session SET created_at = 0, expires_at = 1 WHERE token_hash = ?').run(auth.tokenHash)
      assert.equal(resolveAuthContext(request, db), null)
      return { fromDog: 'dog_late_sender', toDog: 'dog_late_receiver', kind: 'co_owner_message', payload: MESSAGE }
    }
    await json(await handleExchangeSend(request, () => db), 404)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exchange').get().n, 0)
  })
}
