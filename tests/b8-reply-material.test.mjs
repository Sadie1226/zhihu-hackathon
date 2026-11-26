// b8「回应成为下次材料」B 侧业务逻辑回归测试（Node 24，--experimental-strip-types）。
// 用最小临时库模拟当前 main 的 wish schema 与 C 加列后的 vNext schema，
// 不依赖迁移落地、不连正式库、不调 AI。
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  buildReplyWishDraft,
  extractReplyMaterial,
  isMaterialBlocked,
  materialKey,
  replyWishId,
} from '../lib/replies/material.ts'
import { detectReplyWishSchema, materializeReplyWish } from '../lib/replies/material-store.ts'

const NOW = () => new Date('2026-11-26T03:00:00.000Z')
const dogRow = (db, id = 'dog_b8', blocked = '[]') => {
  db.prepare('INSERT INTO dog (id, session_id, blocked_topics) VALUES (?, ?, ?)').run(id, 'session_b8', blocked)
}
const replyRow = (id, text, photoUrl = null) => ({
  id,
  exchangeId: null,
  invitationId: `inv_${id}`,
  text,
  photoUrl,
  kind: text && photoUrl ? 'both' : photoUrl ? 'photo' : 'text',
  createdAt: '2026-11-26T02:00:00.000Z',
})

function tempDb(withReplyWishSchema) {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE dog (
      id TEXT PRIMARY KEY, session_id TEXT, blocked_topics TEXT,
      interest_categories TEXT, is_sample INTEGER DEFAULT 0
    );
    CREATE TABLE reply (
      id TEXT PRIMARY KEY, exchange_id TEXT, invitation_id TEXT,
      text TEXT, photo_url TEXT, created_at TEXT NOT NULL
    );
  `)
  const wishColumns = withReplyWishSchema
    ? `origin_reply_id TEXT, UNIQUE (origin_reply_id),`
    : ''
  const sourceCheck = withReplyWishSchema
    ? `'owner', 'collection', 'reply'`
    : `'owner', 'collection'`
  db.exec(`
    CREATE TABLE wish (
      id TEXT PRIMARY KEY, dog_id TEXT NOT NULL, text TEXT NOT NULL,
      category TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT,
      source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN (${sourceCheck})),
      source_url TEXT,
      ${wishColumns}
      FOREIGN KEY (dog_id) REFERENCES dog(id)
    );
  `)
  return db
}

// ---- 确定性提取规则（不调 AI、不凭空造来源） ----

test('纯照片与纯情绪/寒暄不生成材料', () => {
  assert.equal(extractReplyMaterial(replyRow('r_photo', null, '/uploads/a.webp')), null)
  for (const text of ['嗯', '好的！', '哈哈哈哈', '谢谢', 'OK~', '它，好吧', '  ']) {
    assert.equal(extractReplyMaterial(replyRow('r_filler', text)), null, text)
  }
})

test('称谓/意图引导/句尾语气被剥掉，命中 CATEGORY_KEYWORDS 才生成', () => {
  const material = extractReplyMaterial(replyRow('r_1', '它，好想再看一次下雪的地方啊'))
  assert.deepEqual(material, {
    text: '再看一次下雪的地方',
    category: '自然风景',
    fromReplyId: 'r_1',
  })
  const food = extractReplyMaterial(replyRow('r_2', '我想学做家常菜呀'))
  assert.equal(food?.category, '手作与食物')
  assert.equal(food?.text, '学做家常菜')
  assert.equal(extractReplyMaterial(replyRow('r_3', '随便聊聊昨天')), null, '归类失败不生成')
})

test('全角/大小写与 C 的关键词口径一致，200 字上限', () => {
  assert.equal(materialKey('Ｂ bear'), materialKey('B bear'))
  const wide = extractReplyMaterial(replyRow('r_wide', '我想看Ｂ bear相关的猫')) // 命中「猫」类目
  assert.equal(wide?.category, '动物与植物')
  const long = '我想看' + '猫'.repeat(210)
  const material = extractReplyMaterial(replyRow('r_long', long))
  assert.ok(material)
  assert.ok([...material.text].length <= 200)
})

test('幂等 id 由 reply.id 派生，草稿携带溯源且不塞标记进文本', () => {
  assert.equal(replyWishId('r_abc'), 'wish_reply_r_abc')
  const material = extractReplyMaterial(replyRow('r_abc', '我想看下雪的地方'))
  const draft = buildReplyWishDraft(material, 'dog_b8', NOW)
  assert.equal(draft.id, 'wish_reply_r_abc')
  assert.equal(draft.originReplyId, 'r_abc')
  assert.equal(draft.source, 'reply')
  assert.equal(draft.sourceUrl, null)
  assert.equal(draft.revokedAt, null)
  assert.equal(draft.createdAt, '2026-11-26T03:00:00.000Z')
  assert.equal(draft.text.includes('r_abc'), false, '溯源不得污染搜索词')
  assert.deepEqual(
    buildReplyWishDraft(material, 'dog_b8', NOW),
    draft,
    '同一回应两次构造完全一致',
  )
})

test('屏蔽优先：命中已屏蔽主题的材料不进入下次出行', () => {
  const material = extractReplyMaterial(replyRow('r_block', '我想看下雪的地方'))
  assert.equal(isMaterialBlocked(material, ['雪']), true)
  assert.equal(isMaterialBlocked(material, ['秋天的树']), false)
})

// ---- 写入守卫与幂等（关键） ----

test('当前 main schema 前置未满足：明确 blocked，一行不写', () => {
  const db = tempDb(false)
  dogRow(db)
  const detected = detectReplyWishSchema(db)
  assert.equal(detected.supported, false)
  assert.deepEqual(detected.missing, ['wish.origin_reply_id', "wish.source CHECK 增加 'reply'"])
  const result = materializeReplyWish(db, replyRow('r_main', '我想看下雪的地方'), 'dog_b8', { now: NOW })
  assert.deepEqual(result, {
    kind: 'blocked',
    reason: 'schema-precondition-missing',
    missing: ['wish.origin_reply_id', "wish.source CHECK 增加 'reply'"],
  })
  assert.equal(db.prepare('SELECT count(*) AS n FROM wish').get().n, 0, '绝不降级写 owner/collection')
  db.close()
})

test('vNext schema：首次写入、同回应重复回放、不写第二条', () => {
  const db = tempDb(true)
  dogRow(db)
  assert.equal(detectReplyWishSchema(db).supported, true)
  const reply = replyRow('r_vnext', '它，好想再看一次下雪的地方啊')
  const first = materializeReplyWish(db, reply, 'dog_b8', { now: NOW })
  assert.equal(first.kind, 'materialized')
  assert.equal(first.wish.id, 'wish_reply_r_vnext')
  assert.equal(first.wish.originReplyId, 'r_vnext')
  const replay = materializeReplyWish(db, reply, 'dog_b8', { now: NOW })
  assert.equal(replay.kind, 'replay')
  assert.equal(replay.wish.id, first.wish.id)
  assert.equal(replay.wish.createdAt, first.wish.createdAt, '回放不刷新首次时间')
  assert.equal(db.prepare('SELECT count(*) AS n FROM wish').get().n, 1)
  db.close()
})

test('vNext schema：纯照片/纯情绪/被屏蔽均跳过，不产生 wish', () => {
  const db = tempDb(true)
  dogRow(db, 'dog_b8', JSON.stringify(['雪']))
  assert.equal(materializeReplyWish(db, replyRow('r_p', null, '/x.webp'), 'dog_b8', { now: NOW }).kind, 'skipped')
  assert.equal(materializeReplyWish(db, replyRow('r_e', '好的'), 'dog_b8', { now: NOW }).kind, 'skipped')
  const blocked = materializeReplyWish(db, replyRow('r_b', '我想看下雪的地方'), 'dog_b8', { now: NOW })
  assert.deepEqual(blocked, { kind: 'skipped', reason: 'blocked' })
  assert.equal(db.prepare('SELECT count(*) AS n FROM wish').get().n, 0)
  db.close()
})

test('因果链可查：trip.wish_id → wish.origin_reply_id → reply.id', () => {
  const db = tempDb(true)
  dogRow(db)
  const reply = replyRow('r_chain', '我想学做家常菜')
  db.prepare('INSERT INTO reply (id, invitation_id, text, created_at) VALUES (?, ?, ?, ?)')
    .run(reply.id, reply.invitationId, reply.text, reply.createdAt)
  const result = materializeReplyWish(db, reply, 'dog_b8', { now: NOW })
  assert.equal(result.kind, 'materialized')
  db.exec('CREATE TABLE trip (id TEXT PRIMARY KEY, dog_id TEXT, wish_id TEXT)')
  db.prepare('INSERT INTO trip (id, dog_id, wish_id) VALUES (?, ?, ?)').run('trip_1', 'dog_b8', result.wish.id)
  const row = db.prepare(`
    SELECT r.text AS reply_text, w.text AS wish_text
    FROM trip t JOIN wish w ON w.id = t.wish_id JOIN reply r ON r.id = w.origin_reply_id
    WHERE t.id = ?
  `).get('trip_1')
  assert.deepEqual({ ...row }, { reply_text: '我想学做家常菜', wish_text: '学做家常菜' })
  db.close()
})
