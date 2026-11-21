/**
 * gift.ts 的用例。**分两段跑**：
 *
 *   A 段 · Mock 验收 —— `MemoryStore`，验业务逻辑本身
 *   B 段 · 真库验收 —— `createSqliteStore()` + 真 `contracts/schema.sql`，验真库认不认
 *
 * 为什么分开：c 11/19 答复要求「Mock 验收与真实信箱验收分开记录」。
 * 两段用的是**同一个 gift.ts**，一段过一段不过，就说明问题在存储层不在业务层。
 *
 * 跑法：node --experimental-strip-types lib/social/gift.test.ts
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { sendCoOwnerMessage, sendGift, GiftError, deliverAfterTripSeqFor } from './gift.ts'
import { nextDeliverSeq } from './meet.ts'
import { createMemoryStore } from './store.ts'
import type { MemoryStore } from './store.ts'
import { createSqliteStore } from './sqlite-store.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA = fs.readFileSync(path.resolve(HERE, '../../contracts/schema.sql'), 'utf8')

const T0 = '2026-11-19T08:00:00Z'
const A = 'dog_owner' // 我的狗
const B = 'dog_neighbor' // 邻居
const SEED = 'dog_seed_07' // 种子狗（青椒）

// ===========================================================================
// 断言器
// ===========================================================================

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (err) {
    fail++
    const msg = `${name} → ${(err as Error).message}`
    failures.push(msg)
    console.log(`  ❌ ${msg}`)
  }
}

/** 期望被拒。name 传 '' 表示由外层 check 计数（避免输出里出现空名字行）。 */
function expectCode(name: string, fn: () => void, code: string): void {
  try {
    fn()
  } catch (err) {
    const e = err as GiftError
    if (!(err instanceof GiftError)) throw new Error(`期望 GiftError(${code})，实际抛出别的：${(err as Error).message}`, { cause: err })
    const got = String(e.code)
    if (got !== code) throw new Error(`期望 ${code}，实际 ${got}：${e.message}`, { cause: err })
    if (name !== '') {
      pass++
      console.log(`  ✅ ${name} → ${code}`)
    }
    return
  }
  if (name !== '') {
    fail++
    const msg = `${name} → 期望被拒（${code}），实际通过`
    failures.push(msg)
    console.log(`  ❌ ${msg}`)
  }
  throw new Error(`没有被拒（期望 ${code}）`)
}

function keysOf(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort()
}

// ===========================================================================
// A · Mock 验收
// ===========================================================================

console.log('\nA · Mock 验收（MemoryStore）')

function mockStore(opts: Parameters<typeof createMemoryStore>[0] = {}): MemoryStore {
  return createMemoryStore({ seqs: { [A]: 0, [B]: 0 }, ...opts })
}

check('A1 正常礼物 → 1 条，payload 六键（K v4 起含来源两键）', () => {
  const store = mockStore()
  const r = sendGift({
    store,
    fromDog: A,
    toDog: B,
    giftName: '一小卷灰蓝色的毛线',
    note: '天气要冷了',
    imagePath: null,
    idempotencyKey: 'gift-001',
    now: T0,
  })
  assert.equal(store.exchanges.length, 1)
  assert.equal(r.inserted, true)
  assert.deepEqual(keysOf(r.exchange.payload), [
    'giftName',
    'imagePath',
    'kind',
    'note',
    'sourceFindId',
    'sourceMode',
  ])
  assert.equal(r.exchange.payload.kind, 'gift')
})

check('A2 正常捎话 → payload 只有三个键，fromOwnerOf 恒等于 fromDog', () => {
  const store = mockStore()
  const r = sendCoOwnerMessage({
    store,
    fromDog: A,
    toDog: B,
    message: '楼下的桂花开了',
    idempotencyKey: 'msg-001',
    now: T0,
  })
  assert.equal(store.exchanges.length, 1)
  assert.deepEqual(keysOf(r.exchange.payload), ['fromOwnerOf', 'kind', 'message'])
  assert.equal(r.exchange.payload.fromOwnerOf, A)
})

check('A3 同一个 idempotencyKey 写两次 → 库里仍 1 条，且第二次返回的是库里的那条（不是本次入参）', () => {
  const store = mockStore()
  const first = sendGift({
    store,
    fromDog: A,
    toDog: B,
    giftName: '毛线',
    note: '天气要冷了',
    idempotencyKey: 'gift-dup',
    now: T0,
  })
  // 第二次**故意改内容**：如果实现回显本次 draft，就会返回改了的那版 —— 那是库里不存在的消息。
  const second = sendGift({
    store,
    fromDog: A,
    toDog: B,
    giftName: '茶杯',
    note: '换一句',
    idempotencyKey: 'gift-dup',
    now: '2026-11-19T10:00:00Z',
  })
  assert.equal(store.exchanges.length, 1)
  assert.equal(first.inserted, true)
  assert.equal(second.inserted, false)
  assert.equal(first.id, second.id)
  // 持久化事实：名字、附言、趟次都必须是第一次那版
  assert.equal(second.exchange.payload.giftName, '毛线')
  assert.equal(second.exchange.payload.note, '天气要冷了')
  assert.equal(second.deliverAfterTripSeq, first.deliverAfterTripSeq)
  // 库里也只有一条，且是第一次的
  assert.equal(store.exchanges[0].payload.giftName, '毛线')
})

check('A4 收件狗是种子狗 → 正常落库，payload 里没有任何「主人话」', () => {
  const store = mockStore({ samples: [SEED] })
  const r = sendGift({
    store,
    fromDog: A,
    toDog: SEED,
    giftName: '毛线',
    idempotencyKey: 'gift-seed',
    now: T0,
  })
  assert.equal(store.exchanges.length, 1)
  assert.deepEqual(keysOf(r.exchange.payload), [
    'giftName',
    'imagePath',
    'kind',
    'note',
    'sourceFindId',
    'sourceMode',
  ])
  // 断言「没有」要具体：不是「看着像」，是这三个键一个都不在。
  for (const k of ['message', 'reply', 'fromOwnerOf', 'ownerWords']) {
    assert.equal(k in r.exchange.payload, false, `种子狗收到的 payload 里不该有 ${k}`)
  }
})

check('A5 收件狗已有 3 次出行 → deliver_after_trip_seq = 4（跨一趟，不是立即到）', () => {
  const store = mockStore({ seqs: { [A]: 0, [B]: 3 } })
  const r = sendGift({
    store,
    fromDog: A,
    toDog: B,
    giftName: '毛线',
    idempotencyKey: 'gift-seq4',
    now: T0,
  })
  assert.equal(r.deliverAfterTripSeq, 4)
})

check('A6 收件狗从没出过门 → 第一次出门就能收到（=1）', () => {
  const store = mockStore({ seqs: { [A]: 5 } })
  const r = sendGift({ store, fromDog: A, toDog: B, giftName: '毛线', idempotencyKey: 'gift-0', now: T0 })
  assert.equal(r.deliverAfterTripSeq, 1)
})

check("A7 自己寄给自己 → SELF_EXCHANGE（rules.ts 判，gift 不重写）", () => {
  expectCode('', () => {
    sendGift({ store: mockStore(), fromDog: A, toDog: A, giftName: '毛线', idempotencyKey: 'k', now: T0 })
  }, 'SELF_EXCHANGE')
})

check('A8 捎话超长（61 字）→ TOO_LONG', () => {
  expectCode('', () => {
    sendCoOwnerMessage({
      store: mockStore(),
      fromDog: A,
      toDog: B,
      message: '啊'.repeat(61),
      idempotencyKey: 'msg-long',
      now: T0,
    })
  }, 'TOO_LONG')
})

check('A9 被拉黑的一对 → BLOCKED_RELATION', () => {
  expectCode('', () => {
    sendGift({
      store: mockStore({ blocked: [[A, B]] }),
      fromDog: A,
      toDog: B,
      giftName: '毛线',
      idempotencyKey: 'gift-blocked',
      now: T0,
    })
  }, 'BLOCKED_RELATION')
})

check('A10 note / imagePath / 来源都不传 → 键仍在，值为 null', () => {
  const store = mockStore()
  const r = sendGift({ store, fromDog: A, toDog: B, giftName: '毛线', idempotencyKey: 'gift-null', now: T0 })
  assert.deepEqual(keysOf(r.exchange.payload), [
    'giftName',
    'imagePath',
    'kind',
    'note',
    'sourceFindId',
    'sourceMode',
  ])
  assert.equal(r.exchange.payload.note, null)
  assert.equal(r.exchange.payload.imagePath, null)
  // K v4：没有来源是合法的，但必须显式写成 null —— 不许省略键，也不许编个 ID
  assert.equal(r.exchange.payload.sourceFindId, null)
  assert.equal(r.exchange.payload.sourceMode, null)
})

check('A11 sourceFindId 指向寄件狗自己的 find → 落库，mode 取库里的值', () => {
  const store = mockStore({
    finds: [{ id: 'find_001', dogId: A, sourceMode: 'live' }],
  })
  const r = sendGift({
    store,
    fromDog: A,
    toDog: B,
    giftName: '毛线',
    sourceFindId: 'find_001',
    idempotencyKey: 'gift-src',
    now: T0,
  })
  // heldBack 保留但恒空 —— 来源现在真落库了，没有东西被扣下
  assert.deepEqual(r.heldBack, [])
  assert.equal(r.exchange.payload.sourceFindId, 'find_001')
  // 调用方没传 mode，由库派生
  assert.equal(r.exchange.payload.sourceMode, 'live')
})

check('A11b 没有真实 find 的 id → 拒，不许凭空造出处', () => {
  expectCode('', () => {
    sendGift({
      store: mockStore(),
      fromDog: A,
      toDog: B,
      giftName: '毛线',
      sourceFindId: 'find_does_not_exist',
      idempotencyKey: 'gift-src-bad',
      now: T0,
    })
  }, 'PROVENANCE_MISMATCH')
})

check('A11c 来源属于别的狗 → 拒（借别人的发现当自己的出处）', () => {
  expectCode('', () => {
    sendGift({
      store: mockStore({ finds: [{ id: 'find_b_1', dogId: B, sourceMode: 'cache' }] }),
      fromDog: A,
      toDog: B,
      giftName: '毛线',
      sourceFindId: 'find_b_1',
      idempotencyKey: 'gift-src-other',
      now: T0,
    })
  }, 'PROVENANCE_MISMATCH')
})

check('A11d 调用方声称的 mode 与库里不符 → 拒，不静默纠正', () => {
  expectCode('', () => {
    sendGift({
      store: mockStore({ finds: [{ id: 'find_a_1', dogId: A, sourceMode: 'cache' }] }),
      fromDog: A,
      toDog: B,
      giftName: '毛线',
      sourceFindId: 'find_a_1',
      sourceMode: 'live', // 库里是 cache，客户端想标成 live
      idempotencyKey: 'gift-src-mode',
      now: T0,
    })
  }, 'PROVENANCE_MISMATCH')
})

check('A11e 来源是 scene（库里 source_mode 为 null）→ 显式传 null 也通过，不升格成 live', () => {
  const store = mockStore({ finds: [{ id: 'find_scene_1', dogId: A, sourceMode: null }] })
  const r = sendGift({
    store,
    fromDog: A,
    toDog: B,
    giftName: '一颗螺帽',
    sourceFindId: 'find_scene_1',
    // 明确声明「没有档位」—— 库里也是 null，两边对得上
    sourceMode: null,
    imagePath: '/assets/gen/nut.webp',
    idempotencyKey: 'gift-scene',
    now: T0,
  })
  assert.equal(r.exchange.payload.sourceFindId, 'find_scene_1')
  assert.equal(r.exchange.payload.sourceMode, null)
})

check('A11g 显式 sourceMode=null 但库里有档位 → 拒（null 是明确声明，不是「没说」）', () => {
  // c 11-20 晚的边界：只有 undefined 算未声明。传 null 等于声明「这条没有档位」，
  // 库里有档位就是矛盾 —— 放行的话，调用方可以靠「说不清」绕过档位核对。
  expectCode('', () => {
    sendGift({
      store: mockStore({ finds: [{ id: 'find_a_1', dogId: A, sourceMode: 'live' }] }),
      fromDog: A,
      toDog: B,
      giftName: '毛线',
      sourceFindId: 'find_a_1',
      sourceMode: null,
      idempotencyKey: 'gift-src-null-lie',
      now: T0,
    })
  }, 'PROVENANCE_MISMATCH')
})

check('A11h 不传 sourceMode（undefined）= 未声明 → 由库派生，不算不一致', () => {
  const store = mockStore({ finds: [{ id: 'find_a_2', dogId: A, sourceMode: 'fixture' }] })
  const r = sendGift({
    store,
    fromDog: A,
    toDog: B,
    giftName: '毛线',
    sourceFindId: 'find_a_2',
    idempotencyKey: 'gift-src-undefined',
    now: T0,
  })
  assert.equal(r.exchange.payload.sourceMode, 'fixture')
})

check('A11f 捎话带来源字段 → 拒（K v4：捎话不挂来源）', () => {
  expectCode('', () => {
    sendCoOwnerMessage({
      store: mockStore(),
      fromDog: A,
      toDog: B,
      message: '桂花开了',
      sourceFindId: 'find_001',
      idempotencyKey: 'msg-src',
      now: T0,
    } as never)
  }, 'UNKNOWN_KEY')
})

check('A12 fromOwnerOf 与 fromDog 不一致 → OWNER_MISMATCH', () => {
  expectCode('', () => {
    sendCoOwnerMessage({
      store: mockStore(),
      fromDog: A,
      toDog: B,
      message: '桂花开了',
      fromOwnerOf: '老王',
      idempotencyKey: 'msg-owner',
      now: T0,
    })
  }, 'OWNER_MISMATCH')
})

check('A13 让种子狗替主人捎话 → SEED_OWNER_SPEAKS', () => {
  expectCode('', () => {
    sendCoOwnerMessage({
      store: mockStore({ samples: [SEED] }),
      fromDog: SEED,
      toDog: A,
      message: '我也想你',
      idempotencyKey: 'msg-seed',
      now: T0,
    })
  }, 'SEED_OWNER_SPEAKS')
})

check('A14 没给 id 也没给 idempotencyKey → MISSING_IDEMPOTENCY_KEY', () => {
  expectCode('', () => {
    sendGift({ store: mockStore(), fromDog: A, toDog: B, giftName: '毛线', now: T0 })
  }, 'MISSING_IDEMPOTENCY_KEY')
})

check("A15 往 payload 塞 chatText（主人聊天原文）→ UNKNOWN_KEY（白名单结构，不靠关键词猜）", () => {
  expectCode('', () => {
    sendGift({
      store: mockStore(),
      fromDog: A,
      toDog: B,
      giftName: '毛线',
      idempotencyKey: 'gift-chat',
      now: T0,
      // 故意用 any 绕过类型：真实漏洞就是这么进来的
      ...({ chatText: '主人昨天说……' } as unknown as object),
    })
  }, 'UNKNOWN_KEY')
})

check('A16 显式 id 优先于幂等键派生', () => {
  const store = mockStore()
  const r = sendGift({ store, fromDog: A, toDog: B, giftName: '毛线', id: 'ex_manual', now: T0 })
  assert.equal(r.id, 'ex_manual')
  assert.equal(store.exchanges[0].id, 'ex_manual')
})

// ===========================================================================
// B · 真库验收
// ===========================================================================

console.log('\nB · 真库验收（createSqliteStore + contracts/schema.sql）')

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON') // node:sqlite 默认关，必须手动开
  db.exec(SCHEMA)
  return db
}

function insertDog(db: DatabaseSync, id: string, isSample = false): void {
  db.prepare(
    `INSERT INTO dog
       (id, name, session_id, personality_tags, interest_categories,
        assembly, is_sample, blocked_topics, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    null,
    isSample ? 'seed' : 'session_test',
    JSON.stringify(['好奇', '看物', '当下']),
    // 故意给一只狗兴趣为 NULL：c 11/19 第 3 条说「不因为兴趣为空拒掉交换」，
    // 这里把 NULL 摆进来，证明 gift 这条路上没有任何地方会因为它报错。
    null,
    JSON.stringify({ cloth: 'sweater', hat: null, glasses: 'round', face: 'waiting' }),
    isSample ? 1 : 0,
    '[]',
    T0,
  )
}

function insertTrip(db: DatabaseSync, id: string, dogId: string, seq: number): void {
  db.prepare(
    `INSERT INTO trip (id, dog_id, seq, status, trigger, created_at, started_at, ended_at)
     VALUES (?, ?, ?, 'running', 'auto', ?, ?, NULL)`,
  ).run(id, dogId, seq, T0, T0)
}

/**
 * 插一条 find。**注意 `find` 表没有 dog_id** —— 归属由 `trip_id` 决定，
 * 这正是 K v4 要求 `JOIN trip` 的原因。
 *
 * schema 的 CHECK 也在这里体现：zhihu 必须有 source_url + source_mode，
 * scene / moment 的 source_mode 必须为 NULL。
 */
function insertFind(
  db: DatabaseSync,
  opts: { id: string; tripId: string; kind: 'zhihu' | 'scene' | 'moment'; sourceMode: 'live' | 'cache' | 'fixture' | null; sourceUrl?: string },
): void {
  db.prepare(
    `INSERT INTO find (id, trip_id, kind, title, excerpt, source_url, source_mode, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.tripId,
    opts.kind,
    `发现 ${opts.id}`,
    opts.sourceUrl ?? null,
    opts.sourceMode,
    T0,
  )
}

function blockPair(db: DatabaseSync, a: string, b: string): void {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  db.prepare(
    `INSERT INTO relation (id, dog_a, dog_b, first_met_at, last_met_at, met_count, is_blocked, blocked_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
  ).run(`rel_${lo}__${hi}`, lo, hi, T0, T0, T0)
}

function exchangeRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM exchange ORDER BY created_at').all() as Array<Record<string, unknown>>
}

function seedDb(): DatabaseSync {
  const db = freshDb()
  insertDog(db, A)
  insertDog(db, B)
  insertDog(db, SEED, true)
  return db
}

check('B1 正常礼物落真库 → 1 行，deliver_after_trip_seq=1，三个状态列全 NULL', () => {
  const db = seedDb()
  const r = sendGift({
    store: createSqliteStore(db),
    fromDog: A,
    toDog: B,
    giftName: '一小卷灰蓝色的毛线',
    note: '天气要冷了',
    idempotencyKey: 'gift-real-1',
    now: T0,
  })
  const rows = exchangeRows(db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, r.id)
  assert.equal(rows[0].deliver_after_trip_seq, 1)
  assert.equal(rows[0].delivered_at, null)
  assert.equal(rows[0].replied_at, null)
  assert.equal(rows[0].read_at, null)
})

check('B2 幂等：同 key 写两次 → 库里仍 1 行，第二次 duplicate', () => {
  const db = seedDb()
  const store = createSqliteStore(db)
  const args = { store, fromDog: A, toDog: B, giftName: '毛线', idempotencyKey: 'gift-real-dup', now: T0 }
  const first = sendGift(args)
  const second = sendGift(args)
  assert.equal(exchangeRows(db).length, 1)
  assert.equal(first.inserted, true)
  assert.equal(second.inserted, false)
})

check('B3 收件狗已有 3 趟 → 4，且与 meet.nextDeliverSeq 算出来的一致（同一个式子）', () => {
  const db = seedDb()
  insertTrip(db, 'trip_b1', B, 1)
  insertTrip(db, 'trip_b2', B, 2)
  insertTrip(db, 'trip_b3', B, 3)
  const store = createSqliteStore(db)
  const r = sendGift({ store, fromDog: A, toDog: B, giftName: '毛线', idempotencyKey: 'gift-real-4', now: T0 })

  assert.equal(r.deliverAfterTripSeq, 4)
  // 交叉验证：gift 的 deliverAfterTripSeqFor 与 meet 的 nextDeliverSeq 必须落到同一个数。
  // 11-20 适配器化后两条路都只认 store，所以传的是同一个 store 实例。
  assert.equal(deliverAfterTripSeqFor(store, B), nextDeliverSeq(store, B))
  assert.equal(exchangeRows(db)[0].deliver_after_trip_seq, 4)
})

check('B4 捎话落真库 → payload JSON 键集合严格等于三个键，message 原样', () => {
  const db = seedDb()
  sendCoOwnerMessage({
    store: createSqliteStore(db),
    fromDog: A,
    toDog: B,
    message: '楼下的桂花开了',
    idempotencyKey: 'msg-real-1',
    now: T0,
  })
  const rows = exchangeRows(db)
  assert.equal(rows.length, 1)
  const payload = JSON.parse(String(rows[0].payload)) as Record<string, unknown>
  assert.deepEqual(keysOf(payload), ['fromOwnerOf', 'kind', 'message'])
  assert.equal(payload.message, '楼下的桂花开了')
  assert.equal(payload.fromOwnerOf, A)
})

check('B5 拉黑的一对 → BLOCKED_RELATION（真库 relation 查得到）', () => {
  const db = seedDb()
  blockPair(db, A, B)
  expectCode('', () => {
    sendGift({
      store: createSqliteStore(db),
      fromDog: A,
      toDog: B,
      giftName: '毛线',
      idempotencyKey: 'gift-real-blocked',
      now: T0,
    })
  }, 'BLOCKED_RELATION')
  assert.equal(exchangeRows(db).length, 0)
})

check('B6 真库里的种子狗（is_sample=1）不能替主人捎话 → SEED_OWNER_SPEAKS', () => {
  const db = seedDb()
  expectCode('', () => {
    sendCoOwnerMessage({
      store: createSqliteStore(db),
      fromDog: SEED,
      toDog: A,
      message: '我也想你',
      idempotencyKey: 'msg-real-seed',
      now: T0,
    })
  }, 'SEED_OWNER_SPEAKS')
  assert.equal(exchangeRows(db).length, 0)
})

check('B7 种子狗收礼正常（拦的只是「替主人说话」，不是「收到东西」）', () => {
  const db = seedDb()
  const r = sendGift({
    store: createSqliteStore(db),
    fromDog: A,
    toDog: SEED,
    giftName: '毛线',
    idempotencyKey: 'gift-real-seed',
    now: T0,
  })
  assert.equal(r.inserted, true)
  const payload = JSON.parse(String(exchangeRows(db)[0].payload)) as Record<string, unknown>
  assert.deepEqual(keysOf(payload), [
    'giftName',
    'imagePath',
    'kind',
    'note',
    'sourceFindId',
    'sourceMode',
  ])
})

check('B8 狗不存在 → STORE_REJECTED（外键兜底，不静默写进去）', () => {
  const db = seedDb()
  expectCode('', () => {
    sendGift({
      store: createSqliteStore(db),
      fromDog: A,
      toDog: 'dog_ghost',
      giftName: '毛线',
      idempotencyKey: 'gift-real-ghost',
      now: T0,
    })
  }, 'STORE_REJECTED')
})

check('B9 真库：来源 find 属于寄件狗 → 落库，mode 取表里的值（不是入参）', () => {
  const db = seedDb()
  insertTrip(db, 'trip_a_1', A, 1)
  insertFind(db, {
    id: 'find_a_zhihu',
    tripId: 'trip_a_1',
    kind: 'zhihu',
    sourceMode: 'cache',
    sourceUrl: 'https://www.zhihu.com/question/000000000/answer/000000000',
  })
  const r = sendGift({
    store: createSqliteStore(db),
    fromDog: A,
    toDog: B,
    giftName: '毛线',
    sourceFindId: 'find_a_zhihu',
    idempotencyKey: 'gift-real-src',
    now: T0,
  })
  const payload = JSON.parse(String(exchangeRows(db)[0].payload)) as Record<string, unknown>
  assert.equal(payload.sourceFindId, 'find_a_zhihu')
  // 表里是 cache，落库就是 cache —— 这个值只可能来自 find 表
  assert.equal(payload.sourceMode, 'cache')
  assert.equal(r.exchange.payload.sourceMode, 'cache')
  // K v4：不新增 exchange 列，来源只活在 payload JSON 里
  const cols = (
    db.prepare('PRAGMA table_info(exchange)').all() as Array<{ name: string }>
  ).map((c) => c.name)
  assert.equal(cols.includes('source_find_id'), false)
  assert.equal(cols.includes('source_mode'), false)
})

check('B9b 真库：来源 find 挂在别的狗那次出行上 → 拒，一行都不落', () => {
  const db = seedDb()
  insertTrip(db, 'trip_b_1', B, 1)
  insertFind(db, {
    id: 'find_b_zhihu',
    tripId: 'trip_b_1',
    kind: 'zhihu',
    sourceMode: 'live',
    sourceUrl: 'https://www.zhihu.com/question/000000000/answer/000000000',
  })
  expectCode('', () => {
    sendGift({
      store: createSqliteStore(db),
      fromDog: A,
      toDog: B,
      giftName: '毛线',
      sourceFindId: 'find_b_zhihu',
      idempotencyKey: 'gift-real-cross',
      now: T0,
    })
  }, 'PROVENANCE_MISMATCH')
  assert.equal(exchangeRows(db).length, 0)
})

check('B9c 真库：来源是 scene（source_mode 为 NULL）→ payload 的 mode 也是 null', () => {
  const db = seedDb()
  insertTrip(db, 'trip_a_1', A, 1)
  insertFind(db, { id: 'find_a_scene', tripId: 'trip_a_1', kind: 'scene', sourceMode: null })
  sendGift({
    store: createSqliteStore(db),
    fromDog: A,
    toDog: B,
    giftName: '一颗螺帽',
    imagePath: '/assets/gen/nut.webp',
    sourceFindId: 'find_a_scene',
    idempotencyKey: 'gift-real-scene',
    now: T0,
  })
  const payload = JSON.parse(String(exchangeRows(db)[0].payload)) as Record<string, unknown>
  assert.equal(payload.sourceFindId, 'find_a_scene')
  // 带了 imagePath 也不能把档位升成 live —— 契约原话「不因有图片或 URL 改成 live」
  assert.equal(payload.sourceMode, null)
})

check('B9d 真库：客户端自称 live 但库里是 cache → 拒', () => {
  const db = seedDb()
  insertTrip(db, 'trip_a_1', A, 1)
  insertFind(db, {
    id: 'find_a_zhihu',
    tripId: 'trip_a_1',
    kind: 'zhihu',
    sourceMode: 'cache',
    sourceUrl: 'https://www.zhihu.com/question/000000000/answer/000000000',
  })
  expectCode('', () => {
    sendGift({
      store: createSqliteStore(db),
      fromDog: A,
      toDog: B,
      giftName: '毛线',
      sourceFindId: 'find_a_zhihu',
      sourceMode: 'live',
      idempotencyKey: 'gift-real-lie',
      now: T0,
    })
  }, 'PROVENANCE_MISMATCH')
  assert.equal(exchangeRows(db).length, 0)
})

check('B9d2 真库：显式 sourceMode=null 但库里有档位 → 拒，一行都不落', () => {
  const db = seedDb()
  insertTrip(db, 'trip_a_1', A, 1)
  insertFind(db, {
    id: 'find_a_zhihu',
    tripId: 'trip_a_1',
    kind: 'zhihu',
    sourceMode: 'live',
    sourceUrl: 'https://www.zhihu.com/question/000000000/answer/000000000',
  })
  expectCode('', () => {
    sendGift({
      store: createSqliteStore(db),
      fromDog: A,
      toDog: B,
      giftName: '毛线',
      sourceFindId: 'find_a_zhihu',
      sourceMode: null,
      idempotencyKey: 'gift-real-null-mode',
      now: T0,
    })
  }, 'PROVENANCE_MISMATCH')
  assert.equal(exchangeRows(db).length, 0)
})

check('B9e 真库：重放时来源字段也返回库里那份，不返回本次入参', () => {
  const db = seedDb()
  insertTrip(db, 'trip_a_1', A, 1)
  insertFind(db, {
    id: 'find_a_zhihu',
    tripId: 'trip_a_1',
    kind: 'zhihu',
    sourceMode: 'fixture',
    sourceUrl: 'https://www.zhihu.com/question/000000000/answer/000000000',
  })
  const store = createSqliteStore(db)
  const base = { store, fromDog: A, toDog: B, giftName: '毛线', idempotencyKey: 'gift-real-src-replay', now: T0 }
  const first = sendGift({ ...base, sourceFindId: 'find_a_zhihu' })
  // 第二次换一个不存在的来源：幂等键相同，应直接返回库里那条，不会去查新来源
  const second = sendGift({ ...base, sourceFindId: null })
  assert.equal(first.inserted, true)
  assert.equal(second.inserted, false)
  assert.equal(second.exchange.payload.sourceFindId, 'find_a_zhihu')
  assert.equal(second.exchange.payload.sourceMode, 'fixture')
  assert.equal(exchangeRows(db).length, 1)
})

check('B10 真库重放 → 返回库里那一行（value 取 DB 的 JSON），趟次也是第一次的', () => {
  const db = seedDb()
  const store = createSqliteStore(db)
  const first = sendGift({
    store,
    fromDog: A,
    toDog: B,
    giftName: '毛线',
    note: '天气要冷了',
    idempotencyKey: 'gift-real-replay',
    now: T0,
  })
  // 重放前让收件狗多出两趟 —— 若实现重新算趟次，会变成 3；正确的应该是第一次那个 1。
  insertTrip(db, 'trip_b1', B, 1)
  insertTrip(db, 'trip_b2', B, 2)

  const second = sendGift({
    store,
    fromDog: A,
    toDog: B,
    giftName: '茶杯',
    note: '换一句',
    idempotencyKey: 'gift-real-replay',
    now: '2026-11-19T10:00:00Z',
  })

  assert.equal(exchangeRows(db).length, 1)
  assert.equal(second.inserted, false)
  assert.equal(second.exchange.payload.giftName, '毛线')
  assert.equal(second.exchange.payload.note, '天气要冷了')
  assert.equal(second.deliverAfterTripSeq, first.deliverAfterTripSeq)
  assert.equal(second.deliverAfterTripSeq, 1)
})

// ===========================================================================
// C · C8 的事务包法（11-20 晚 c 的要求：一次事务里验寄件权 + 调用 D 的写入）
// ===========================================================================

console.log('\nC · C8 的调用形状（外层事务 + sendGift）')

check('C1 C8 在外层事务里包 sendGift → 不撞 nested BEGIN，礼物照常落一行', () => {
  const db = seedDb()
  const store = createSqliteStore(db)
  // 模拟 C8：在自己的事务里先做权限读（这里用 hasDog 代替），再调 sendGift
  const r = store.transaction(() => {
    assert.equal(store.hasDog(A), true)
    return sendGift({
      store,
      fromDog: A,
      toDog: B,
      giftName: '一小卷灰蓝色的毛线',
      idempotencyKey: 'gift-c8-outer',
      now: T0,
    })
  })
  assert.equal(r.inserted, true)
  assert.equal(exchangeRows(db).length, 1)
  db.close()
})

check('C2 外层事务在 sendGift 之后失败 → 礼物也不留（原子性覆盖到 C8 那一层）', () => {
  const db = seedDb()
  const store = createSqliteStore(db)
  assert.throws(() => {
    store.transaction(() => {
      sendGift({
        store,
        fromDog: A,
        toDog: B,
        giftName: '毛线',
        idempotencyKey: 'gift-c8-rollback',
        now: T0,
      })
      // 模拟 C8 后续步骤失败（比如写自己的日志/事件失败）
      throw new Error('C8 后续步骤失败')
    })
  }, /C8 后续步骤失败/)
  assert.equal(exchangeRows(db).length, 0, '外层失败但礼物留下了 —— 事务没覆盖到调用方那一层')
  db.close()
})

check('C3 sendGift 自己失败时，外层事务仍可用（内层只撤自己）', () => {
  const db = seedDb()
  const store = createSqliteStore(db)
  // 外层先写一条无关礼物，再调一个会失败的 sendGift（来源不存在），外层接住错误
  const r = store.transaction(() => {
    const kept = sendGift({
      store,
      fromDog: A,
      toDog: B,
      giftName: '会留下的',
      idempotencyKey: 'gift-c8-kept',
      now: T0,
    })
    try {
      sendGift({
        store,
        fromDog: A,
        toDog: B,
        giftName: '会被撤掉的',
        sourceFindId: 'find_not_exist',
        idempotencyKey: 'gift-c8-dropped',
        now: T0,
      })
    } catch {
      // 外层接住：内层只撤自己
    }
    return kept
  })
  assert.equal(r.inserted, true)
  const rows = exchangeRows(db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, r.id)
  db.close()
})

// ===========================================================================
// 汇总
// ===========================================================================

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
