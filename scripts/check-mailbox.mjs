/**
 * 投递器自检。这是 c8（11-21）的验收底本，提前做出来因为时间语义是全队的依赖。
 *
 *   node scripts/check-mailbox.mjs
 *
 * 验四件最容易错的事：
 *   1. 「跨一次出行」真的是下一次出行才到，不是立刻到
 *   2. 三种 kind（礼物 / 发现 / 捎话）在同一时刻到达
 *   3. 幂等：重复执行投递器不会重复投递、不会覆盖时间戳
 *   4. 投递器**不写 replied_at**（那是 b 的）
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { deliverOnTripStart, isArrived, inbox } from '../lib/mailbox/deliver.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const ok = (m) => console.log(`  ✅ ${m}`)
const bad = (m, d) => { failures++; console.log(`  ❌ ${m}${d ? `\n     ${d}` : ''}`) }
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`))

const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON')
db.exec(readFileSync(join(ROOT, 'contracts/schema.sql'), 'utf8'))

const A = JSON.stringify({ base: 'tpl-a', skin: { color: 'brown', pattern: 'spot' }, cloth: 'hoodie', hat: null, glasses: null, face: 'happy' })
const insDog = (id, tags) => db.prepare(
  `insert into dog (id,session_id,personality_tags,assembly,created_at) values (?,?,?,?,'2026-11-16T00:00:00Z')`
).run(id, 's', JSON.stringify(tags), A)

insDog('dog_a', ['好奇', '看物', '直给'])
insDog('dog_b', ['恋家', '看人', '婉转'])
insDog('dog_c', ['话痨', '看物', '当下'])

const insTrip = (id, dog, seq, status, started, ended) => db.prepare(
  `insert into trip (id,dog_id,seq,status,trigger,created_at,started_at,ended_at) values (?,?,?,?, 'auto', ?, ?, ?)`
).run(id, dog, seq, status, started ?? '2026-11-16T00:00:00Z', started ?? null, ended ?? null)

// 收件狗 dog_b 跑第 1 次出行（出发前寄出的东西这时应该到了）
insTrip('t_b1', 'dog_b', 1, 'done', '2026-11-16T08:00:00Z', '2026-11-16T08:05:00Z')

const insEx = (id, from, to, kind, payload, seq) => db.prepare(
  `insert into exchange (id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at)
   values (?,?,?,?,?,?,'2026-11-16T07:00:00Z')`
).run(id, from, to, kind, JSON.stringify(payload), seq)

console.log('\n1. 「跨一次出行」到底跨多久')

// dog_b 当前在第 1 次出行之后；寄出的三件都要求「第 2 次出行」
insEx('ex_gift',  'dog_a', 'dog_b', 'gift', { kind: 'gift', giftName: '一条围巾', note: null }, 2)
insEx('ex_find',  'dog_c', 'dog_b', 'find', { kind: 'find', findTitle: '搪瓷缸', findExcerpt: null, sourceUrl: null }, 2)
insEx('ex_talk',  'dog_a', 'dog_b', 'co_owner_message', { kind: 'co_owner_message', message: '桂花开了', fromOwnerOf: 'dog_a' }, 2)

eq(inbox(db, 'dog_b').map((e) => e.state), ['onTheWay', 'onTheWay', 'onTheWay'], '三件都还在路上（第 2 次出行还没发生）')

// 第 1 次出行已经过去了，投递器现在跑一次，什么都不该到
const r0 = deliverOnTripStart(db, 'dog_b', 1, '2026-11-16T08:00:00Z')
eq(r0.deliveredIds, [], '第 1 次出行时投递 → 一件都不该到（要求是第 2 次）')

// 第 2 次出行开始
insTrip('t_b2', 'dog_b', 2, 'running', '2026-11-20T08:00:00Z')
const r2 = deliverOnTripStart(db, 'dog_b', 2, '2026-11-20T08:00:00Z')
eq(r2.deliveredIds.sort(), ['ex_find', 'ex_gift', 'ex_talk'], '第 2 次出行开始 → 三件同时到（三种 kind 同一时刻）')

const after = db.prepare('select id, delivered_at from exchange order by id').all()
ok(`到达时间戳全部是 ${after[0].delivered_at}，三件一模一样`)
if (new Set(after.map((r) => r.delivered_at)).size === 1) ok('三种 kind 确实是同一时刻到达')
else bad('三种 kind 到达时刻不一致', JSON.stringify(after))

console.log('\n2. 幂等（重复投递不重复、不覆盖）')

const before = db.prepare('select id, delivered_at from exchange order by id').all()
const again = deliverOnTripStart(db, 'dog_b', 2, '2026-11-25T23:59:00Z')
eq(again.deliveredIds, [], '同一 seq 再跑一次 → 投递 0 件')
const after2 = db.prepare('select id, delivered_at from exchange order by id').all()
eq(after2, before, '时间戳没有被覆盖（还是第一次那三个值）')

// 第 3 次出行（已经全都到过了）
insTrip('t_b3', 'dog_b', 3, 'running', '2026-11-21T08:00:00Z')
const r3 = deliverOnTripStart(db, 'dog_b', 3, '2026-11-21T08:00:00Z')
eq(r3.deliveredIds, [], '第 3 次出行 → 没有新东西要投递')

// 一件新的、要求第 3 次出行
insEx('ex_late', 'dog_a', 'dog_b', 'gift', { kind: 'gift', giftName: '一颗石子', note: null }, 3)
const r3b = deliverOnTripStart(db, 'dog_b', 3, '2026-11-21T08:00:00Z')
eq(r3b.deliveredIds, ['ex_late'], '第 3 次出行 → 只有要求 seq<=3 的那件到（上限判定是 <=，不是 ==）')

console.log('\n3. 投递器不越权')

const cols = db.prepare("select name from pragma_table_info('exchange')").all().map((r) => r.name)
ok(`exchange 有 ${cols.length} 列：${cols.join(' ')}`)

// 大 B 的回应能力还没动，replied_at 必须全是 null
const repliedNonNull = db.prepare('select count(*) c from exchange where replied_at is not null').get().c
eq(repliedNonNull, 0, '投递器跑完之后 replied_at 仍然全是 null（没顺手写 b 的列）')

// 造一条真的回应，确认投递器不会碰它
db.prepare(`insert into reply (id, exchange_id, text, created_at) values ('rp1','ex_gift','收到了','2026-11-20T09:00:00Z')`).run()
db.prepare(`update exchange set replied_at='2026-11-20T09:00:00Z' where id='ex_gift'`).run()
deliverOnTripStart(db, 'dog_b', 4, '2026-11-22T08:00:00Z')
const rp = db.prepare("select replied_at from exchange where id='ex_gift'").get().replied_at
eq(rp, '2026-11-20T09:00:00Z', 'b 写下的 replied_at 被投递器保留（没被覆盖成 null）')

console.log('\n4. 收件箱分三态')

const ib = inbox(db, 'dog_b')
const byState = ib.reduce((a, e) => (a[e.state] = (a[e.state] ?? 0) + 1, a), {})
ok(`收件箱：${JSON.stringify(byState)}`)
eq(byState.read, 1, '回应过的那件算 read（回应过必然是看过了，不许出现「已回应但未读」）')

// e 标已读，验证 read_at 一写状态就变
db.prepare(`update exchange set read_at='2026-11-21T10:00:00Z' where id='ex_find'`).run()
eq(inbox(db, 'dog_b').find((e) => e.id === 'ex_find').state, 'read', 'e 写 read_at 之后，那条从 arrived 变成 read')

console.log('\n5. isArrived 能查出「该到但没到」')

const arr = isArrived(db, 'ex_gift')
eq([arr.arrived, arr.overdue], [true, false], 'ex_gift：已到，不 overdue')

// 故意漏跑投递器：第 4 次出行已经开始了，但这件东西寄在它之后、投递器没跑。
// 这是真实的 bug 形态（比如进程在出发后崩了），isArrived 必须能查出来。
insTrip('t_b4', 'dog_b', 4, 'running', '2026-11-22T08:00:00Z')
insEx('ex_missed', 'dog_a', 'dog_b', 'gift', { kind: 'gift', giftName: '漏掉的', note: null }, 4)
const missed = isArrived(db, 'ex_missed')
eq([missed.arrived, missed.overdue], [false, true], 'ex_missed：没到但该到 → overdue=true（这说明投递器漏跑了，是真 bug）')

// 补跑一次就正常了
deliverOnTripStart(db, 'dog_b', 4, '2026-11-22T08:00:00Z')
const fixed = isArrived(db, 'ex_missed')
eq([fixed.arrived, fixed.overdue], [true, false], '补跑投递器 → overdue 消失，不影响其它记录')

eq(isArrived(db, 'ex_nope'), null, '查不存在的 id → 返回 null，不抛错')

console.log('\n' + '─'.repeat(58))
if (failures === 0) console.log('✅ 投递器全部通过。c8 的时间语义已经可验证。')
else console.log(`❌ ${failures} 处不通过。`)
process.exit(failures === 0 ? 0 : 1)
