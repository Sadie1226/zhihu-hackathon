/**
 * snapshot.ts 的用例。**分两段跑**（和 gift.test.ts 同一个理由）：
 *
 *   A 段 · 纯函数 —— 形状与白名单，不起库
 *   B 段 · 真库 —— 同一份值能不能落进 `contracts/schema.sql` 的 snapshot 表
 *
 * 为什么 B 段不能省：A 段过只说明「我认为它合规」。库里有 CHECK 与触发器，
 * 我认为合规、库不收，一样是坏的 —— 而且会在 11-23 生成种子数据时才炸。
 *
 * 跑法：node --experimental-strip-types lib/social/snapshot.test.ts
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  MAX_RECENT_TRIPS,
  TRIP_SUMMARY_MAX,
  WAITING_FOR_MAX,
  nextVersion,
  validateSnapshot,
} from './snapshot.ts'
import type { Snapshot } from './snapshot.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA = fs.readFileSync(path.resolve(HERE, '../../contracts/schema.sql'), 'utf8')

const T0 = '2026-11-21T08:00:00Z'
const DOG = 'dog_seed_07'

// ===========================================================================
// 断言器
// ===========================================================================

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    pass += 1
    console.log(`  ✅ ${name}`)
  } catch (err) {
    fail += 1
    failures.push(`${name}\n    ${(err as Error).message.split('\n').join('\n    ')}`)
    console.log(`  ❌ ${name}`)
  }
}

/** 一份合法的底稿。每个用例改一处，只改一处 —— 这样红了能立刻知道是哪条规则。 */
function draft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dogId: DOG,
    version: 1,
    personalityTags: ['看人', '婉转', '当下'],
    interestCategories: ['人与故事', '手作与食物', '动物与植物'],
    recentTrips: ['在旧书店门口站了一会儿'],
    waitingFor: null,
    createdAt: T0,
    ...over,
  }
}

function expectOk(over: Record<string, unknown> = {}): Snapshot {
  const r = validateSnapshot(draft(over))
  assert.equal(r.ok, true, `应当通过，实际被拒：${r.ok ? '' : `${r.code} ${r.path} ${r.reason}`}`)
  return (r as { ok: true; value: Snapshot }).value
}

function expectReject(over: Record<string, unknown>, code: string): void {
  const r = validateSnapshot(draft(over))
  assert.equal(r.ok, false, `应当被拒（${code}），实际通过了`)
  const bad = r as { ok: false; code: string; path: string; reason: string }
  assert.equal(bad.code, code, `拒绝码应为 ${code}，实际 ${bad.code}（${bad.reason}）`)
}

// ===========================================================================
// A 段 · 纯函数
// ===========================================================================

console.log('\nA 段 · 形状与白名单')

check('A1 合法快照 → 通过，字段原样', () => {
  const s = expectOk()
  assert.equal(s.dogId, DOG)
  assert.equal(s.version, 1)
  assert.deepEqual(s.personalityTags, ['看人', '婉转', '当下'])
  assert.deepEqual(s.interestCategories, ['人与故事', '手作与食物', '动物与植物'])
  assert.deepEqual(s.recentTrips, ['在旧书店门口站了一会儿'])
  assert.equal(s.waitingFor, null)
})

check('A2 多一个键 → UNKNOWN_KEY（白名单是主防线，不是关键词黑名单）', () => {
  expectReject({ chatSummary: '主人今天说他很累' }, 'UNKNOWN_KEY')
})

check('A3 少一个键 → MISSING_FIELD', () => {
  const d = draft()
  delete (d as Record<string, unknown>).waitingFor
  const r = validateSnapshot(d)
  assert.equal(r.ok, false)
  assert.equal((r as { ok: false; code: string }).code, 'MISSING_FIELD')
})

check('A4 不是对象 / 是数组 → WRONG_TYPE', () => {
  assert.equal((validateSnapshot(null) as { ok: false; code: string }).code, 'WRONG_TYPE')
  assert.equal((validateSnapshot([]) as { ok: false; code: string }).code, 'WRONG_TYPE')
  assert.equal((validateSnapshot('x') as { ok: false; code: string }).code, 'WRONG_TYPE')
})

check('A5 标签 2 个 / 4 个 → BAD_TAG_COUNT', () => {
  expectReject({ personalityTags: ['看人', '婉转'] }, 'BAD_TAG_COUNT')
  expectReject({ personalityTags: ['看人', '婉转', '当下', '好奇'] }, 'BAD_TAG_COUNT')
})

check('A6 标签不在 12 个里 → BAD_TAG', () => {
  expectReject({ personalityTags: ['看人', '婉转', '温柔'] }, 'BAD_TAG')
})

check('A7 两个标签同维度（互斥对）→ TAG_SAME_DIMENSION', () => {
  // 看人 / 看物 是同一维度的两极
  expectReject({ personalityTags: ['看人', '看物', '当下'] }, 'TAG_SAME_DIMENSION')
})

check('A8 兴趣 null → 通过（「没限制」不是「什么都没有」）', () => {
  const s = expectOk({ interestCategories: null })
  assert.equal(s.interestCategories, null)
})

check('A9 兴趣 [] → BAD_INTEREST（空数组不等于 null）', () => {
  expectReject({ interestCategories: [] }, 'BAD_INTEREST')
})

check('A10 兴趣 1 个 / 4 个 → BAD_INTEREST', () => {
  expectReject({ interestCategories: ['人与故事'] }, 'BAD_INTEREST')
  expectReject(
    { interestCategories: ['人与故事', '手作与食物', '动物与植物', '冷知识'] },
    'BAD_INTEREST',
  )
})

check('A11 兴趣不在六类 → BAD_INTEREST', () => {
  expectReject({ interestCategories: ['人与故事', '风景'] }, 'BAD_INTEREST')
})

check('A12 兴趣重复 → BAD_INTEREST', () => {
  expectReject({ interestCategories: ['人与故事', '人与故事'] }, 'BAD_INTEREST')
})

check(`A13 recentTrips ${MAX_RECENT_TRIPS + 1} 条 → TOO_MANY_TRIPS`, () => {
  const tooMany = Array.from({ length: MAX_RECENT_TRIPS + 1 }, (_, i) => `第 ${i + 1} 条`)
  expectReject({ recentTrips: tooMany }, 'TOO_MANY_TRIPS')
})

check('A14 recentTrips 允许 0 条（新狗还没出过门）→ 通过', () => {
  const s = expectOk({ recentTrips: [] })
  assert.deepEqual(s.recentTrips, [])
})

check('A15 recentTrips 某条空串 → EMPTY_STRING', () => {
  expectReject({ recentTrips: ['  '] }, 'EMPTY_STRING')
})

check(`A16 recentTrips 某条超过 ${TRIP_SUMMARY_MAX} 字 → TOO_LONG（摘要不许变成原文）`, () => {
  expectReject({ recentTrips: ['看'.repeat(TRIP_SUMMARY_MAX + 1)] }, 'TOO_LONG')
  // 刚好等于上限要放行，别把边界也拦了
  expectOk({ recentTrips: ['看'.repeat(TRIP_SUMMARY_MAX)] })
})

check('A17 waitingFor 空串 → EMPTY_STRING，超长 → TOO_LONG', () => {
  expectReject({ waitingFor: '' }, 'EMPTY_STRING')
  expectReject({ waitingFor: '等'.repeat(WAITING_FOR_MAX + 1) }, 'TOO_LONG')
  expectOk({ waitingFor: '等一条围巾的回音' })
})

check('A18 version 0 / 负数 / 小数 / 字符串 → BAD_VERSION', () => {
  expectReject({ version: 0 }, 'BAD_VERSION')
  expectReject({ version: -1 }, 'BAD_VERSION')
  expectReject({ version: 1.5 }, 'BAD_VERSION')
  expectReject({ version: '1' }, 'BAD_VERSION')
})

check('A19 nextVersion：没有旧版是 1，有则 +1', () => {
  assert.equal(nextVersion(null), 1)
  assert.equal(nextVersion(1), 2)
  assert.equal(nextVersion(7), 8)
})

// ===========================================================================
// B 段 · 真库
// ===========================================================================

console.log('\nB 段 · 真库（contracts/schema.sql）')

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  db.prepare(
    `INSERT INTO dog
       (id, name, session_id, personality_tags, interest_categories,
        assembly, is_sample, blocked_topics, created_at)
     VALUES (?, NULL, 'seed', ?, ?, ?, 1, '[]', ?)`,
  ).run(
    DOG,
    JSON.stringify(['看人', '婉转', '当下']),
    JSON.stringify(['人与故事', '手作与食物', '动物与植物']),
    JSON.stringify({ outfit: null, cloth: 'S02-leaf-cape', accessory: null, face: 'F01-neutral' }),
    T0,
  )
  return db
}

function insertSnapshot(db: DatabaseSync, s: Snapshot): void {
  db.prepare(
    `INSERT INTO snapshot
       (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.dogId,
    s.version,
    JSON.stringify(s.personalityTags),
    s.interestCategories === null ? null : JSON.stringify(s.interestCategories),
    JSON.stringify(s.recentTrips),
    s.waitingFor,
    s.createdAt,
  )
}

check('B1 校验通过的值能落库，读回来一致', () => {
  const db = freshDb()
  const s = expectOk()
  insertSnapshot(db, s)
  const row = db
    .prepare(`SELECT * FROM snapshot WHERE dog_id = ? AND version = 1`)
    .get(DOG) as Record<string, unknown>
  assert.equal(row.dog_id, DOG)
  assert.deepEqual(JSON.parse(String(row.personality_tags)), ['看人', '婉转', '当下'])
  assert.deepEqual(JSON.parse(String(row.interest_categories)), ['人与故事', '手作与食物', '动物与植物'])
  assert.deepEqual(JSON.parse(String(row.recent_trips)), ['在旧书店门口站了一会儿'])
  assert.equal(row.waiting_for, null)
  db.close()
})

check('B2 兴趣 null 能落库（库里是 NULL，不是 \'[]\'）', () => {
  const db = freshDb()
  insertSnapshot(db, expectOk({ interestCategories: null }))
  const row = db.prepare(`SELECT interest_categories FROM snapshot`).get() as {
    interest_categories: string | null
  }
  assert.equal(row.interest_categories, null)
  db.close()
})

check('B3 新版本能共存：v1 与 v2 是两行，旧版不被覆盖', () => {
  const db = freshDb()
  insertSnapshot(db, expectOk({ version: 1 }))
  insertSnapshot(db, expectOk({ version: 2, waitingFor: '等一条围巾的回音' }))
  const n = db.prepare(`SELECT COUNT(*) AS n FROM snapshot`).get() as { n: number }
  assert.equal(Number(n.n), 2)
  db.close()
})

// ---- 下面三条证明「本文件的校验不是多余的」：库会拦的东西，它也拦；库不拦的，它也拦 ----

check('B4 库会拦 4 条 recent_trips —— 本文件在写库前就拦了', () => {
  const db = freshDb()
  const s = expectOk({ recentTrips: ['一', '二', '三'] })
  insertSnapshot(db, s)
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
           VALUES (?, 2, '["看人","婉转","当下"]', NULL, '["一","二","三","四"]', NULL, ?)`,
        )
        .run(DOG, T0),
    /snapshot|CHECK|constraint/i,
  )
  // 而本文件对同一份值给的是 TOO_MANY_TRIPS，不是等库报错
  expectReject({ recentTrips: ['一', '二', '三', '四'] }, 'TOO_MANY_TRIPS')
  db.close()
})

check('B5 库会拦兴趣 [] —— 本文件也拦（BAD_INTEREST）', () => {
  const db = freshDb()
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
           VALUES (?, 1, '["看人","婉转","当下"]', '[]', '[]', NULL, ?)`,
        )
        .run(DOG, T0),
    /snapshot|CHECK|constraint/i,
  )
  expectReject({ interestCategories: [] }, 'BAD_INTEREST')
  db.close()
})

check('B6 库只查「3 个标签」，不查它们合不合法 —— 本文件比库严', () => {
  const db = freshDb()
  // 三个都不存在、且全在一个维度：schema 的 CHECK 只数长度，照收
  db.prepare(
    `INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
     VALUES (?, 1, '["温柔","善良","可爱"]', NULL, '[]', NULL, ?)`,
  ).run(DOG, T0)
  const n = db.prepare(`SELECT COUNT(*) AS n FROM snapshot`).get() as { n: number }
  assert.equal(Number(n.n), 1, '库确实收了这三个假标签')

  // 本文件拒 —— 这一条就是「只靠库不够」的证据
  expectReject({ personalityTags: ['温柔', '善良', '可爱'] }, 'BAD_TAG')
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
