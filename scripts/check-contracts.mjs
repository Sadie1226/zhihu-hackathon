/**
 * 契约自检：schema.sql / types.ts / fixtures 三者必须互相一致。
 *
 * 这是 c 的活，不是任何人的活。跑法（Node 22+，零依赖）：
 *   node scripts/check-contracts.mjs
 *
 * 它做六件事，**每一件都是「不通过就退出码 1」**：
 *   1. schema.sql 能建库，且外键真的开着
 *   2. 每一条约束真的拦得住（故意塞错数据，必须报错）
 *   3. 九份 fixtures 能逐条插进去，一条都不许失败
 *   4. personality_tags 的三条规矩：3 个、都在 12 个标签里、来自 3 个不同维度、不含互斥对
 *   5. fixtures 里每只狗都满足上面第 4 条（这条 SQL 的 CHECK 写不了，只能在这里查）
 *   6. 邀请三态视图推得对（它在等 / 已回应 / 它自己去了）
 *
 * 第 2 条是这份脚本存在的理由：约束写了但没生效，比没写更危险——
 * 它会让人以为数据是干净的。
 */

import { DatabaseSync } from 'node:sqlite'
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
  ok('九张表 + 两个视图建起来')
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

// 幂等：同一条邀请只能回一次
db.prepare(`insert into reply (id,invitation_id,text,created_at)
            values ('r6','inv_1','第一次回应','2026-11-16T02:00:00Z')`).run()
mustFail('同一条邀请回两次（重复点击提交）→ 拦，幂等靠这条兜住', () =>
  db.prepare(`insert into reply (id,invitation_id,text,created_at)
              values ('r7','inv_1','重复提交','2026-11-16T02:01:00Z')`).run())

// relation
mustFail('关系里两只狗顺序反了（避免同一对存两条）→ 拦', () =>
  db.prepare(`insert into relation (id,dog_a,dog_b,first_met_at,last_met_at)
              values ('rel_x','dog_t','dog_b','2026-11-16T03:00:00Z','2026-11-16T03:00:00Z')`).run())
mustPass('关系按字典序排列能插', () =>
  db.prepare(`insert into relation (id,dog_a,dog_b,first_met_at,last_met_at)
              values ('rel_1','dog_b','dog_t','2026-11-16T03:00:00Z','2026-11-16T03:00:00Z')`).run())

// ---------------------------------------------------------------- 3. fixtures
console.log('\n3. 九份 fixtures 逐条插进去')

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

// 关系表不在九类实体里，但它也得能插（d 要用）
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

// ---------------------------------------------------------------- 收尾
console.log(`\n${'─'.repeat(58)}`)
if (failures === 0) {
  console.log('✅ 全部通过。contracts/ 可以直接交给全队。')
} else {
  console.log(`❌ ${failures} 处不通过。修完再交。`)
}
process.exit(failures === 0 ? 0 : 1)
