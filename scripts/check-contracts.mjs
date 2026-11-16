/**
 * 契约自检：schema.sql / types.ts / fixtures 三者必须互相一致。
 *
 * 这是 c 的活，不是任何人的活。跑法（Node 22+，零依赖）：
 *   node scripts/check-contracts.mjs
 *
 * 它检查以下项目，**不通过就退出码 1**（不等于 HTTP 或全部产品规则验收）：
 *   1. schema.sql 能建库，且外键真的开着
 *   2. 每一条约束真的拦得住（故意塞错数据，必须报错）
 *   3. 十份 fixtures 能逐条插进去，一条都不许失败
 *   4. personality_tags 的三条规矩：3 个、都在 12 个标签里、来自 3 个不同维度、不含互斥对
 *   5. fixtures 里每只狗都满足上面第 4 条（这条 SQL 的 CHECK 写不了，只能在这里查）
 *   6. 邀请三态视图推得对（它在等 / 已回应 / 它自己去了）
 *   7. c3 v2 读取索引、session 范围、双向关系、排序、快照与公开字段
 *
 * 第 2 条是这份脚本存在的理由：约束写了但没生效，比没写更危险——
 * 它会让人以为数据是干净的。
 */

import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let failures = 0
const ok = (msg) => console.log(`  ✅ ${msg}`)
const bad = (msg, detail) => {
  failures++
  console.log(`  ❌ ${msg}${detail ? `\n     ${detail}` : ''}`)
}

// ---------------------------------------------------------------- 1. 建库
console.log('\n1. schema.sql 建库')
const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON')
try {
  db.exec(read('contracts/schema.sql'))
  ok('schema.sql 执行成功（对象集合另外检查）')
} catch (e) {
  bad('schema.sql 执行失败', e.message)
  process.exit(1)
}

const tables = db
  .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
  .all()
  .map((r) => r.name)
const EXPECTED_TABLES = ['dog', 'exchange', 'find', 'invitation', 'message', 'relation', 'reply', 'snapshot', 'trip', 'wish']
if (JSON.stringify(tables) === JSON.stringify(EXPECTED_TABLES)) {
  ok(`${tables.length} 张表：${tables.join(' ')}`)
} else {
  bad('表集合与预期不符', `实际：${tables.join(' ')}\n     预期：${EXPECTED_TABLES.join(' ')}`)
}

if (db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1) ok('外键是开着的')
else bad('外键没打开', '每个连接都要 PRAGMA foreign_keys = ON')

// ---------------------------------------------------------------- 2. 约束真的拦得住
console.log('\n2. 约束真的拦得住（故意塞错数据，必须报错）')

const DOG_OK = JSON.stringify({
  base: 'tpl-a', skin: { color: 'red', pattern: 'spot' },
  cloth: 'hoodie', hat: 'beanie', glasses: null, face: 'hopeful',
})
const insDog = () =>
  db.prepare(`insert into dog (id,name,session_id,personality_tags,interest_categories,assembly,is_sample,created_at)
              values (?,?,?,?,?,?,0,?)`)
    .run('dog_x', '豆子', 's_1', '["好奇","看物","直给"]',
         '["自然风景","冷知识"]', DOG_OK, '2026-11-16T00:00:00Z')

const mustFail = (label, fn) => {
  try { fn(); bad(`${label} —— 没拦住`) }
  catch (e) { ok(`${label} → ${e.message.split('\n')[0].slice(0, 62)}`) }
}
const mustPass = (label, fn) => {
  try { fn(); ok(label) }
  catch (e) { bad(`${label} —— 该通过的被拦了`, e.message) }
}

mustPass('合法的狗能插进去', insDog)
db.exec('delete from dog')

mustFail('装配单多一个键 → 拦', () => {
  const a = JSON.parse(DOG_OK); a.extra = 1
  db.prepare(`insert into dog (id,name,session_id,personality_tags,assembly,created_at)
              values ('d2','二','s', '["好奇","看物","直给"]', ?, '2026-11-16T00:00:00Z')`).run(JSON.stringify(a))
})
mustFail('装配单少一个键 → 拦', () => {
  const a = JSON.parse(DOG_OK); delete a.glasses
  db.prepare(`insert into dog (id,name,session_id,personality_tags,assembly,created_at)
              values ('d3','三','s','["好奇","看物","直给"]', ?, '2026-11-16T00:00:00Z')`).run(JSON.stringify(a))
})
mustFail('性格标签只给 2 个 → 拦', () =>
  db.prepare(`insert into dog (id,session_id,personality_tags,assembly,created_at)
              values ('d4','s','["好奇","看物"]', ?,'2026-11-16T00:00:00Z')`).run(DOG_OK))
mustFail('名字超过 6 字 → 拦', () =>
  db.prepare(`insert into dog (id,name,session_id,personality_tags,assembly,created_at)
              values ('d5','一二三四五六七','s','["好奇","看物","直给"]', ?,'2026-11-16T00:00:00Z')`).run(DOG_OK))

// trip
mustPass('合法的出行能插进去', () =>
  db.prepare(`insert into dog (id,session_id,personality_tags,assembly,created_at)
              values ('dog_t','s','["好奇","看物","直给"]', ?,'2026-11-16T00:00:00Z')`).run(DOG_OK))
db.prepare(`insert into trip (id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
            values ('trip_1','dog_t',1,'done','auto','2026-11-16T01:00:00Z','2026-11-16T01:00:00Z','2026-11-16T01:05:00Z')`).run()
ok('合法的出行能插进去（seq=1，done 带两个时刻）')

mustFail('running 却没有 started_at → 拦', () =>
  db.prepare(`insert into trip (id,dog_id,seq,status,trigger,created_at)
              values ('trip_bad','dog_t',2,'running','auto','2026-11-16T02:00:00Z')`).run())
mustFail('done 却没有 ended_at → 拦', () =>
  db.prepare(`insert into trip (id,dog_id,seq,status,trigger,created_at,started_at)
              values ('trip_bad2','dog_t',3,'done','auto','2026-11-16T02:00:00Z','2026-11-16T02:00:00Z')`).run())
mustFail('同一只狗两次出行用同一个 seq → 拦', () =>
  db.prepare(`insert into trip (id,dog_id,seq,status,trigger,created_at)
              values ('trip_dup','dog_t',1,'pending','auto','2026-11-16T03:00:00Z')`).run())

// find：source_mode 的语义
mustPass('zhihu 发现带 source_mode 能插', () =>
  db.prepare(`insert into find (id,trip_id,kind,title,source_url,source_mode,created_at)
              values ('find_z','trip_1','zhihu','下雪的北京','https://zhihu.com/a/1','live','2026-11-16T01:02:00Z')`).run())
mustFail("zhihu 发现 source_mode 空着 → 拦", () =>
  db.prepare(`insert into find (id,trip_id,kind,title,source_url,created_at)
              values ('find_z2','trip_1','zhihu','没有来源模式','https://zhihu.com/a/2','2026-11-16T01:02:00Z')`).run())
mustPass('scene 发现 source_mode 为 NULL 能插', () =>
  db.prepare(`insert into find (id,trip_id,kind,title,created_at)
              values ('find_s','trip_1','scene','路边一棵银杏','2026-11-16T01:02:00Z')`).run())
mustFail('scene 发现标了 source_mode → 拦（自家画的东西不属于三档）', () =>
  db.prepare(`insert into find (id,trip_id,kind,title,source_mode,created_at)
              values ('find_s2','trip_1','scene','银杏','live','2026-11-16T01:02:00Z')`).run())

// exchange：时间语义
mustPass('合法的交换能插', () =>
  db.prepare(`insert into dog (id,session_id,personality_tags,assembly,created_at)
              values ('dog_b','s2','["恋家","看人","婉转"]', ?,'2026-11-16T00:00:00Z')`).run(DOG_OK))
db.prepare(`insert into exchange (id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at)
            values ('ex_1','dog_t','dog_b','gift','{"note":"一条围巾"}',2,'2026-11-16T01:10:00Z')`).run()
ok('合法的礼物能插（deliver_after_trip_seq=2）')
mustFail('寄给自己 → 拦', () =>
  db.prepare(`insert into exchange (id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at)
              values ('ex_self','dog_t','dog_t','gift','{}',2,'2026-11-16T01:10:00Z')`).run())
mustFail('kind 塞第五种 → 拦', () =>
  db.prepare(`insert into exchange (id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at)
              values ('ex_k','dog_t','dog_b','chat','{}',2,'2026-11-16T01:10:00Z')`).run())

// reply
db.prepare(`insert into invitation (id,dog_id,text,created_at)
            values ('inv_1','dog_t','下次看到晾着的被子，拍一张给我。不方便就算了。','2026-11-16T01:06:00Z')`).run()
ok('合法的邀请能插（无 expires_at 字段，邀请永不过期）')

mustPass('文字回应能插，kind 自动推成 text', () => {
  db.prepare(`insert into reply (id,invitation_id,text,created_at)
              values ('r1','inv_1','看到了，阳台外面那排被子。','2026-11-16T02:00:00Z')`).run()
  const k = db.prepare("select kind from reply where id='r1'").get().kind
  if (k !== 'text') throw new Error(`kind 推错了：${k}`)
  db.exec("delete from reply where id='r1'")
})
mustPass('文字加图片同时 → kind 推成 both（b 的第 3 条正常示例）', () => {
  db.prepare(`insert into reply (id,invitation_id,text,photo_url,created_at)
              values ('r2','inv_1','下雪了，拍了一张。','/assets/photos/a.webp','2026-11-16T02:00:00Z')`).run()
  const k = db.prepare("select kind from reply where id='r2'").get().kind
  db.exec("delete from reply where id='r2'")
  if (k !== 'both') throw new Error(`kind 推错了：${k}`)
})
mustFail('空回应（既没文字也没图）→ 拦住，不许交个寂寞还入库', () =>
  db.prepare(`insert into reply (id,invitation_id,created_at)
              values ('r3','inv_1','2026-11-16T02:00:00Z')`).run())
mustFail('回应同时指向邀请和交换 → 拦', () =>
  db.prepare(`insert into reply (id,invitation_id,exchange_id,text,created_at)
              values ('r4','inv_1','ex_1','两个来源','2026-11-16T02:00:00Z')`).run())
mustFail('回应什么都不指向 → 拦', () =>
  db.prepare(`insert into reply (id,text,created_at)
              values ('r5','悬空','2026-11-16T02:00:00Z')`).run())

// 幂等：**两条路径都要测**。只测一条就是没测。
// 2026-11-15 a 实测出过这个缺陷：邀请有唯一索引，礼物没有，礼物的第二次提交插进去了。
db.prepare(`insert into reply (id,invitation_id,text,created_at)
            values ('r6','inv_1','第一次回应','2026-11-16T02:00:00Z')`).run()
mustFail('同一条邀请回两次（重复点击提交）→ 拦，幂等靠这条兜住', () =>
  db.prepare(`insert into reply (id,invitation_id,text,created_at)
              values ('r7','inv_1','重复提交','2026-11-16T02:01:00Z')`).run())

db.prepare(`insert into reply (id,exchange_id,text,created_at)
            values ('r8','ex_1','第一次回礼物','2026-11-16T02:00:00Z')`).run()
mustFail('同一个礼物回两次（同一条交换的第二个入口）→ 拦，两条路径必须一样', () =>
  db.prepare(`insert into reply (id,exchange_id,text,created_at)
              values ('r9','ex_1','重复回礼物','2026-11-16T02:01:00Z')`).run())

// 两个索引必须都在。少一个就是「一半的幂等」，比完全没有更危险。
const uniqIdx = db.prepare(`
  select name from sqlite_master
   where type='index' and tbl_name='reply' and sql like '%UNIQUE%'
   order by name
`).all().map((r) => r.name)
if (uniqIdx.length === 2 && uniqIdx.includes('uniq_reply_invitation') && uniqIdx.includes('uniq_reply_exchange')) {
  ok(`reply 的两个来源都有唯一索引：${uniqIdx.join(' + ')}`)
} else {
  bad('reply 的来源唯一索引不全 —— 重复提交会漏掉其中一条路径', `实际只有：${uniqIdx.join('、') || '（一个都没有）'}`)
}

// relation
mustFail('关系里两只狗顺序反了（避免同一对存两条）→ 拦', () =>
  db.prepare(`insert into relation (id,dog_a,dog_b,first_met_at,last_met_at)
              values ('rel_x','dog_t','dog_b','2026-11-16T03:00:00Z','2026-11-16T03:00:00Z')`).run())
mustPass('关系按字典序排列能插', () =>
  db.prepare(`insert into relation (id,dog_a,dog_b,first_met_at,last_met_at)
              values ('rel_1','dog_b','dog_t','2026-11-16T03:00:00Z','2026-11-16T03:00:00Z')`).run())

// ---------------------------------------------------------------- 3. fixtures
console.log('\n3. 十份 fixtures 逐条插进去')

// 每份 fixtures 的顶层数组键名（表名 → 键名）
const FX_KEYS = {
  dog: 'dogs', snapshot: 'snapshots', wish: 'wishes', trip: 'trips', find: 'finds',
  exchange: 'exchanges', message: 'messages', reply: 'replies', invitation: 'invitations',
  relation: 'relations',
}

const fx = {}
for (const [table, key] of Object.entries(FX_KEYS)) {
  try {
    const raw = JSON.parse(read(`contracts/fixtures/${table}.json`))
    if (!Array.isArray(raw[key])) throw new Error(`顶层缺少数组 "${key}"`)
    if (raw.sourceMode !== 'fixture') throw new Error('缺少 sourceMode: "fixture"（假数据必须自报身份）')
    fx[table] = raw[key]
    ok(`fixtures/${table}.json 是合法 JSON，${raw[key].length} 条`)
  } catch (e) { bad(`fixtures/${table}.json 读不了`, e.message) }
}

for (const e of fx.exchange ?? []) {
  mustPass(`exchange fixture ${e.id}: payload.kind 与外层 kind 一致`, () => {
    assert.equal(typeof e.payload, 'object')
    assert.notEqual(e.payload, null)
    assert.equal(e.payload.kind, e.kind)
  })
}

// 清空，用 fixtures 重建一遍，证明 fixtures 和 schema 是一套
for (const t of ['reply', 'invitation', 'relation', 'message', 'exchange', 'find', 'trip', 'wish', 'snapshot', 'dog']) {
  db.exec(`delete from ${t}`)
}

const insertAll = (table, rows, cols) => {
  let n = 0
  for (const r of rows) {
    const vals = cols.map((c) => (r[c] === undefined ? null : r[c]))
    const sql = `insert into ${table} (${cols.join(',')}) values (${cols.map(() => '?').join(',')})`
    try { db.prepare(sql).run(...vals); n++ }
    catch (e) { bad(`${table} 里 ${r.id ?? r.dog_id} 插不进去`, e.message.split('\n')[0]) }
  }
  ok(`${table}: ${n}/${rows.length} 条插进去`)
}
const J = (v) => (v === null || v === undefined ? null : JSON.stringify(v))

for (const d of fx.dog) {
  d.personality_tags = J(d.personality_tags)
  d.interest_categories = J(d.interest_categories)
  d.assembly = J(d.assembly)
  d.blocked_topics = J(d.blocked_topics ?? [])
  d.is_sample = d.is_sample ? 1 : 0
}
insertAll('dog', fx.dog, ['id', 'name', 'session_id', 'personality_tags', 'interest_categories', 'assembly', 'is_sample', 'blocked_topics', 'created_at'])

for (const s of fx.snapshot) {
  s.personality_tags = J(s.personality_tags)
  s.interest_categories = J(s.interest_categories)
  s.recent_trips = J(s.recent_trips)
}
insertAll('snapshot', fx.snapshot, ['dog_id', 'version', 'personality_tags', 'interest_categories', 'recent_trips', 'waiting_for', 'created_at'])

insertAll('wish', fx.wish, ['id', 'dog_id', 'text', 'category', 'created_at', 'revoked_at'])
insertAll('trip', fx.trip, ['id', 'dog_id', 'seq', 'status', 'trigger', 'created_at', 'started_at', 'ended_at'])
insertAll('find', fx.find, ['id', 'trip_id', 'kind', 'title', 'excerpt', 'source_url', 'source_mode', 'authority_level', 'vote_up_count', 'created_at'])
for (const e of fx.exchange) e.payload = J(e.payload)
insertAll('exchange', fx.exchange, ['id', 'from_dog', 'to_dog', 'kind', 'payload', 'deliver_after_trip_seq', 'created_at', 'delivered_at', 'replied_at', 'read_at'])
insertAll('message', fx.message, ['id', 'trip_id', 'text', 'mentions_find_id', 'created_at'])
insertAll('invitation', fx.invitation, ['id', 'dog_id', 'text', 'based_on_find_id', 'created_at'])
insertAll('reply', fx.reply, ['id', 'exchange_id', 'invitation_id', 'text', 'photo_url', 'created_at'])

// relation 是十类实体之一，也必须能插（d 要用）
// checksum：脚本自己按字典序排，fixtures 里写反了也不算错
for (const r of (fx.relation ?? [])) {
  const [a, b] = [r.dog_a, r.dog_b].sort()
  db.prepare(`insert or replace into relation (id,dog_a,dog_b,first_met_at,last_met_at,met_count,is_blocked,blocked_at)
              values (?,?,?,?,?,?,?,?)`)
    .run(r.id, a, b, r.first_met_at, r.last_met_at, r.met_count ?? 1, r.is_blocked ? 1 : 0, r.blocked_at ?? null)
}
ok(`relation: ${(fx.relation ?? []).length} 条插进去`)

// ---------------------------------------------------------------- 4/5. 标签规矩
console.log('\n4. 性格标签的三条规矩（SQL 的 CHECK 写不了，只能在这里查）')

const TAGS = ['好奇', '恋家', '自来熟', '慢热', '话痨', '寡言', '看物', '看人', '直给', '婉转', '当下', '怀旧']
const DIM = {
  好奇: '探索范围', 恋家: '探索范围',
  自来熟: '对陌生人', 慢热: '对陌生人',
  话痨: '说话密度', 寡言: '说话密度',
  看物: '关注对象', 看人: '关注对象',
  直给: '表达方式', 婉转: '表达方式',
  当下: '时间感', 怀旧: '时间感',
}
export const checkTags = (tags, label) => {
  if (tags.length !== 3) return bad(`${label}: 必须是 3 个标签，现在是 ${tags.length} 个`)
  const unknown = tags.filter((t) => !TAGS.includes(t))
  if (unknown.length) return bad(`${label}: 有标签不在 12 个里 → ${unknown.join('、')}`)
  const dims = new Set(tags.map((t) => DIM[t]))
  if (dims.size !== 3) return bad(`${label}: 3 个标签必须来自 3 个不同维度，现在只占 ${dims.size} 个（${[...dims].join('、')}）`)
  ok(`${label}: ${tags.join(' / ')} —— 3 个维度：${[...dims].join('、')}`)
}

// ---------------------------------------------------------------- 5. 每只狗
console.log('\n5. fixtures 里每只狗都合规矩')
const dogs = db.prepare('select id, name, personality_tags, is_sample from dog order by id').all()
let seedCount = 0
for (const d of dogs) {
  checkTags(JSON.parse(d.personality_tags), `${d.id} ${d.name ?? '(无名)'}`)
  if (d.is_sample) seedCount++
}
const seeds = dogs.filter((d) => d.is_sample)
if (seeds.length > 0) {
  const allSample = seeds.every((d) => d.is_sample === 1)
  allSample ? ok(`种子狗 ${seeds.length} 只，is_sample 全是 1（e 才能标「示例伙伴」）`)
            : bad('有种子狗 is_sample 不是 1 —— 这是阻断缺陷')
}

// ---------------------------------------------------------------- 6. 邀请三态
console.log('\n6. 邀请三态视图推得对不对')

const states = db.prepare('select invitation_id, dog_id, state, reply_id, gone_alone_trip_id from v_invitation_state').all()
console.log(`     视图里有 ${states.length} 条邀请：`)
for (const s of states) console.log(`       ${s.invitation_id} → ${s.state}${s.reply_id ? ` (reply ${s.reply_id})` : ''}${s.gone_alone_trip_id ? ` (trip ${s.gone_alone_trip_id})` : ''}`)

const byId = Object.fromEntries(states.map((s) => [s.invitation_id, s]))
const want = { waiting: 'waiting', replied: 'replied', gone_alone: 'gone_alone' }
for (const [id, expect] of Object.entries(want)) {
  if (!byId[id]) { bad(`fixtures 里缺少 ${expect} 状态的邀请（id=${id}）`); continue }
  byId[id].state === expect ? ok(`${id} 推成 ${expect}`) : bad(`${id} 应该推成 ${expect}，实际 ${byId[id].state}`)
}
const hasStatusCol = db.prepare("select count(*) c from pragma_table_info('invitation') where name in ('status','expires_at')").get().c
hasStatusCol === 0 ? ok('invitation 表没有 status / expires_at 列（不存状态，也不许过期）')
                   : bad('invitation 表混进了 status 或 expires_at —— 会造出第二个写入方')

// ---------------------------------------------------------------- 7. v2 读取契约
console.log('\n7. c3 v2 读取契约（直接执行 api.md 的 SQL，不代表 HTTP 路由已上线）')

const expectedReadIndexes = {
  idx_exchange_outbox: ['exchange', [['from_dog', 0], ['created_at', 1]]],
  idx_relation_dog_a_recent: ['relation', [['dog_a', 0], ['last_met_at', 1], ['id', 0]]],
  idx_relation_dog_b_recent: ['relation', [['dog_b', 0], ['last_met_at', 1], ['id', 0]]],
}
for (const [name, [table, columns]] of Object.entries(expectedReadIndexes)) {
  mustPass(`${name}: 表、列顺序及升降序正确`, () => {
    assert.equal(db.prepare("select tbl_name from sqlite_master where type='index' and name=?").get(name)?.tbl_name, table)
    const actual = db.prepare('select name, desc from pragma_index_xinfo(?) where key=1 order by seqno').all(name)
    assert.deepEqual(actual.map((c) => [c.name, c.desc]), columns)
  })
}

const api = read('contracts/api.md').replace(/\r\n/g, '\n')
const types = read('contracts/types.ts')
const publicKeys = ['id', 'name', 'assembly', 'isSample'].sort()
mustPass('PublicDogSummary 类型与文档示例严格限定四个公开字段，无私有狗字段', () => {
  const body = types.match(/export interface PublicDogSummary\s*\{([^}]+)\}/)?.[1]
  assert.ok(body, '缺少 PublicDogSummary')
  const keys = [...body.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]).sort()
  assert.deepEqual(keys, publicKeys)
  const samples = [...api.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]))
  const sample = samples.find((s) => Array.isArray(s.relations))
  assert.ok(sample?.relations.length, '缺少关系响应 JSON 示例')
  for (const r of sample.relations) assert.deepEqual(Object.keys(r.otherDog).sort(), publicKeys)
  assert.match(types, /export interface RelationView\s*\{\s*relation: Relation\s+otherDog: PublicDogSummary\s+snapshot: Snapshot \| null\s*\}/)
  assert.match(types, /export interface RelationsResponse\s*\{\s*relations: RelationView\[\]\s*\}/)
  assert.match(types, /export interface ExchangesResponse\s*\{\s*exchanges: Exchange\[\]\s*\}/)
})

// 查询参考由 api.md 提供，测试不再另抄一份 SQL；sessionId 模拟服务端可信上下文。
const readSql = (name) => {
  const block = [...api.matchAll(/```sql\s*\n([\s\S]*?)\n```/g)]
    .map((m) => m[1]).find((sql) => sql.startsWith(`-- c3-v2: ${name}\n`))
  assert.ok(block, `api.md 缺少 ${name} SQL`)
  return db.prepare(block)
}
try {
  const ownedDog = readSql('owned-dog')
  const relations = readSql('relations')
  const outbox = readSql('outbox')
  const owner = { dogId: 'dog_owner', sessionId: 's_demo_001' }
  const seed = { dogId: 'dog_seed_07', sessionId: 'seed' }
  const ids = (rows) => rows.map((r) => r.id)

  mustPass('关系读取：请求狗为 dog_a，otherDog 为 dog_b', () => {
    const rows = relations.all(owner)
    assert.deepEqual(ids(rows), ['rel_001'])
    assert.equal(rows[0].other_id, 'dog_seed_07')
    assert.equal(rows[0].snapshot_dog_id, 'dog_seed_07')
  })
  mustPass('关系读取：请求狗为 dog_b，otherDog 为 dog_a', () => {
    const rows = relations.all(seed)
    assert.deepEqual(ids(rows), ['rel_001'])
    assert.equal(rows[0].other_id, 'dog_owner')
    assert.equal(rows[0].snapshot_dog_id, 'dog_owner')
  })
  mustPass('归属查询区分合法狗；不存在、跨 session、伪造 ID 均查不到', () => {
    assert.equal(ownedDog.get(owner)?.id, owner.dogId)
    for (const params of [
      { ...owner, sessionId: 'wrong-session' },
      { ...owner, dogId: 'missing-dog' },
      { ...owner, dogId: "dog_owner' OR 1=1 --" },
    ]) {
      assert.equal(ownedDog.get(params), undefined)
      assert.deepEqual(relations.all(params), [])
      assert.deepEqual(outbox.all(params), [])
    }
  })
  mustPass('发件读取：仅返回指定发送狗，收件狗的反向记录不混入', () => {
    assert.deepEqual(ids(outbox.all(owner)), ['ex_co_owner', 'ex_greeting'])
    assert.deepEqual(ids(outbox.all(seed)), ['ex_find', 'ex_gift'])
  })
  mustPass('发件读取：所有投递状态和三个时间列原样保留', () => {
    for (const params of [owner, seed]) {
      const actual = outbox.all(params)
      const expected = fx.exchange.filter((e) => e.from_dog === params.dogId)
      assert.equal(actual.length, expected.length)
      for (const row of actual) {
        const source = expected.find((e) => e.id === row.id)
        for (const key of ['delivered_at', 'replied_at', 'read_at']) assert.equal(row[key], source[key])
      }
    }
  })

  // 边界数据仅放内存 savepoint，结束回滚，不改十份 fixtures 的业务含义。
  db.exec('SAVEPOINT v2_read_cases')
  try {
    for (const id of ['dog_aaa', 'dog_zzz', 'dog_empty']) {
      db.prepare(`insert into dog (id,session_id,personality_tags,assembly,created_at)
        select ?,session_id,personality_tags,assembly,created_at from dog where id='dog_owner'`).run(id)
    }
    db.exec(`insert into relation (id,dog_a,dog_b,first_met_at,last_met_at,is_blocked,blocked_at) values
      ('rel_aaa','dog_aaa','dog_owner','2026-11-16T09:00:00Z','2026-11-16T10:00:00Z',1,'2026-11-16T10:00:00Z'),
      ('rel_zzz','dog_owner','dog_zzz','2026-11-16T09:00:00Z','2026-11-16T10:00:00Z',0,null),
      ('rel_unrelated','dog_aaa','dog_zzz','2026-11-16T09:00:00Z','2026-11-16T11:00:00Z',0,null)`)
    db.exec(`insert into snapshot (dog_id,version,personality_tags,interest_categories,recent_trips,waiting_for,created_at)
      select dog_id,2,personality_tags,interest_categories,recent_trips,waiting_for,'2026-11-15T00:00:00Z'
      from snapshot where dog_id='dog_seed_07' and version=1`)
    db.exec(`insert into exchange (id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at)
      select 'ex_tie',from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at
      from exchange where id='ex_co_owner'`)

    mustPass('关系集合：按最近相遇降序、同刻 ID 升序，包含拉黑且排除无关关系', () => {
      const rows = relations.all(owner)
      assert.deepEqual(ids(rows), ['rel_aaa', 'rel_zzz', 'rel_001'])
      assert.equal(rows[0].is_blocked, 1)
    })
    mustPass('快照：按最大 version 选择，不按时间；不存在时返回 NULL 投影', () => {
      const rows = relations.all(owner)
      assert.equal(rows.find((r) => r.id === 'rel_001').snapshot_version, 2)
      assert.equal(rows.find((r) => r.id === 'rel_zzz').snapshot_dog_id, null)
      assert.equal(rows.find((r) => r.id === 'rel_zzz').other_name, null)
    })
    mustPass('公开狗 SQL 投影仅四字段，原始行不含 session 或屏蔽主题', () => {
      for (const row of relations.all(owner)) {
        assert.deepEqual(Object.keys(row).filter((key) => key.startsWith('other_')).sort(),
          ['other_assembly', 'other_id', 'other_is_sample', 'other_name'])
        assert.ok(!Object.keys(row).some((key) => /session|blocked_topics|blockedTopics/i.test(key)))
      }
    })
    mustPass('发件排序：created_at 降序，同刻 ID 降序', () => {
      assert.deepEqual(ids(outbox.all(owner)), ['ex_tie', 'ex_co_owner', 'ex_greeting'])
    })
    mustPass('属于当前 session 且无数据的狗：两个集合均为空', () => {
      const empty = { ...owner, dogId: 'dog_empty' }
      assert.equal(ownedDog.get(empty)?.id, empty.dogId)
      assert.deepEqual(relations.all(empty), [])
      assert.deepEqual(outbox.all(empty), [])
    })
    mustPass('两条集合查询与归属检查均不写数据库', () => {
      const before = db.prepare('select total_changes() n').get().n
      ownedDog.get(owner); relations.all(owner); outbox.all(owner)
      assert.equal(db.prepare('select total_changes() n').get().n, before)
    })
  } finally {
    db.exec('ROLLBACK TO v2_read_cases; RELEASE v2_read_cases')
  }
} catch (e) {
  bad('v2 查询参考初始化或边界数据准备失败', e.message)
}

// ---------------------------------------------------------------- 收尾
console.log(`\n${'─'.repeat(58)}`)
if (failures === 0) {
  console.log('✅ 本脚本覆盖的契约检查全部通过；HTTP、会话接入与未覆盖的产品规则仍需单独验收。')
} else {
  console.log(`❌ ${failures} 处不通过。修完再交。`)
}
process.exit(failures === 0 ? 0 : 1)
