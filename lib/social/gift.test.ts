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
import type { ExchangeRow, MemoryStore } from './store.ts'
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
  let got: string | null = null
  try {
    fn()
  } catch (err) {
    const e = err as GiftError
    if (!(err instanceof GiftError)) throw new Error(`期望 GiftError(${code})，实际抛出别的：${(err as Error).message}`)
    got = String(e.code)
    if (got !== code) throw new Error(`期望 ${code}，实际 ${got}：${e.message}`)
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

check('A1 正常礼物 → 1 条，payload 键集合严格等于契约四个键', () => {
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
  assert.deepEqual(keysOf(r.exchange.payload), ['giftName', 'imagePath', 'kind', 'note'])
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

check('A3 同一个 idempotencyKey 写两次 → 库里仍 1 条，第二次 inserted:false', () => {
  const store = mockStore()
  const args = {
    store,
    fromDog: A,
    toDog: B,
    giftName: '毛线',
    idempotencyKey: 'gift-dup',
    now: T0,
  }
  const first = sendGift(args)
  const second = sendGift(args)
  assert.equal(store.exchanges.length, 1)
  assert.equal(first.inserted, true)
  assert.equal(second.inserted, false)
  assert.equal(first.id, second.id)
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
  assert.deepEqual(keysOf(r.exchange.payload), ['giftName', 'imagePath', 'kind', 'note'])
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

check('A10 note / imagePath 不传 → 键仍在，值为 null', () => {
  const store = mockStore()
  const r = sendGift({ store, fromDog: A, toDog: B, giftName: '毛线', idempotencyKey: 'gift-null', now: T0 })
  assert.deepEqual(keysOf(r.exchange.payload), ['giftName', 'imagePath', 'kind', 'note'])
  assert.equal(r.exchange.payload.note, null)
  assert.equal(r.exchange.payload.imagePath, null)
})

check('A11 sourceFindId 传了 → 收下（heldBack 有它）但不写进 payload', () => {
  const store = mockStore()
  const r = sendGift({
    store,
    fromDog: A,
    toDog: B,
    giftName: '毛线',
    sourceFindId: 'find_001',
    idempotencyKey: 'gift-src',
    now: T0,
  })
  assert.deepEqual(r.heldBack, ['sourceFindId'])
  assert.equal('sourceFindId' in r.exchange.payload, false)
  assert.deepEqual(keysOf(r.exchange.payload), ['giftName', 'imagePath', 'kind', 'note'])
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
  // 交叉验证：gift 用 store 算、meet 用 db 算，两条路必须落到同一个数。
  assert.equal(deliverAfterTripSeqFor(store, B), nextDeliverSeq(db, B))
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
  assert.deepEqual(keysOf(payload), ['giftName', 'imagePath', 'kind', 'note'])
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

check('B9 sourceFindId 传了但没落库 —— 真库里也查不到这个键', () => {
  const db = seedDb()
  sendGift({
    store: createSqliteStore(db),
    fromDog: A,
    toDog: B,
    giftName: '毛线',
    sourceFindId: 'find_001',
    idempotencyKey: 'gift-real-src',
    now: T0,
  })
  const raw = String(exchangeRows(db)[0].payload)
  assert.equal(raw.includes('sourceFindId'), false)
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
