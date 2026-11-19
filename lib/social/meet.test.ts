/**
 * meet.ts 的用例。**用真的 `contracts/schema.sql` 建库**，不是手搓表。
 *
 * 跑法：node --experimental-strip-types lib/social/meet.test.ts
 *
 * 为什么必须用真 schema：本文件测的一半是「数据库自己的规则」——
 * `dog_a < dog_b` 的 CHECK、`from_dog <> to_dog` 的 CHECK、装配单触发器、
 * 外键。手搓一份近似表，测过的和真库跑出来的不是一回事。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  meet,
  nextDeliverSeq,
  nowIso,
  orderPair,
  readRelation,
  recordExchange,
  SocialWriteError,
  upsertRelation,
} from './meet.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA = fs.readFileSync(path.resolve(HERE, '../../contracts/schema.sql'), 'utf8')

const T0 = '2026-11-19T08:00:00Z'
const T1 = '2026-11-19T09:30:00Z'

// ===========================================================================
// 夹具
// ===========================================================================

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON') // node:sqlite 默认关，必须手动开
  db.exec(SCHEMA)
  return db
}

function insertDog(db: DatabaseSync, id: string, opts: { isSample?: boolean } = {}): void {
  db.prepare(
    `INSERT INTO dog
       (id, name, session_id, personality_tags, interest_categories,
        assembly, is_sample, blocked_topics, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    null,
    opts.isSample ? 'seed' : 'session_test',
    JSON.stringify(['好奇', '看物', '当下']),
    JSON.stringify(['自然风景', '冷知识']),
    JSON.stringify({ cloth: 'sweater', hat: null, glasses: 'round', face: 'waiting' }),
    opts.isSample ? 1 : 0,
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

function one(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as { n?: number; c?: number } | undefined
  return Number(row?.n ?? row?.c ?? 0)
}

function countRows(db: DatabaseSync, table: string): number {
  return one(db, `SELECT COUNT(*) AS n FROM ${table}`)
}

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

/**
 * 期望被拒。
 * - 给了 name：自己计数并打印。
 * - name 传 `''`：只断言不计数（说明外层已经有一个 `check` 在管这条），失败时抛出，
 *   由外层 `check` 报成一条。这样输出里不会出现空名字的重复行。
 */
function expectCode(name: string, fn: () => void, code: string): void {
  let got: string | null = null
  try {
    fn()
  } catch (err) {
    got = (err as SocialWriteError).code ?? 'NON_SOCIAL_ERROR'
  }

  if (got === code) {
    if (name) {
      pass++
      console.log(`  ✅ ${name} → ${got}`)
    }
    return
  }

  const msg = got === null ? `期望被拒（${code}），实际通过` : `期望 ${code}，实际 ${got}`
  if (name) {
    fail++
    failures.push(`${name} → ${msg}`)
    console.log(`  ❌ ${name} → ${msg}`)
    return
  }
  throw new Error(msg)
}

// ===========================================================================
// 一、nextDeliverSeq
// ===========================================================================

console.log('\n【nextDeliverSeq】收件狗当前 seq + 1')

check('没有出行记录 → 1（第一次出门就能收到）', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  assert.equal(nextDeliverSeq(db, 'dog_a'), 1)
  db.close()
})

check('已有 seq 1、2 → 3', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  insertTrip(db, 'trip_1', 'dog_a', 1)
  insertTrip(db, 'trip_2', 'dog_a', 2)
  assert.equal(nextDeliverSeq(db, 'dog_a'), 3)
  db.close()
})

check('两只狗的 seq 互不影响', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  insertDog(db, 'dog_b')
  insertTrip(db, 'trip_1', 'dog_a', 1)
  insertTrip(db, 'trip_b1', 'dog_b', 1)
  insertTrip(db, 'trip_b2', 'dog_b', 2)
  insertTrip(db, 'trip_b3', 'dog_b', 3)
  assert.equal(nextDeliverSeq(db, 'dog_a'), 2)
  assert.equal(nextDeliverSeq(db, 'dog_b'), 4)
  db.close()
})

// ===========================================================================
// 二、upsertRelation
// ===========================================================================

console.log('\n【upsertRelation】归对、首次时间只写一次、次数每遇 +1')

check('首次相遇 → met_count 1，created=true', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  insertDog(db, 'dog_b')
  const r = upsertRelation(db, 'dog_a', 'dog_b', T0)
  assert.equal(r.metCount, 1)
  assert.equal(r.created, true)
  assert.equal(r.firstMetAt, T0)
  assert.equal(countRows(db, 'relation'), 1)
  db.close()
})

check('反序输入自动归对（dog_b 传前面），不报错', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  insertDog(db, 'dog_b')
  const r = upsertRelation(db, 'dog_b', 'dog_a', T0)
  assert.ok(r.dogA < r.dogB, `dog_a 应小于 dog_b，实际 ${r.dogA} / ${r.dogB}`)
  assert.equal(r.dogA, 'dog_a')
  assert.equal(r.dogB, 'dog_b')
  db.close()
})

check('第二次相遇 → met_count 2，first_met_at 不变，last_met_at 变', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  insertDog(db, 'dog_b')
  upsertRelation(db, 'dog_a', 'dog_b', T0)
  const r2 = upsertRelation(db, 'dog_a', 'dog_b', T1)
  assert.equal(r2.metCount, 2)
  assert.equal(r2.created, false)
  assert.equal(r2.firstMetAt, T0, 'first_met_at 被改写了')
  assert.equal(r2.lastMetAt, T1)
  assert.equal(countRows(db, 'relation'), 1, '同一对不该存成两条')
  db.close()
})

check('自己和自己建立关系 → SELF_MEET', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  expectCode('', () => upsertRelation(db, 'dog_a', 'dog_a', T0), 'SELF_MEET')
  assert.equal(countRows(db, 'relation'), 0)
  db.close()
})

check('upsert 不动 is_blocked（拉黑不该被一次相遇解除）', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  insertDog(db, 'dog_b')
  upsertRelation(db, 'dog_a', 'dog_b', T0)
  db.prepare('UPDATE relation SET is_blocked = 1, blocked_at = ? WHERE dog_a = ?').run(T1, 'dog_a')
  upsertRelation(db, 'dog_a', 'dog_b', T1)
  const row = db.prepare('SELECT is_blocked FROM relation').get() as { is_blocked: number }
  assert.equal(Number(row.is_blocked), 1, 'is_blocked 被相遇改回 0 了')
  db.close()
})

// ===========================================================================
// 三、recordExchange
// ===========================================================================

console.log('\n【recordExchange】校验 → 算趟次 → 幂等写入')

check('greeting 正常写入，趟次 = 收件狗当前 seq + 1', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  insertDog(db, 'dog_b')
  insertTrip(db, 'trip_b1', 'dog_b', 1)

  const r = recordExchange(
    db,
    {
      fromDog: 'dog_a',
      toDog: 'dog_b',
      kind: 'greeting',
      payload: { kind: 'greeting', line: '这边下了两天雨，你那边呢', weather: '雨' },
    },
    { idempotencyKey: 'meet-1:out', createdAt: T0 },
  )

  assert.equal(r.inserted, true)
  assert.equal(r.deliverAfterTripSeq, 2)
  assert.equal(countRows(db, 'exchange'), 1)

  const row = db.prepare('SELECT * FROM exchange').get() as Record<string, unknown>
  assert.equal(row.delivered_at, null, 'd 不许写 delivered_at')
  assert.equal(row.replied_at, null)
  assert.equal(row.read_at, null)
  db.close()
})

check('同一幂等键写两次 → 库里仍 1 条，第二次 inserted=false', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  insertDog(db, 'dog_b')
  const draft = {
    fromDog: 'dog_a',
    toDog: 'dog_b',
    kind: 'gift' as const,
    payload: { kind: 'gift', giftName: '一小卷灰蓝色的毛线', note: '天气要冷了', imagePath: null },
  }
  const first = recordExchange(db, draft, { idempotencyKey: 'gift-1', createdAt: T0 })
  const second = recordExchange(db, draft, { idempotencyKey: 'gift-1', createdAt: T0 })
  assert.equal(first.inserted, true)
  assert.equal(second.inserted, false)
  assert.equal(first.id, second.id)
  assert.equal(countRows(db, 'exchange'), 1)
  db.close()
})

check('payload 带未批字段 sourceFindId → UNKNOWN_KEY，写不进去', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  insertDog(db, 'dog_b')
  expectCode(
    '',
    () =>
      recordExchange(
        db,
        {
          fromDog: 'dog_a',
          toDog: 'dog_b',
          kind: 'find',
          payload: {
            kind: 'find',
            findTitle: '修鞋摊旁边的搪瓷缸',
            findExcerpt: '缸沿上磕了两个口。',
            sourceUrl: null,
            sourceFindId: 'ex_gift',
          },
        },
        { idempotencyKey: 'k' },
      ),
    'UNKNOWN_KEY',
  )
  assert.equal(countRows(db, 'exchange'), 0)
  db.close()
})

check('不给 id 也不给幂等键 → MISSING_IDEMPOTENCY_KEY', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  insertDog(db, 'dog_b')
  expectCode(
    '',
    () =>
      recordExchange(db, {
        fromDog: 'dog_a',
        toDog: 'dog_b',
        kind: 'greeting',
        payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' },
      }),
    'MISSING_IDEMPOTENCY_KEY',
  )
  db.close()
})

check('越权字段进草稿（deliveredAt）→ FORBIDDEN_KEY', () => {
  const db = freshDb()
  insertDog(db, 'dog_a')
  insertDog(db, 'dog_b')
  expectCode(
    '',
    () =>
      recordExchange(
        db,
        {
          fromDog: 'dog_a',
          toDog: 'dog_b',
          kind: 'greeting',
          payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' },
          deliveredAt: T1,
        } as never,
        { idempotencyKey: 'k' },
      ),
    'FORBIDDEN_KEY',
  )
  db.close()
})

// ===========================================================================
// 四、meet —— 关系 + 交换，一个事务
// ===========================================================================

console.log('\n【meet】一次相遇：关系 1 条 + 交换 1 条')

function seedTwoDogs(): DatabaseSync {
  const db = freshDb()
  insertDog(db, 'dog_owner')
  insertDog(db, 'dog_seed_07', { isSample: true })
  insertTrip(db, 'trip_owner_1', 'dog_owner', 1)
  insertTrip(db, 'trip_seed_1', 'dog_seed_07', 1)
  return db
}

check('正常相遇 → relation 1 条 + exchange 1 条，趟次对', () => {
  const db = seedTwoDogs()
  const r = meet({
    db,
    dogId: 'dog_owner',
    otherDogId: 'dog_seed_07',
    tripId: 'trip_owner_1',
    now: T0,
    outgoing: { kind: 'greeting', payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' } },
  })
  assert.equal(r.replayed, false)
  assert.equal(r.relation.metCount, 1)
  assert.equal(r.exchanges.length, 1)
  assert.equal(countRows(db, 'relation'), 1)
  assert.equal(countRows(db, 'exchange'), 1)
  // 收件狗 dog_seed_07 已有 seq 1 → 送达趟次应为 2
  assert.equal(r.exchanges[0].deliverAfterTripSeq, 2)
  db.close()
})

check('同一 tripId 再调一次 → 重放，met_count 仍 1、exchange 仍 1 条', () => {
  const db = seedTwoDogs()
  const args = {
    db,
    dogId: 'dog_owner',
    otherDogId: 'dog_seed_07',
    tripId: 'trip_owner_1',
    outgoing: { kind: 'greeting' as const, payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' } },
  }
  meet({ ...args, now: T0 })
  const second = meet({ ...args, now: T1 })
  assert.equal(second.replayed, true)
  assert.equal(countRows(db, 'exchange'), 1, '重放不该插第二条')
  const rel = readRelation(db, 'dog_owner', 'dog_seed_07')
  assert.equal(rel?.metCount, 1, '重放不该把 met_count 加成 2')
  assert.equal(rel?.firstMetAt, T0)
  db.close()
})

check('换一次出行再遇 → met_count 2，first_met_at 不变', () => {
  const db = seedTwoDogs()
  meet({
    db,
    dogId: 'dog_owner',
    otherDogId: 'dog_seed_07',
    tripId: 'trip_owner_1',
    now: T0,
    outgoing: { kind: 'greeting', payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' } },
  })
  const r2 = meet({
    db,
    dogId: 'dog_owner',
    otherDogId: 'dog_seed_07',
    tripId: 'trip_owner_2',
    now: T1,
    outgoing: { kind: 'find', payload: { kind: 'find', findTitle: '搪瓷缸', findExcerpt: '茶还是满的。', sourceUrl: null } },
  })
  assert.equal(r2.relation.metCount, 2)
  assert.equal(r2.relation.firstMetAt, T0)
  assert.equal(r2.relation.lastMetAt, T1)
  assert.equal(countRows(db, 'exchange'), 2)
  db.close()
})

check('双向交换：outgoing + incoming 各一条', () => {
  const db = seedTwoDogs()
  const r = meet({
    db,
    dogId: 'dog_owner',
    otherDogId: 'dog_seed_07',
    tripId: 'trip_owner_1',
    now: T0,
    outgoing: { kind: 'greeting', payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' } },
    incoming: { kind: 'find', payload: { kind: 'find', findTitle: '搪瓷缸', findExcerpt: '茶还是满的。', sourceUrl: null } },
  })
  assert.equal(r.exchanges.length, 2)
  assert.equal(countRows(db, 'exchange'), 2)
  const dirs = db
    .prepare('SELECT from_dog, to_dog FROM exchange ORDER BY from_dog')
    .all() as Array<{ from_dog: string; to_dog: string }>
  assert.deepEqual(
    dirs.map((d) => `${d.from_dog}->${d.to_dog}`),
    ['dog_owner->dog_seed_07', 'dog_seed_07->dog_owner'],
  )
  db.close()
})

check('被拉黑的一对 → BLOCKED_RELATION，什么都不写', () => {
  const db = seedTwoDogs()
  upsertRelation(db, 'dog_owner', 'dog_seed_07', T0)
  db.prepare('UPDATE relation SET is_blocked = 1, blocked_at = ?').run(T0)
  const before = countRows(db, 'exchange')

  expectCode(
    '',
    () =>
      meet({
        db,
        dogId: 'dog_seed_07',
        otherDogId: 'dog_owner',
        tripId: 'trip_seed_1',
        now: T1,
        outgoing: { kind: 'greeting', payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' } },
      }),
    'BLOCKED_RELATION',
  )
  assert.equal(countRows(db, 'exchange'), before, '拉黑后不该写交换')
  const rel = readRelation(db, 'dog_owner', 'dog_seed_07')
  assert.equal(rel?.metCount, 1, '拉黑不该被当成一次相遇')
  db.close()
})

check('自己遇自己 → SELF_MEET', () => {
  const db = seedTwoDogs()
  expectCode(
    '',
    () =>
      meet({
        db,
        dogId: 'dog_owner',
        otherDogId: 'dog_owner',
        tripId: 'trip_owner_1',
        now: T0,
      }),
    'SELF_MEET',
  )
  db.close()
})

check('不存在的狗 → DOG_NOT_FOUND', () => {
  const db = seedTwoDogs()
  expectCode(
    '',
    () =>
      meet({
        db,
        dogId: 'dog_owner',
        otherDogId: 'dog_nobody',
        tripId: 'trip_owner_1',
        now: T0,
      }),
    'DOG_NOT_FOUND',
  )
  db.close()
})

check('相遇带 gift → KIND_NOT_IN_MEET（礼物归 gift.ts）', () => {
  const db = seedTwoDogs()
  expectCode(
    '',
    () =>
      meet({
        db,
        dogId: 'dog_owner',
        otherDogId: 'dog_seed_07',
        tripId: 'trip_owner_1',
        now: T0,
        outgoing: {
          kind: 'gift' as never,
          payload: { kind: 'gift', giftName: '毛线', note: null, imagePath: null },
        },
      }),
    'KIND_NOT_IN_MEET',
  )
  db.close()
})

check('事务性：incoming 非法 → relation 也不留（全回滚）', () => {
  const db = seedTwoDogs()
  expectCode(
    '',
    () =>
      meet({
        db,
        dogId: 'dog_owner',
        otherDogId: 'dog_seed_07',
        tripId: 'trip_owner_1',
        now: T0,
        outgoing: { kind: 'greeting', payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' } },
        // sourceFindId 未批，会被 UNKNOWN_KEY 拒
        incoming: {
          kind: 'find',
          payload: {
            kind: 'find',
            findTitle: '搪瓷缸',
            findExcerpt: '茶还是满的。',
            sourceUrl: null,
            sourceFindId: 'x',
          },
        },
      }),
    'UNKNOWN_KEY',
  )
  assert.equal(countRows(db, 'relation'), 0, '关系被留下了 —— 事务没回滚')
  assert.equal(countRows(db, 'exchange'), 0, '交换被留下了 —— 事务没回滚')
  db.close()
})

check('种子狗：写出的 payload 键集合严格 = {kind,line,weather}，没有任何主人话', () => {
  const db = seedTwoDogs()
  const r = meet({
    db,
    dogId: 'dog_owner',
    otherDogId: 'dog_seed_07',
    tripId: 'trip_owner_1',
    now: T0,
    outgoing: { kind: 'greeting', payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' } },
  })
  const keys = Object.keys(r.exchanges[0].exchange.payload).sort()
  assert.deepEqual(keys, ['kind', 'line', 'weather'])
  const sample = db.prepare('SELECT is_sample FROM dog WHERE id = ?').get('dog_seed_07') as {
    is_sample: number
  }
  assert.equal(Number(sample.is_sample), 1)
  db.close()
})

// ===========================================================================
// 五、两个纯函数
// ===========================================================================

console.log('\n【纯函数】orderPair / nowIso')

check('orderPair 与 SQLite 的字典序一致（ASCII id）', () => {
  assert.deepEqual(orderPair('dog_seed_07', 'dog_owner'), ['dog_owner', 'dog_seed_07'])
  assert.deepEqual(orderPair('dog_owner', 'dog_seed_07'), ['dog_owner', 'dog_seed_07'])
})

check('nowIso 出秒级 UTC，不带毫秒', () => {
  const s = nowIso(new Date('2026-11-19T08:00:00.123Z'))
  assert.equal(s, '2026-11-19T08:00:00Z')
  assert.equal(nowIso('2026-11-19T08:00:00Z'), '2026-11-19T08:00:00Z')
})

// ===========================================================================
// 汇总
// ===========================================================================

console.log('\n' + '─'.repeat(58))
console.log(`通过 ${pass} 条，失败 ${fail} 条`)
if (fail > 0) {
  console.log('\n失败清单：')
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
} else {
  console.log('全绿。库里第一次出现了「一条真交换记录」。')
}
