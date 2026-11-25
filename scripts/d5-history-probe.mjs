#!/usr/bin/env node
// d5 · 历史固定探针 / 回归（A 11-24 复核项）
//
// 它只回答一件事：
//   一趟旧 trip 已经发生过、旧 snapshot 也已经写下；
//   此后事件模板的文案被改掉；
//   下一次给同一只狗派生**新版本**时，那趟旧 trip 的摘要会不会变？
//
// 该不变。变了就说明「历史没固定」—— 旧版本没被覆盖只是把问题推迟了一次派生。
//
// 11-24 G2 之后，这个探针**不再自造事实表**：走的是真链路
//   v7 接口库（openD5InterfaceDatabase）
//   → C4 create/start/finish（真 trip）
//   → C7 选择器写 trip_event（触发器顺手捕获 trip_event_fact）
//   → D 的 deriveSnapshot + A 的 readOccurrenceFact
// 自造一张事实表能证明「读取器写得对」，但证明不了「链路真的捕获了」—— 后者才是 A 要的。
//
// 用法：
//   node scripts/d5-history-probe.mjs                 # 期望：历史已固定（绿）；没固定 → 退出码 1
//   node scripts/d5-history-probe.mjs --allow-open-gap
//                                                     # 已知未修时的巡检：缺口仍开着也退出 0
//   node scripts/d5-history-probe.mjs --keep <dir>    # 保留探针库，便于人工查
//
// 这个脚本**不写业务库、不连网络**：所有数据在临时目录里现造，跑完即删。
//
// 判定口径（与 A 一致，不另行发明）：
//   ① 已存 snapshot 不被改写 —— 主键 + 只插不改，这条早就成立；
//   ② 同一旧 trip 进**新**版本的摘要不变 —— 这才是「历史固定」。
// 只有 ①② 同时成立才算修好。①成立不能拿来交差。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const { openD5InterfaceDatabase } = await load('lib/db/d5-interface.ts')
const { readOccurrenceFact } = await load('lib/trips/occurrence-facts.ts')
const { deriveSnapshot, toFixedSnapshot } = await load('lib/social/snapshot-derive.ts')
const { createTripService } = await load('lib/trips/service.ts')
const { createTripEventSelector } = await load('lib/events/select.ts')
const { ownedDog } = await load('tests/helpers/mailbox-fixtures.mjs')

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const valueOf = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const KEEP = valueOf('--keep')
const DIR = KEEP ? path.resolve(KEEP) : fs.mkdtempSync(path.join(os.tmpdir(), 'd5-history-probe-'))
fs.mkdirSync(DIR, { recursive: true })
const DB = path.join(DIR, 'probe.sqlite')

const AT = '2026-11-24T03:00:00.000Z'
const now = () => new Date(AT)
const EDITED = '（改过的文案）路口的风很大。'

// ── 1. v7 接口库：真实迁移，不是拼出来的表 ──────────────────────────────────
let db = openD5InterfaceDatabase(DB)
try {
  db.exec(fs.readFileSync(path.join(ROOT, 'team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql'), 'utf8'))
  // 只留一条事件，让选择器没有第二种可能。选哪条不重要，重要的是「它真的被选中并捕获」。
  db.exec(`UPDATE event SET enabled = CASE WHEN code = 'any_shop_cat' THEN 1 ELSE 0 END`)

  const owner = ownedDog(db, 'probe-owner')
  const trips = createTripService(db, { now })
  const trip = trips.create(owner.id, owner.sessionId, 'auto')
  trips.start(trip.id, owner.sessionId)
  const selected = createTripEventSelector(db, { now, random: () => 0 })({
    dogId: owner.id,
    tripId: trip.id,
    sessionId: owner.sessionId,
    conditions: { sceneFile: 'scenes/nantou.png', season: 'spring', weather: 'clear', timeOfDay: 'morning' },
  })
  if (!selected) throw new Error('C7 没有选中任何事件 —— 探针前提不成立（不是历史固定的问题）')
  trips.finish(trip.id, owner.sessionId, 'done')

  // ── 2. 第一次派生 → 写成 v1（模拟 C 在出发事务里落版本） ───────────────────
  const derivedV1 = deriveSnapshot(db, owner.id, { occurrenceFacts: readOccurrenceFact })
  const v1 = toFixedSnapshot(derivedV1, { dogId: owner.id, version: 1, createdAt: AT })
  db.prepare(
    `INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    v1.dogId,
    v1.version,
    JSON.stringify(v1.personalityTags),
    v1.interestCategories === null ? null : JSON.stringify(v1.interestCategories),
    JSON.stringify(v1.recentTrips),
    v1.waitingFor,
    v1.createdAt,
  )
  const v1Text = v1.recentTrips[0] ?? null
  const factBefore = readOccurrenceFact(db, trip.id, owner.id)

  // ── 3. 改事件模板（运营改文案，完全正常的一次操作） ────────────────────────
  db.exec(`UPDATE event SET text = '${EDITED}', code = 'edited_code' WHERE id = '${selected.eventId}'`)

  // ── 4. 第二次派生（新版本 v2）：同一趟旧 trip，摘要该不该变？ ──────────────
  const derivedV2 = deriveSnapshot(db, owner.id, { occurrenceFacts: readOccurrenceFact })
  const v2Text = derivedV2.body.recentTrips[0] ?? null
  const v2Trip = derivedV2.evidence.trips.find((t) => t.tripId === trip.id)
  const factAfter = readOccurrenceFact(db, trip.id, owner.id)

  // ── 5. 已存的 v1 有没有被改写 ─────────────────────────────────────────────
  const kept = db.prepare(`SELECT recent_trips FROM snapshot WHERE dog_id = ? AND version = 1`).get(owner.id)
  const keptText = JSON.parse(kept.recent_trips)[0] ?? null

  const snapshotKept = keptText === v1Text
  const tripStable = v2Text === v1Text
  const factStable = JSON.stringify(factBefore) === JSON.stringify(factAfter)
  const gapOpen = !tripStable || !factStable

  const line = (ok, label, detail = '') => `${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`

  console.log(`探针库：${DB}${KEEP ? '（已保留）' : '（临时，跑完删）'}`)
  console.log(`  狗 ${owner.id} / 旅途 ${trip.id} seq${trip.seq} done / 事件 ${selected.eventId}\n`)

  console.log('① 已存 snapshot 是否被改写')
  console.log(line(snapshotKept, 'v1 仍是当时那句', snapshotKept ? '' : `→ 变成「${keptText}」`))
  console.log(`     当时：${v1Text}`)
  console.log(`     现在：${keptText}\n`)

  console.log('② 同一旧 trip 进**新版本**时，摘要是否稳定')
  console.log(line(tripStable, '模板改文案 + 改 code 后，旧 trip 摘要不变', tripStable ? '' : '→ 跟着变了'))
  console.log(`     v1：${v1Text}`)
  console.log(`     v2：${v2Text}`)
  console.log(`     来源标注：${v2Trip?.textSource}（factSourceId ${v2Trip?.factSourceId ?? 'null'}），本批 historyFixed=${derivedV2.evidence.historyFixed}\n`)

  console.log('③ 发生当时那份事实本身是否稳定（改模板不该动它）')
  console.log(line(factStable, 'readOccurrenceFact 前后一致', factStable ? '' : `→ ${JSON.stringify(factBefore)} → ${JSON.stringify(factAfter)}`))
  console.log(`     ${factAfter ? JSON.stringify(factAfter) : 'null'}\n`)

  if (gapOpen) {
    console.log('结论：历史未固定。')
    console.log('  这不是格式问题：快照描述的是「它当时看见了什么」，不是「我们现在怎么写这件事」。')
    console.log('  检查 C 的 trip_event_fact 捕获触发器是否真的写了行，以及 adapter 是否指到 v_trip_event_history。\n')
  } else {
    console.log('结论：历史已固定 —— 改文案 / 改 code 都不影响旧 trip，旧版本同时保持不变。\n')
  }

  // 退出码表达事实：缺口还开着就是 1。
  // `--allow-open-gap`（旧名 --expect-open-gap）用于「确认缺口仍在」的巡检，避免把已知未修报成红。
  const allowOpen = has('--allow-open-gap') || has('--expect-open-gap')
  process.exitCode = gapOpen ? (allowOpen ? 0 : 1) : 0
} finally {
  if (db.isOpen) db.close()
  if (!KEEP) fs.rmSync(DIR, { recursive: true, force: true })
}
