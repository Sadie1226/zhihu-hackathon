/**
 * d10 · 串味回归：主人说过的话，能不能从别的狗身上读出来
 *
 * 红线第 2 条是「主人聊天原文、称呼、城市、照片进 payload 或 snapshot —— 串味」。
 * 规划表里写的是「11-28 回归时专门测 A 的私聊文本是否出现在 B 的设备上」。
 *
 * d7 已经有一层：寄出去的原话只许命中 `exchange.payload`。但那条跑在**没有快照被写**
 * 的场景里 —— 而 `snapshot` 正是「别人看到你的狗」时读的那一份，它才是串味最贵的地方。
 * 所以这里补的是：**快照真的被派生并落库之后**，那几类私密文本还在不在里面。
 *
 * 三类文本分开测，因为它们走三条不同的路：
 *   1. 主人通过狗捎出去的原话 → `exchange.payload.message`（d 写）
 *   2. 主人给礼物起的名字 → `exchange.payload.giftName`（d 写）
 *   3. 狗回家对主人说的话   → `message.text`（b 写，d 只读）
 *
 * 快照里允许出现的东西只有五样，这条测试不重新定义它们，只锁一件事：
 * 上面三类文本一个字都不许进去。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTripService } from '../lib/trips/service.ts'
import { insertExchange, mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'
import { findTextEverywhere, hitList } from './helpers/text-leak-scan.mjs'

// 三个标记串都长得足够怪异，不会和事件文案、装配单、种子数据撞上。
const LEAK_WORDS = 'zz主-人-原-话-1128zz'
const LEAK_GIFT = 'zz礼-物-名-1128zz'
const LEAK_DOG_VOICE = 'zz狗-对-主-人-说-1128zz'

const PUBLIC_TEXT_A = '墙根有一小片新绿。'

test('d10 串味：原话 / 礼物名 / 狗对主人说的话，都不进快照', { timeout: 30000 }, async (t) => {
  const { db } = mailboxDatabase(t)
  const a = ownedDog(db, 'dog_a')
  const b = ownedDog(db, 'dog_b')

  // 一条公开事件模板；两个狗都只用它。文本里不含任何标记串。
  db.exec(`INSERT INTO event(id, code, text, season, weather, time_of_day)
    VALUES ('ev_public', 'ev_public_green', '墙根有一小片新绿。', 'any', 'any', 'any')`)

  let clock = '2026-11-28T01:00:00Z'
  const trips = createTripService(db, { now: () => new Date(clock) })

  // ---- 三类私密文本各自入座 ----
  // 时间错开半小时：快照的 waiting_for 取「最早那条待回应的」，
  // 不错开的话两条并列，取哪条取决于排序细节，断言会变得不可复现。
  insertExchange(db, 'ex_gift', b.id, a.id, 1, {
    kind: 'gift', giftName: LEAK_GIFT, note: '顺路带的', imagePath: null,
  }, '2026-11-28T00:30:00Z')
  insertExchange(db, 'ex_words', a.id, b.id, 1, {
    kind: 'co_owner_message', message: LEAK_WORDS, fromOwnerOf: a.id,
  }, '2026-11-28T01:00:00Z')

  // ---- 甲第一趟：收下乙的礼物（投递发生在出发那一刻）----
  const a1 = trips.create(a.id, a.sessionId, 'auto')
  trips.start(a1.id, a.sessionId)
  db.prepare('INSERT INTO trip_event VALUES (?,?,?,?)').run(a1.id, 'ev_public', a.id, clock)
  trips.finish(a1.id, a.sessionId, 'done')

  // 狗回家对主人说了一句话（b 的地盘，d 只读）。它绝对不能进快照。
  db.prepare('INSERT INTO message(id, trip_id, text, mentions_find_id, created_at) VALUES (?,?,?,?,?)')
    .run('msg_a', a1.id, LEAK_DOG_VOICE, null, clock)

  // ---- 乙第一趟：收下甲的话 ----
  clock = '2026-11-28T09:00:00Z'
  const b1 = trips.create(b.id, b.sessionId, 'auto')
  trips.start(b1.id, b.sessionId)
  db.prepare('INSERT INTO trip_event VALUES (?,?,?,?)').run(b1.id, 'ev_public', b.id, clock)
  trips.finish(b1.id, b.sessionId, 'done')

  // ---- 甲第二趟：这一趟的快照才「有内容」——上一趟摘要 + 在等的东西 ----
  clock = '2026-11-28T17:00:00Z'
  const a2 = trips.create(a.id, a.sessionId, 'auto')
  trips.start(a2.id, a.sessionId)
  trips.finish(a2.id, a.sessionId, 'done')

  // ---- 乙第二趟 ----
  clock = '2026-11-29T01:00:00Z'
  const b2 = trips.create(b.id, b.sessionId, 'auto')
  trips.start(b2.id, b.sessionId)
  trips.finish(b2.id, b.sessionId, 'done')

  // 前提自检：确实生成了「有内容」的快照，否则后面的断言是空跑。
  const snaps = db.prepare('SELECT dog_id, version, recent_trips, waiting_for FROM snapshot ORDER BY dog_id, version').all()
  assert.ok(snaps.length >= 4, `至少该有 4 个快照版本，实得 ${snaps.length}`)
  const latest = (dogId) => snaps.filter((row) => row.dog_id === dogId).at(-1)
  assert.ok(JSON.parse(latest('dog_a').recent_trips).length > 0, '甲最新快照该带上一趟摘要')
  // waiting_for 说的是「**我寄出去的**东西在等对方回」：
  //   甲寄了那句话 → 等一句回话
  //   乙寄了那份礼物 → 等一份礼物的回音
  // 两种模板都不带具体内容（不拼原话、不拼礼物名），下面再来锁死这一点。
  assert.equal(latest('dog_a').waiting_for, '等一句回话', '甲寄了话，等的是回话')
  assert.equal(latest('dog_b').waiting_for, '等一份礼物的回音', '乙寄了礼物，等的是礼物回音')

  // ---- 正题：快照里一个字都没有 ----
  for (const row of snaps) {
    for (const [needle, label] of [[LEAK_WORDS, '主人原话'], [LEAK_GIFT, '礼物名'], [LEAK_DOG_VOICE, '狗对主人说的话']]) {
      for (const column of ['recent_trips', 'waiting_for']) {
        assert.ok(
          !String(row[column] ?? '').includes(needle),
          `${row.dog_id} v${row.version} 的 ${column} 里出现了${label}`,
        )
      }
    }
  }

  // ---- 更狠的一层：整库搜，只许出现在各自该待的地方 ----
  assert.deepEqual(
    hitList(findTextEverywhere(db, LEAK_WORDS)),
    ['exchange.payload'],
    '主人原话只许待在 exchange.payload',
  )
  assert.deepEqual(
    hitList(findTextEverywhere(db, LEAK_GIFT)),
    ['exchange.payload'],
    '礼物名只许待在 exchange.payload',
  )
  assert.deepEqual(
    hitList(findTextEverywhere(db, LEAK_DOG_VOICE)),
    ['message.text'],
    '狗对主人说的话只许待在 message.text',
  )

  // 顺手确认：公开事件文本该在的地方（快照摘要 + 事件表）是有的 ——
  // 说明不是「什么都被清空了」才显得干净。
  const publicHits = hitList(findTextEverywhere(db, PUBLIC_TEXT_A))
  assert.ok(publicHits.includes('event.text'), '公开文案该在 event.text')
  assert.ok(publicHits.some((hit) => hit.startsWith('snapshot.')), '公开文案该能被快照读到（否则快照是空的）')

  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
})
