/**
 * d4 端到端实测：真文件库 + 真 contracts/schema.sql。
 * 验的不是函数返回值，是 SELECT 出来的表里到底有几行。
 *
 * 跑法：node --experimental-strip-types _e2e_d4.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { meet } from '../lib/social/meet.ts'
import { sendGift, sendCoOwnerMessage } from '../lib/social/gift.ts'
import { createSqliteStore } from '../lib/social/sqlite-store.ts'

// 仓库根：本文件在 scripts/ 下，上一级就是根。不依赖 cwd。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const DBFILE = '/tmp/d4_e2e.db'
if (fs.existsSync(DBFILE)) fs.unlinkSync(DBFILE)
const db = new DatabaseSync(DBFILE)
db.exec('PRAGMA foreign_keys = ON')
db.exec(fs.readFileSync(path.join(ROOT, 'contracts/schema.sql'), 'utf8'))

const T0 = '2026-11-19T08:00:00Z'
const T1 = '2026-11-19T16:00:00Z'
const dogRow = (id: string, sample = 0) =>
  db
    .prepare(
      `INSERT INTO dog (id,name,session_id,personality_tags,interest_categories,assembly,is_sample,blocked_topics,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      null,
      's',
      JSON.stringify(['好奇', '看物', '当下']),
      JSON.stringify(['自然风景', '冷知识']),
      JSON.stringify({ cloth: 'sweater', hat: null, glasses: 'round', face: 'waiting' }),
      sample,
      '[]',
      T0,
    )

dogRow('dog_a')
dogRow('dog_b')
dogRow('dog_seed', 1)

const trip = (id: string, dogId: string, seq: number) =>
  db
    .prepare(
      `INSERT INTO trip (id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
       VALUES (?,?,?,'running','auto',?,?,NULL)`,
    )
    .run(id, dogId, seq, T0, T0)

trip('trip_a1', 'dog_a', 1)
trip('trip_b1', 'dog_b', 1)
trip('trip_b2', 'dog_b', 2)
trip('trip_b3', 'dog_b', 3)

const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T
const n = (t: string): number => Number(one<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`).n)
const rel = () =>
  one<{ met_count: number; first_met_at: string; last_met_at: string }>(
    `SELECT met_count, first_met_at, last_met_at FROM relation WHERE dog_a='dog_a' AND dog_b='dog_b'`,
  )

const step = (s: string) => console.log(`\n── ${s}`)

// ===========================================================================
step('1｜第一次相遇：greeting 送出 + 关系建立')
const store = createSqliteStore(db)

const m1 = meet({
  store,
  dogId: 'dog_a',
  otherDogId: 'dog_b',
  tripId: 'trip_a1',
  now: T0,
  outgoing: { kind: 'greeting', payload: { line: '你也爱在下雨天出来啊', weather: '雨' } },
})
console.log('返回值  replayed =', m1.replayed, ' exchanges =', m1.exchanges.length)
console.log('库里   exchange =', n('exchange'), ' relation =', n('relation'), ' met_count =', rel().met_count)

// ===========================================================================
step('2｜同一趟重试一次（网络重发）')
const m2 = meet({
  store,
  dogId: 'dog_a',
  otherDogId: 'dog_b',
  tripId: 'trip_a1',
  now: T0,
  outgoing: { kind: 'greeting', payload: { line: '你也爱在下雨天出来啊', weather: '雨' } },
})
console.log('返回值  replayed =', m2.replayed)
console.log('库里   exchange =', n('exchange'), ' met_count =', rel().met_count, '← 必须仍是 1')

// ===========================================================================
step('3｜换一趟出行再遇（trip_a2）：met_count 必须 +1，first_met_at 必须不动')
trip('trip_a2', 'dog_a', 2)
const before = rel()
const m3 = meet({
  store,
  dogId: 'dog_a',
  otherDogId: 'dog_b',
  tripId: 'trip_a2',
  now: T1,
  outgoing: { kind: 'greeting', payload: { line: '又碰到你了', weather: '阴' } },
})
const after = rel()
console.log('返回值  replayed =', m3.replayed)
console.log(
  'met_count',
  before.met_count,
  '→',
  after.met_count,
  '| first_met_at 变了吗：',
  before.first_met_at !== after.first_met_at ? '变了（错）' : '没变（对）',
)
console.log('last_met_at 变了吗：', before.last_met_at !== after.last_met_at ? '变了（对）' : '没变（错）')

// ===========================================================================
step('4｜字典序：反过来传（dog_b 发起）也不报 CHECK')
const m4 = meet({
  store,
  dogId: 'dog_b',
  otherDogId: 'dog_a',
  tripId: 'trip_b1',
  now: T1,
  incoming: { kind: 'find', payload: { findTitle: '雨天为什么有土腥味', findExcerpt: '放线菌', sourceUrl: 'https://www.zhihu.com/question/1' } },
})
console.log('返回值  replayed =', m4.replayed, ' met_count =', rel().met_count, ' relation 行数 =', n('relation'))

// ===========================================================================
step('5｜礼物：dog_b 3 趟，deliver_after_trip_seq 应为 4')
const g1 = sendGift({
  store,
  fromDog: 'dog_a',
  toDog: 'dog_b',
  idempotencyKey: 'gift-1119-001',
  giftName: '一小卷灰蓝色的毛线',
  note: '天气要冷了',
  now: T1,
})
console.log('返回值  inserted =', g1.inserted, ' 趟次 =', g1.deliverAfterTripSeq, ' heldBack =', JSON.stringify(g1.heldBack))
console.log('库里   exchange =', n('exchange'))

// ===========================================================================
step('6｜同一个 idempotencyKey 再发一次（重试）')
const g2 = sendGift({
  store,
  fromDog: 'dog_a',
  toDog: 'dog_b',
  idempotencyKey: 'gift-1119-001',
  giftName: '一小卷灰蓝色的毛线',
  note: '天气要冷了',
  now: T1,
})
console.log('返回值  inserted =', g2.inserted, ' 趟次 =', g2.deliverAfterTripSeq)
console.log('库里   exchange =', n('exchange'), '← 必须仍是 4 条（3 条相遇 + 1 条礼物）')

// ===========================================================================
step('7｜捎话：给种子狗发「主人原话」→ 能写进去（种子狗可以收话）')
try {
  sendCoOwnerMessage({
    store,
    fromDog: 'dog_a',
    toDog: 'dog_seed',
    idempotencyKey: 'msg-1119-001',
    message: '楼下的桂花开了',
    now: T1,
  })
  console.log('写进去了 —— 对。种子狗可以「收」话，只是不能以自己主人的名义「发」话。')
} catch (e: unknown) {
  console.log('被拒：', (e as { code?: string }).code, '← 不该拒，见 1119-d4-给种子狗捎话 文档')
}

step('7b｜反向：种子狗以自己主人名义发话 → 必须拒（伪造真实用户内容）')
try {
  sendCoOwnerMessage({
    store,
    fromDog: 'dog_seed',
    toDog: 'dog_a',
    idempotencyKey: 'msg-1119-002',
    message: '主人说他也想你',
    now: T1,
  })
  console.log('居然写进去了（错）—— 这条是阻断缺陷')
} catch (e: unknown) {
  console.log('被拒：', (e as { code?: string }).code, '← 对')
}

// ===========================================================================
step('8｜最后的表里到底有什么')
console.log('\n[exchange]')
const rows = db
  .prepare(
    `SELECT id, from_dog, to_dog, kind, deliver_after_trip_seq,
            delivered_at, replied_at, read_at, substr(payload,1,64) AS payload
     FROM exchange ORDER BY deliver_after_trip_seq, id`,
  )
  .all() as Array<Record<string, unknown>>
for (const r of rows) {
  console.log(
    `  ${r.from_dog} → ${r.to_dog}  ${r.kind}  趟次=${r.deliver_after_trip_seq}` +
      `  三个时间戳=${r.delivered_at ?? 'NULL'}/${r.replied_at ?? 'NULL'}/${r.read_at ?? 'NULL'}`,
  )
  console.log(`     payload: ${r.payload}...`)
}

console.log('\n[relation]')
console.log(db.prepare('SELECT dog_a, dog_b, met_count, first_met_at, last_met_at, is_blocked FROM relation').all())

console.log(`\n合计：exchange ${n('exchange')} 行 · relation ${n('relation')} 行 · 库文件 ${DBFILE}`)
db.close()
