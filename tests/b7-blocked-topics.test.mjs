// B7「表达偏好与边界」可复验证据：
//  1) 规范化口径与 C 的 blockedBy 一致（NFKC + zh-CN 小写 + 子串）；
//  2) 屏蔽优先于心愿：命中屏蔽的心愿候选被判掉，不靠界面藏；
//  3) 真实 SQLite 下只写 dog.blocked_topics 一列、整列覆盖、owner 隔离；
//  4) 面板守卫：读取失败不可写（防覆盖旧词）、取消后在途态复位（防重开卡死）。
// 不测契约文本归属（C/D/E 的过滤实现不在 B），见回交文档。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { openDatabase } from '../lib/db/bootstrap.ts'
import {
  normalizeBlockedTopics, normalizeTopicKey, isBlocked,
  MAX_BLOCKED_TOPICS, MAX_TOPIC_LENGTH,
} from '../lib/preferences/blocked-topics.ts'
import { writeBlockedTopics, readBlockedTopics } from '../lib/preferences/blocked-topics-store.ts'
import { canWriteTopics, phaseAfterDeactivate } from '../lib/preferences/blocked-topics-ui.ts'

// ---- 规范化：与 C 同口径 ----

test('normalizeTopicKey 与 C 的 blockedBy 归一化同形', () => {
  assert.equal(normalizeTopicKey('Ｂ bear'), normalizeTopicKey('b bear'))
  assert.equal(normalizeTopicKey('猫'), normalizeTopicKey('猫'))
  assert.equal(normalizeTopicKey('ＡＢ'), 'ab')
})

test('规范化：trim、NFKC、按 NFKC+小写 key 去重，顺序稳定', () => {
  // Ｂ bear → NFKC → B bear（key 为 'b bear'）；与 'bear' 不是同一个词，保留。
  // '雪' 与 '雪 ' 归一后同 key，保留首次出现的 NFKC 原文，去掉后者。
  const result = normalizeBlockedTopics(['  雪  ', 'Ｂ bear', '雪 ', 'bear', '猫', '猫'])
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.topics, ['雪', 'B bear', 'bear', '猫'])
})

test('规范化：拒绝非数组、非字符串、空串', () => {
  for (const bad of [null, undefined, '雪', { topic: '雪' }, [1], ['雪', null], ['  ']]) {
    const result = normalizeBlockedTopics(bad)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'CONFLICT')
  }
})

test('规范化：超长与超量都拒绝，不静默丢弃已输入内容', () => {
  assert.equal(normalizeBlockedTopics(['x'.repeat(MAX_TOPIC_LENGTH + 1)]).ok, false)
  assert.equal(normalizeBlockedTopics(Array.from({ length: MAX_BLOCKED_TOPICS + 1 }, (_, i) => `词${i}`)).ok, false)
  assert.equal(normalizeBlockedTopics(Array.from({ length: MAX_BLOCKED_TOPICS }, (_, i) => `词${i}`)).ok, true)
})

// ---- 屏蔽优先于心愿 ----

test('isBlocked 命中子串：NFKC 全角与大小写不影响屏蔽', () => {
  assert.equal(isBlocked(['雪'], '下雪的地方'), true)
  assert.equal(isBlocked(['Ｂ bear'], '我看了一只b bear'), true)
  assert.equal(isBlocked(['雪'], '秋天的树'), false)
  assert.equal(isBlocked([' '], '任何文本'), false)
})

test('屏蔽优先于心愿：命中屏蔽词的心愿候选被判掉', () => {
  // 场景：主人心愿是「想看雪」，但同时屏蔽了「雪」——屏蔽胜出，该候选不进出行结果。
  const wishCandidate = { category: '自然风景', query: '下雪的地方' }
  const blocked = ['雪']
  assert.equal(isBlocked(blocked, wishCandidate.category, wishCandidate.query), true)
  // 未命中的候选仍可用，屏蔽不是「什么都不让它出门」。
  assert.equal(isBlocked(blocked, '自然风景', '秋天的树'), false)
})

// ---- 真实 SQLite：列独占与 owner 隔离 ----

const root = resolve('.local/b7-blocked-tests')
mkdirSync(root, { recursive: true })

function setup(t) {
  const directory = mkdtempSync(join(root, 'database-'))
  const db = openDatabase(join(directory, 'app.sqlite'))
  t.after(() => {
    if (db.isOpen) db.close()
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  const dog = (id, session, name, blocked) => db.prepare(
    `INSERT INTO dog(id,session_id,name,personality_tags,assembly,blocked_topics,created_at)
     VALUES(?,?,?,'["好奇","看物","直给"]',? ,?,?)`,
  ).run(id, session, name, '{"outfit":null,"cloth":"S02-leaf-cape","accessory":null,"face":"F01-neutral"}', blocked, '2026-11-25T00:00:00Z')
  dog('dog-a', 'session-a', '小雪', '[]')
  dog('dog-b', 'session-b', '小风', '[]')
  return { db }
}

test('写入只改 blocked_topics 一列：名字等其它列不动', t => {
  const { db } = setup(t)
  const before = db.prepare('SELECT name, blocked_topics AS raw FROM dog WHERE id=?').get('dog-a')
  assert.equal(before.name, '小雪')
  assert.equal(before.raw, '[]')

  const result = writeBlockedTopics(db, 'dog-a', 'session-a', ['雪'])
  assert.deepEqual(result, { ok: true, blockedTopics: ['雪'] })

  const after = db.prepare('SELECT name, blocked_topics AS raw FROM dog WHERE id=?').get('dog-a')
  assert.equal(after.name, '小雪', '写屏蔽不应改名字')
  assert.equal(after.raw, '["雪"]')
})

test('整列覆盖：再次写入替换旧主题，不追加', t => {
  const { db } = setup(t)
  writeBlockedTopics(db, 'dog-a', 'session-a', ['雪', '猫'])
  assert.deepEqual(readBlockedTopics(db, 'dog-a'), ['雪', '猫'])
  writeBlockedTopics(db, 'dog-a', 'session-a', ['海'])
  assert.deepEqual(readBlockedTopics(db, 'dog-a'), ['海'])
})

test('owner 隔离：跨 session 的 dogId 写入失败且不落库', t => {
  const { db } = setup(t)
  const result = writeBlockedTopics(db, 'dog-a', 'session-b', ['不该写入'])
  assert.deepEqual(result, { ok: false, code: 'NOT_FOUND', detail: '这只伙伴不在这里' })
  assert.deepEqual(readBlockedTopics(db, 'dog-a'), [], '跨主人写入不得改变目标狗')
  assert.deepEqual(readBlockedTopics(db, 'dog-b'), [], '也不得写到调用方自己的狗上')
})

test('读取：合法 JSON 数组里的非字符串项被过滤，不误当成屏蔽词', t => {
  const { db } = setup(t)
  db.prepare('UPDATE dog SET blocked_topics = ? WHERE id = ?').run('["雪", 3, null, "猫"]', 'dog-a')
  assert.deepEqual(readBlockedTopics(db, 'dog-a'), ['雪', '猫'])
})

// ---- 面板守卫：读取失败覆盖旧词 / 取消后重开卡状态 ----

test('读取失败或读取中禁止写入，只有 ready 且面板可见才允许', () => {
  // 读取失败 phase=error、读取中 loading、保存中 saving 一律不可写：
  // 否则用当时为空/不完整的 topics 做整列 PATCH 会清掉服务端已存的旧词。
  assert.equal(canWriteTopics('error', true), false, '读取失败不得写入')
  assert.equal(canWriteTopics('loading', true), false, '读取中不得写入')
  assert.equal(canWriteTopics('saving', true), false, '保存中不得重复写入')
  assert.equal(canWriteTopics('ready', false), false, '面板隐藏时不得写入')
  assert.equal(canWriteTopics('ready', true), true, '读取成功且可见才可写')
})

test('取消面板把在途 loading/saving 复位为 ready，稳定态不变', () => {
  // 取消时若正在保存，phase 会被打回 ready；重开重读拿到服务端真值，不会卡在 saving。
  assert.equal(phaseAfterDeactivate('loading'), 'ready')
  assert.equal(phaseAfterDeactivate('saving'), 'ready')
  assert.equal(phaseAfterDeactivate('ready'), 'ready')
  assert.equal(phaseAfterDeactivate('error'), 'error', '错误态保留提示，交重试处理')
})
