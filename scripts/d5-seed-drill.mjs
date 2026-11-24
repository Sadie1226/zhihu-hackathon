#!/usr/bin/env node
// d5 · 种子狗真实出行演练（可复跑）
//
// A 11-24 要求：「你自建库通过 C8 入口的结果有价值，请补可复跑脚本 / 具体 trip 和空结果原因。」
// 这个脚本就是那条命令。它做的事很窄：
//
//   1. 把 C8 分支的代码导到临时目录（不 checkout、不动你的工作区）；
//   2. 在**隔离的 sqlite 文件**里，用 C8 的 `createSeedTripRunner`（可信入口，
//      不是往 trip 表插行）给指定几只种子狗各跑一趟：create → start → finish('done')；
//   3. 用 D 的派生器只读读一遍，逐趟列 trip.id / seq / status / 时间 / 事件 / Find；
//   4. 没事件、没 Find 的，直说空在哪里（不是每只都该有）。
//
// 它**不是** C8 验收，也不是 D5 联合验收：
//   · 时钟是造的（`--now` 控制），不是真实时间；
//   · 环境中没有 C7 场景选择器，所以事件空是**预期的**，不代表链路上线；
//   · 联合验收以 A 指定库 `E:\Hackathon\validation-1124\d5-acceptance\app.sqlite` 为准。
//
// 用法：
//   node scripts/d5-seed-drill.mjs                       # 5 只默认狗，临时库，跑完删
//   node scripts/d5-seed-drill.mjs --keep                # 保留库与导出目录，打印路径
//   node scripts/d5-seed-drill.mjs --dogs dog_seed_01,07 --keep --out drill.json
//   node scripts/d5-seed-drill.mjs --c8-ref origin/c8-seed-trigger-1124
//
// 输出里每只狗一行，`事件 -` / `Find -` 就是「这趟真的什么都没发生」，不补、不往前捞。

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { deriveAllSnapshots } = await import(pathToFileURL(path.join(ROOT, 'lib/social/snapshot-derive.ts')).href)

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const valueOf = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const REF = valueOf('--c8-ref') ?? 'origin/c8-seed-trigger-1124'
const DOGS = (valueOf('--dogs') ?? 'dog_seed_01,dog_seed_05,dog_seed_07,dog_seed_12,dog_seed_18')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const KEEP = has('--keep')
const OUT = valueOf('--out')
const CLOCK = valueOf('--now') ?? '2026-11-24T00:00:00.000Z'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-seed-drill-'))
const srcDir = path.join(work, 'c8')
const dbPath = path.resolve(valueOf('--db') ?? path.join(work, 'drill.sqlite'))
fs.mkdirSync(srcDir, { recursive: true })

// ── 1. 导出 C8 那一版代码 ──────────────────────────────────────────────────
const refSha = execFileSync('git', ['rev-parse', REF], { cwd: ROOT, encoding: 'utf8' }).trim()
const tar = execFileSync('git', ['archive', REF], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 })
execFileSync('tar', ['-x', '-C', srcDir], { input: tar, maxBuffer: 256 * 1024 * 1024 })

// ── 2. 在导出目录里跑 C8 的可信入口 ────────────────────────────────────────
// 为什么另起进程：C8 的模块要从它自己那棵树的 lib/ 里 import，跟 D 现在的 lib/ 不共享。
const driver = path.join(srcDir, '_d5_drill_driver.mjs')
fs.writeFileSync(
  driver,
  `import { openDatabase } from './lib/db/bootstrap.ts'
import { createSeedTripRunner } from './lib/trips/seed-runner.ts'

const DB = ${JSON.stringify(dbPath)}
const DOGS = ${JSON.stringify(DOGS)}
const BASE = ${JSON.stringify(CLOCK)}

const db = openDatabase(DB)
db.exec(${JSON.stringify(fs.readFileSync(path.join(ROOT, 'team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql'), 'utf8'))})

const clock = { at: BASE }
const runner = createSeedTripRunner(db, { now: () => new Date(clock.at) })
const log = []
for (const [i, dogId] of DOGS.entries()) {
  const base = Date.parse(BASE)
  clock.at = new Date(base + i * 3600e3).toISOString()
  let entry = { dogId }
  try {
    const intent = runner(dogId, 'd5-drill:' + dogId)
    const pending = intent.create()
    const { trip } = intent.start()
    clock.at = new Date(base + i * 3600e3 + 10 * 60e3).toISOString()
    const done = intent.finish('done').trip
    entry = { ...entry, tripId: done.id, seq: done.seq, status: done.status, startedAt: done.startedAt, endedAt: done.endedAt, createStatus: pending.status, startStatus: trip.status }
  } catch (e) {
    entry.error = String(e && e.message ? e.message : e)
  }
  log.push(entry)
}
console.log(JSON.stringify(log))
db.close()
`,
)

const run = spawnSync(process.execPath, [driver], { cwd: srcDir, encoding: 'utf8' })
if (run.status !== 0) {
  console.error('C8 入口执行失败：')
  console.error((run.stderr || '').split('\n').filter((l) => !/Experimental|trace-warnings/.test(l)).join('\n'))
  process.exit(1)
}
const runs = JSON.parse(run.stdout.trim().split('\n').pop())

// ── 3. 用 D 的派生器只读读一遍 ────────────────────────────────────────────
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(dbPath, { readOnly: true })
db.exec('BEGIN')
const derived = deriveAllSnapshots(db)
db.exec('COMMIT')
const byDog = new Map(derived.map((r) => [r.evidence.dogId, r]))
const eventRows = db
  .prepare(`SELECT trip_id, event_id FROM trip_event`)
  .all()
const findRows = db.prepare(`SELECT trip_id, id, kind, source_mode FROM find`).all()
db.close()

const eventsOf = (tripId) => eventRows.filter((e) => e.trip_id === tripId)
const findsOf = (tripId) => findRows.filter((f) => f.trip_id === tripId)

// ── 4. 报告 ───────────────────────────────────────────────────────────────
console.log(`C8 参考：${REF} @ ${refSha.slice(0, 7)}`)
console.log(`库：${dbPath}（隔离，非验收库；时钟 ${CLOCK} 之后每只间隔 1 小时，固定步进）`)
console.log(`狗：${DOGS.join(' ')}\n`)

const rows = []
let withTrip = 0
let withEvent = 0
let withFind = 0

for (const r of runs) {
  if (r.error) {
    console.log(`${r.dogId}  ❌ ${r.error}`)
    rows.push({ ...r, emptyReason: 'run_failed' })
    continue
  }
  withTrip += 1
  const evs = eventsOf(r.tripId)
  const fnds = findsOf(r.tripId)
  if (evs.length) withEvent += 1
  if (fnds.length) withFind += 1

  const emptyReason = evs.length
    ? null
    : '这趟没有任何 trip_event：C7 场景选择器不在本次演练链路里（未入主干），事件条件链未接通 —— 不是「走访了没收获」'

  console.log(
    `${r.dogId}  ${r.tripId} seq${r.seq} ${r.status.padEnd(5)} ${r.startedAt}→${r.endedAt}` +
      `  事件 ${evs.length ? evs.map((e) => e.event_id).join(',') : '-'}` +
      `  Find ${fnds.length ? fnds.map((f) => `${f.id}[${f.kind}]`).join(',') : '-'}`,
  )
  if (emptyReason) console.log(`     ↳ 空的原因：${emptyReason}`)

  const d = byDog.get(r.dogId)
  if (d) {
    console.log(
      `     派生：${d.evidence.tripsConsidered} 趟 / 摘要 ${d.body.recentTrips.length} 条` +
        ` / historyFixed=${d.evidence.historyFixed}` +
        ` / waiting ${d.body.waitingFor ?? 'null'}`,
    )
  }
  rows.push({ ...r, events: evs.map((e) => e.event_id), finds: fnds.map((f) => f.id), emptyReason })
}

console.log(
  `\n小计：${runs.length} 只，成功出行 ${withTrip} 只；有事件 ${withEvent} 只；有 Find ${withFind} 只。`,
)
console.log(
  '说明：本演练的时钟与库都是造的，**不能**当作 C8 或 D5 联合验收；' +
    '\n      联合验收以 A 指定库为准（C 写完后 D 只读派生）。空事件是链路未接通，不是「狗什么也没看见」。',
)

const payload = {
  generatedAt: new Date().toISOString(),
  kind: 'd5-seed-drill',
  disclaimer: '受控演练：造出来的时钟 + 隔离库，不是验收库，不是真实在线来源。',
  c8Ref: REF,
  c8Sha: refSha,
  db: dbPath,
  clockBase: CLOCK,
  dogs: rows,
  totals: { dogs: runs.length, withTrip, withEvent, withFind },
}
if (OUT) {
  fs.writeFileSync(path.resolve(OUT), JSON.stringify(payload, null, 2) + '\n')
  console.log(`\n证据 JSON：${path.resolve(OUT)}`)
}

if (KEEP) console.log(`\n已保留：${work}`)
else fs.rmSync(work, { recursive: true, force: true })
