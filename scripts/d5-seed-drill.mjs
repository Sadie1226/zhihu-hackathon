#!/usr/bin/env node
// d5 · 种子狗真实出行演练（可复跑）
//
// A 11-24 要求：「你自建库通过 C8 入口的结果有价值，请补可复跑脚本 / 具体 trip 和空结果原因。」
// 这个脚本就是那条命令。它做的事很窄：
//
//   1. 把 C8 那一版代码取到临时 worktree（不 checkout 主工作区、不改本地分支）；
//   2. 在**隔离的 sqlite 文件**里，用 C8 的 `createSeedTripRunner`（可信入口，
//      不是往 trip 表插行）给指定几只种子狗各跑一趟：create → start → finish('done')；
//   3. 用 D 的派生器只读读一遍，逐趟列 trip.id / seq / status / 时间 / 事件 / Find；
//   4. 没事件、没 Find 的，直说空在哪里（不是每只都该有）。
//
// 它**不是** C8 验收，也不是 D5 联合验收：
//   · 时钟是造的（`--now` 控制），不是真实时间；
//   · 本次取的是 C8 分支那一版代码，它的 start 里没接 C7 选择器，所以事件空是**预期的**，
//     不代表链路上线；有事件时摘要也是模板态（演练库没升 v7），输出会标出来；
//   · 联合验收以 A 指定库为准（见 A 的 G4/G5 回执），不拿这个库冒充。
//
// 用法：
//   node scripts/d5-seed-drill.mjs                       # 5 只默认狗，临时库，跑完删
//   node scripts/d5-seed-drill.mjs --keep                # 保留库与 worktree，打印路径
//   node scripts/d5-seed-drill.mjs --dogs dog_seed_01,07 --keep --out drill.json
//   node scripts/d5-seed-drill.mjs --c8-ref origin/c8-seed-trigger-1124
//   node scripts/d5-seed-drill.mjs --c8-dir D:\some\checkout   # 手头已有那棵树，不必 git
//   node scripts/d5-seed-drill.mjs --db D:\out\drill.sqlite     # 指定库位置
//   node scripts/d5-seed-drill.mjs --db D:\out\drill.sqlite --force  # 库已存在时覆盖重跑
//
// Windows 上的三个坑（都在这份脚本里处理掉了，11-24 实测踩过）：
//   · **`git` 不在 PATH**：在 PS 里 `git` 常不在 PATH（只有 Git Bash 有），
//     `execFileSync('git', …)` 直接 `spawnSync git ENOENT`。现在先探几个常见安装位置，
//     探不到给出可直接照做的报错，而不是抛个 errno 让人猜。
//   · **中文 / 带空格路径**：从 `--db` / `--out` / `--c8-dir` 到临时目录全程走 `path.resolve`
//     与 UTF-8，不拼 shell 字符串（走 shell 才会在中文路径上炸）。
//   · **`tar` 不一定在**：不再依赖 `git archive | tar`，改用 `git worktree add --detach`，
//     只剩一个外部依赖（git），而且失败时好回滚。
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
const C8_DIR_ARG = valueOf('--c8-dir')
const DOGS = (valueOf('--dogs') ?? 'dog_seed_01,dog_seed_05,dog_seed_07,dog_seed_12,dog_seed_18')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const KEEP = has('--keep')
const FORCE = has('--force')
const OUT = valueOf('--out')
const CLOCK = valueOf('--now') ?? '2026-11-24T00:00:00.000Z'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-seed-drill-'))
const dbPath = path.resolve(valueOf('--db') ?? path.join(work, 'drill.sqlite'))

/**
 * 找 git。
 *
 * 直接 `execFileSync('git', …)` 在 PowerShell 里会炸：这台机器的 git 只在 Git Bash 的
 * PATH 里，PowerShell 的 PATH 没有它，Node 拿到的是 `spawnSync git ENOENT` ——
 * 报错信息里既没有「找不到 git」，也没有「那该装哪 / 指哪」，只有 errno。
 * 所以按候选顺序探一遍，探不到就用人话报错并给出解法（`--c8-dir` 或 `GIT_EXE`）。
 */
function resolveGit() {
  const candidates = [
    process.env.GIT_EXE,
    'git',
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files/Git/bin/git.exe',
    'C:/Program Files (x86)/Git/cmd/git.exe',
    'C:/Program Files (x86)/Git/bin/git.exe',
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      const out = execFileSync(c, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      if (/git version/i.test(out)) return { exe: c, version: out.trim() }
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

const git = C8_DIR_ARG ? null : resolveGit()
if (!C8_DIR_ARG && !git) {
  console.error(
    '找不到 git：这个脚本要用它把 C8 那一版代码取到临时目录。\n' +
      '  三种办法，选一个：\n' +
      '    1) 直接指一个已有的 C8 检出目录：  --c8-dir <路径>（那里要有 lib/trips/seed-runner.ts）\n' +
      '    2) 指 git 可执行文件：            设置环境变量 GIT_EXE=C:\\Program Files\\Git\\cmd\\git.exe\n' +
      '    3) 在 Git Bash 里跑（那里的 PATH 有 git）\n' +
      '  已尝试：git、C:/Program Files/Git/cmd/git.exe、C:/Program Files/Git/bin/git.exe、' +
      'C:/Program Files (x86)/Git/cmd/git.exe',
  )
  process.exit(1)
}

// ── 1. 取 C8 那一版代码 ────────────────────────────────────────────────────
// 用 worktree 而不是 `git archive | tar`：少一个外部依赖（tar 不一定在），
// 失败时也好清理（worktree remove）。手头已有那棵树时用 --c8-dir 完全跳过 git。
let srcDir
let refSha = null
if (C8_DIR_ARG) {
  srcDir = path.resolve(C8_DIR_ARG)
  if (!fs.existsSync(path.join(srcDir, 'lib/trips/seed-runner.ts'))) {
    console.error(`--c8-dir 指的目录里没有 lib/trips/seed-runner.ts：${srcDir}`)
    process.exit(1)
  }
} else {
  refSha = execFileSync(git.exe, ['rev-parse', REF], { cwd: ROOT, encoding: 'utf8' }).trim()
  srcDir = path.join(work, 'c8')
  // worktree add 要求目标不存在或为空目录；先建父目录、让 git 自己建最后一级。
  // stdout/stderr 收起来：它默认会往 stderr 刷「Updating files: 37% …」，
  // 混进报告里会把人吓一跳（看着像出错）。失败时异常信息里仍带 stderr。
  execFileSync(git.exe, ['worktree', 'add', '--detach', srcDir, refSha], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const cleanup = () => {
  if (!C8_DIR_ARG && refSha) {
    try {
      execFileSync(git.exe, ['worktree', 'remove', '--force', srcDir], { cwd: ROOT, stdio: 'ignore' })
    } catch {
      console.error(`（worktree 没清干净，手动跑一下：git worktree prune）`)
    }
  }
  if (!KEEP) fs.rmSync(work, { recursive: true, force: true })
}

// 库已存在就别往里写：演练的结论是「每只各 1 趟」，在旧库上追加会变成 2 趟，
// 数字看着还对、意思全变了。要重跑就 --force，或换个路径。
if (fs.existsSync(dbPath)) {
  if (!FORCE) {
    console.error(
      `库已存在：${dbPath}\n` +
        '  演练的口径是「每只各 1 趟」；在同一个库上再跑一遍会变成 2 趟，结论就不成立了。\n' +
        '  换一个 --db 路径，或者加 --force 清掉重跑。',
    )
    cleanup()
    process.exit(1)
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true })
}
// 父目录不存在时自己建：中文/深路径下 SQLite 的报错只有一句「unable to open」，
// 看不出是目录没建。
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

// ── 2. 在 C8 那棵树里跑它的可信入口 ────────────────────────────────────────
// 驱动脚本落在临时目录、用绝对 file:// 引 C8 的模块：
//   · 不往别人的检出目录里写文件（--c8-dir 指向的是别人的工作区，写完就脏了）；
//   · C8 的模块要从它自己那棵树的 lib/ 里 import，跟 D 现在的 lib/ 不共享。
const driver = path.join(work, '_d5_drill_driver.mjs')
const fromC8 = (rel) => pathToFileURL(path.join(srcDir, rel)).href
fs.writeFileSync(
  driver,
  `import { openDatabase } from ${JSON.stringify(fromC8('lib/db/bootstrap.ts'))}
import { createSeedTripRunner } from ${JSON.stringify(fromC8('lib/trips/seed-runner.ts'))}

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
  cleanup()
  process.exit(1)
}
const runs = JSON.parse(run.stdout.trim().split('\n').pop())

// ── 3. 用 D 的派生器只读读一遍 ────────────────────────────────────────────
// 演练库是 C8 那一版代码建的（v6，没有 v7 历史视图），所以这里**不接固定事实读取器**：
// 万一将来演练链路有事件，摘要会是模板态、`historyFixed` 为 false，输出里会直接标出来。
// 演练只证明「真出行、真落库」；历史固定看 d5-history-probe.mjs（走 v7 真捕获）与 G4 验收库。
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
console.log(`C8 参考：${C8_DIR_ARG ? `--c8-dir ${srcDir}（未用 git，SHA 未可知）` : `${REF} @ ${refSha.slice(0, 7)}`}`)
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
    : '这趟没有任何 trip_event：本次取的是 C8 分支那一版（C7 选择器没有接到它的 start 里），事件条件链未接通 —— 不是「走访了没收获」'

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
  c8Ref: C8_DIR_ARG ? null : REF,
  c8Sha: refSha,
  c8Dir: C8_DIR_ARG ? srcDir : null,
  db: dbPath,
  clockBase: CLOCK,
  dogs: rows,
  totals: { dogs: runs.length, withTrip, withEvent, withFind },
}
if (OUT) {
  const outAbs = path.resolve(OUT)
  fs.mkdirSync(path.dirname(outAbs), { recursive: true })
  fs.writeFileSync(outAbs, JSON.stringify(payload, null, 2) + '\n')
  console.log(`\n证据 JSON：${outAbs}`)
}

if (KEEP) console.log(`\n已保留：${work}`)
else cleanup()
