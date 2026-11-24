#!/usr/bin/env node
// d5 · 历史固定探针 / 回归（A 11-24 复核项）
//
// 它只回答一件事：
//   一趟旧 trip 已经发生过、旧 snapshot 也已经写下；
//   此后事件模板的文案被改掉；
//   下一次给同一只狗派生**新版本**时，那趟旧 trip 的摘要会不会变？
//
// 该不变。变了就说明「历史没固定」——旧版本没被覆盖只是把问题推迟了一次派生。
//
// 用法：
//   node scripts/d5-history-probe.mjs                 # 正常模式：摘要变了 → 退出码 1（回归失败）
//   node scripts/d5-history-probe.mjs --expect-open-gap
//                                                     # 已知缺口模式：确认缺口仍在 → 退出码 0
//   node scripts/d5-history-probe.mjs --keep <dir>    # 保留探针库，便于人工查
//
// 这个脚本**不写业务库、不连网络**：所有数据在临时目录里现造，跑完即删。
//
// 判定口径（与 A 一致，不另行发明）：
//   ① 已存 snapshot 不被改写 —— 主键 + 只插不改，这条早就成立；
//   ② 同一旧 trip 进**新**版本的摘要不变 —— 这才是「历史固定」，目前不成立。
// 只有 ①② 同时成立才算修好。①成立不能拿来交差。

import fs from 'node:fs'
import { initializeDiagnosticSeeds } from './d5-diagnostic-seeds.mjs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { deriveAllSnapshots } = await import(pathToFileURL(path.join(ROOT, 'lib/social/snapshot-derive.ts')).href)

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
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.unlinkSync(DB + suffix)
  } catch {
    /* 不存在就算了 */
  }
}

const DOG = 'dog_seed_07'
const TRIP = 'probe_trip_1'
const EVENT = 'probe_event'
const AT_OCCURRENCE = '2026-11-24T03:00:00Z'
const ORIGINAL = '路口的风把梧桐叶吹得翻了个面。'
const EDITED = '（改过的文案）路口的风很大。'

const db = new DatabaseSync(DB)
db.exec('PRAGMA foreign_keys = ON')
initializeDiagnosticSeeds(db)

// ── 1. 一趟真实形状的旅途发生，写下当时那句话 ────────────────────────────────
db.exec(`INSERT INTO trip (id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
         VALUES ('${TRIP}','${DOG}',1,'done','auto','${AT_OCCURRENCE}','${AT_OCCURRENCE}','2026-11-24T04:00:00Z')`)
db.exec(`INSERT INTO event (id,code,text,season,weather,time_of_day,place_tags)
         VALUES ('${EVENT}','probe_wind','${ORIGINAL}','any','any','any','[]')`)
db.exec(`INSERT INTO trip_event (trip_id,event_id,dog_id,happened_at)
         VALUES ('${TRIP}','${EVENT}','${DOG}','${AT_OCCURRENCE}')`)

// ── 2. 第一次派生 → 写成 v1（模拟 C 在出发事务里落版本） ─────────────────────
const v1 = deriveAllSnapshots(db).find((r) => r.evidence.dogId === DOG)
const v1Text = v1.body.recentTrips[0] ?? null
db.prepare(
  `INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
   VALUES (?, 1, ?, NULL, ?, NULL, ?)`,
).run(DOG, JSON.stringify(v1.body.personalityTags), JSON.stringify(v1.body.recentTrips), AT_OCCURRENCE)

// ── 3. 改事件模板（运营改文案，完全正常的一次操作） ──────────────────────────
db.exec(`UPDATE event SET text = '${EDITED}' WHERE id = '${EVENT}'`)

// ── 4. 第二次派生（新版本 v2）：同一趟旧 trip，摘要该不该变？ ────────────────
const v2 = deriveAllSnapshots(db).find((r) => r.evidence.dogId === DOG)
const v2Text = v2.body.recentTrips[0] ?? null
const v2Trip = v2.evidence.trips.find((t) => t.tripId === TRIP)

// ── 5. 已存的 v1 有没有被改写 ───────────────────────────────────────────────
const kept = db.prepare(`SELECT recent_trips FROM snapshot WHERE dog_id = ? AND version = 1`).get(DOG)
const keptText = JSON.parse(kept.recent_trips)[0] ?? null

db.close()

const snapshotKept = keptText === v1Text
const tripStable = v2Text === v1Text
const gapOpen = !tripStable

const line = (ok, label, detail = '') =>
  `${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`

console.log(`探针库：${DB}${KEEP ? '（已保留）' : '（临时，跑完删）'}\n`)
console.log(`  狗 ${DOG} / 旅途 ${TRIP} seq1 done / 事件 ${EVENT} @ ${AT_OCCURRENCE}\n`)
console.log('① 已存 snapshot 是否被改写')
console.log(line(snapshotKept, 'v1 仍是当时那句', snapshotKept ? '' : `→ 变成「${keptText}」`))
console.log(`     当时：${v1Text}`)
console.log(`     现在：${keptText}\n`)

console.log('② 同一旧 trip 进**新版本**时，摘要是否稳定')
console.log(line(tripStable, '模板改文案后，旧 trip 摘要不变', tripStable ? '' : '→ 跟着变了'))
console.log(`     v1：${v1Text}`)
console.log(`     v2：${v2Text}`)
console.log(
  `     来源标注：${v2Trip?.textSource}（factSourceId ${v2Trip?.factSourceId ?? 'null'}），` +
    `本批 historyFixed=${v2.evidence.historyFixed}\n`,
)

if (gapOpen) {
  console.log('结论：历史未固定。')
  console.log('  已存版本没被覆盖（①成立），但「同一次发生」在新派生里换了话。')
  console.log('  这不是格式问题：快照描述的是「它当时看见了什么」，不是「我们现在怎么写这件事」。')
  console.log('  修法在 C 侧：发生当时固定一份公开文本 + 来源标识；D 侧读取器接缝已留好')
  console.log('  （lib/social/snapshot-derive.ts 的 OccurrenceFactReader），接上后本探针即转绿。\n')
} else {
  console.log('结论：历史已固定 —— 改文案不影响旧 trip，旧版本同时保持不变。\n')
}

if (!KEEP) fs.rmSync(DIR, { recursive: true, force: true })

// 退出码表达事实：缺口还开着就是 1。
// `--expect-open-gap` 用于「确认缺口仍在」的巡检场景，避免把已知未修报成红。
process.exitCode = gapOpen ? (has('--expect-open-gap') ? 0 : 1) : 0
