import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { writeReply } from '../lib/replies/idempotency.ts'

// B6-13 的可复验证据：同一来源重复提交返回库中真实 reply + duplicate、库中仍 1 行，
// 首次内容与 replied_at 不被覆盖，两条来源路径都覆盖，非目标约束失败不当成功。
// 契约文本（200 vs 409）不在此测——那是 A/B/C 收口项，见回交文档。
const root = resolve('.local/reply-idem-tests')
mkdirSync(root, { recursive: true })
const T0 = '2026-11-21T00:00:00.000Z'
const T1 = '2026-11-21T01:00:00.000Z'

function setup(t) {
  const directory = mkdtempSync(join(root, 'database-'))
  const db = openDatabase(join(directory, 'app.sqlite'))
  t.after(() => {
    if (db.isOpen) db.close()
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  const dog = (id, session) => db.prepare(
    `INSERT INTO dog(id,session_id,personality_tags,assembly,created_at) VALUES(?,?,'["好奇","看物","直给"]',?,?)`,
  ).run(id, session, '{"cloth":"hoodie","hat":null,"glasses":null,"face":"hopeful"}', '2026-11-21T00:00:00Z')
  dog('dog-a', 'session-a')
  dog('dog-b', 'session-b')
  // 一条已送达、一条未送达的 exchange；一条 invitation。
  db.prepare(`INSERT INTO exchange(id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at,delivered_at)
    VALUES('ex-delivered','dog-b','dog-a','greeting','{}',1,?,'2026-11-21T00:00:00Z')`).run(T0)
  db.prepare(`INSERT INTO exchange(id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at)
    VALUES('ex-pending','dog-b','dog-a','gift','{}',1,?)`).run(T0)
  db.prepare(`INSERT INTO invitation(id,dog_id,text,created_at) VALUES('inv-1','dog-b','一起看雪吧，我在雪里等你自己决定。',?)`).run(T0)
  return { db }
}

const source = { invitation: { kind: 'invitation', id: 'inv-1' }, exchanged: { kind: 'exchange', id: 'ex-delivered' } }

test('首次写入返回 created + 库中真实 reply（非假 ID），库里 1 行', t => {
  const { db } = setup(t)
  let n = 0
  const first = writeReply(db, { source: source.invitation, text: '好，一起去。', photoUrl: null },
    { now: () => new Date(T0), newId: () => `r_test_${++n}` })
  assert.equal(first.kind, 'created')
  assert.equal(first.reply.id, 'r_test_1')
  assert.match(first.reply.id, /^r_/)
  assert.equal(first.reply.invitationId, 'inv-1')
  assert.equal(first.reply.exchangeId, null)
  assert.equal(first.reply.kind, 'text')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reply').get().n, 1)
  assert.equal(db.prepare('SELECT id FROM reply').get().id, 'r_test_1')
  // 真实回执：返回的 id 查库存在，不是生成的假 ID。
  assert.ok(db.prepare('SELECT 1 FROM reply WHERE id=?').get(first.reply.id))
})

test('同一 invitation 重复提交返回 duplicate + 原真实 reply，库仍 1 行且首次内容不被覆盖', t => {
  const { db } = setup(t)
  let n = 0
  const opts = { newId: () => `r_test_${++n}` }
  const first = writeReply(db, { source: source.invitation, text: '首次的原文。', photoUrl: null },
    { ...opts, now: () => new Date(T0) })
  const second = writeReply(db, { source: source.invitation, text: '重放时的另一段文字。', photoUrl: null },
    { ...opts, now: () => new Date(T1) })
  assert.equal(first.kind, 'created')
  assert.equal(second.kind, 'duplicate')
  assert.equal(second.reply.id, first.reply.id)          // 真实 id，同首次
  assert.notEqual(second.reply.id, 'r_test_2')           // 不是第二次生成的假 ID
  assert.equal(second.reply.text, '首次的原文。')         // 首次内容没被覆盖
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reply').get().n, 1)
})

test('exchange 路径同样幂等，且 replied_at 保留首次时间不被重放改写', t => {
  const { db } = setup(t)
  let n = 0
  const opts = { newId: () => `r_test_${++n}` }
  const first = writeReply(db, { source: source.exchanged, text: '收到你的信。', photoUrl: null },
    { ...opts, now: () => new Date(T0) })
  assert.equal(first.kind, 'created')
  assert.equal(db.prepare('SELECT replied_at FROM exchange WHERE id=?').get('ex-delivered').replied_at, T0)
  const second = writeReply(db, { source: source.exchanged, text: '换一句话重放。', photoUrl: null },
    { ...opts, now: () => new Date(T1) })
  assert.equal(second.kind, 'duplicate')
  assert.equal(second.reply.id, first.reply.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reply').get().n, 1)
  assert.equal(db.prepare('SELECT replied_at FROM exchange WHERE id=?').get('ex-delivered').replied_at, T0) // WHERE ... IS NULL 保留首次
})

test('两条来源路径各自独立重放：invitation 与 exchange 不串扰', t => {
  const { db } = setup(t)
  let n = 0
  const opts = { newId: () => `r_test_${++n}` }
  const inv = writeReply(db, { source: source.invitation, text: '回应邀请。', photoUrl: null }, opts)
  const ex = writeReply(db, { source: source.exchanged, text: '回应交换。', photoUrl: null }, opts)
  assert.equal(inv.kind, 'created')
  assert.equal(ex.kind, 'created')
  assert.notEqual(inv.reply.id, ex.reply.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reply').get().n, 2)
  const invAgain = writeReply(db, { source: source.invitation, text: '邀请重放。', photoUrl: null }, opts)
  assert.equal(invAgain.kind, 'duplicate')
  assert.equal(invAgain.reply.id, inv.reply.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reply').get().n, 2)
})

test('非目标约束失败不当幂等成功：未知来源返回 failed，不写库', t => {
  const { db } = setup(t)
  // 来源外键不存在——Route 会先做来源归属校验，这里直接测核心不会把外键错误伪装成 duplicate。
  const result = writeReply(db, { source: { kind: 'invitation', id: 'no-such-invitation' }, text: '不该落库。', photoUrl: null },
    { newId: () => 'r_bad' })
  assert.equal(result.kind, 'failed')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reply').get().n, 0)
})

test('重放回复带真实 createdAt 与 kind，dto 不丢字段', t => {
  const { db } = setup(t)
  let n = 0
  const opts = { newId: () => `r_test_${++n}` }
  writeReply(db, { source: source.invitation, text: '带图之外。', photoUrl: null }, { ...opts, now: () => new Date(T0) })
  const again = writeReply(db, { source: source.invitation, text: 'x', photoUrl: null }, { ...opts, now: () => new Date(T1) })
  assert.equal(again.kind, 'duplicate')
  assert.equal(again.reply.createdAt, T0)
  assert.equal(typeof again.reply.kind, 'string')
  assert.equal(again.reply.photoUrl, null)
})
