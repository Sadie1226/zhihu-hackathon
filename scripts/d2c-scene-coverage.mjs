#!/usr/bin/env node
// d · 事件池场景覆盖率报告
//
// 为什么要有这个脚本：`place_tags` 是四个抽象值（street/stall/riverside/bookstore），
// e2c 交的是具体地点。两边没有换算表时，a 拿「南头古城」去和 `street` 求交集，
// 交集恒为空 —— 结果是只剩几条不限地点的事件会出，而没人会发现。
//
// 本脚本做四件事：
//   1. 守卫：标签合法、场景清单与 e2c 的 scene-map 逐文件一致、每个场景都得写依据。
//   2. 算账：每张图能出多少条、哪个标签一张图都没有、哪几条事件永远出不来。
//   3. 生效条件：把事件条件补丁（`1123-d2c-事件条件修正-v1.sql`）叠到事件池上再算，
//      否则报的是「补丁前」的数字，等于没改。
//   4. 分组：已进正式清单的场景（active）与 E 已交但未采用的（delivered-review）分开算。
//      后者不能算进「当前能出多少条」，不然等于替 A 宣布采用。
//
// 用法：
//   node scripts/d2c-scene-coverage.mjs
//   node scripts/d2c-scene-coverage.mjs <scene-map.json>   # 指定的 e2c 清单（比对用）
// 失败 exit 1。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPAT = 'team/2026-11-23/d/scene-place-compat.json'
const EVENTS = 'team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql'
const PATCH = 'team/2026-11-23/d/1123-d2c-事件条件修正-v1.sql'
const SCENE_MAP = process.argv[2] ?? 'team/2026-11-22/e/e2c/scene-map.json'
const DEFAULT_DIR = 'team/2026-11-22/e/e2c'

const TAGS = ['street', 'stall', 'riverside', 'bookstore']
const STATUS = ['active', 'delivered-review']

let failures = 0
const fail = (msg) => {
  failures += 1
  console.log(`  ✗ ${msg}`)
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ── 读事件池 ───────────────────────────────────────────────────────────────
const sql = read(EVENTS)
const ROW =
  /VALUES \('([^']*)', '([^']*)', '([^']*)', '([^']*)', '([^']*)', '([^']*)', '([^']*)', '([^']*)', ([0-9.]+), ([0-9.]+), '(\{\})', (\d+)\)/g

const events = []
for (const m of sql.matchAll(ROW)) {
  events.push({
    id: m[1],
    code: m[2],
    text: m[3],
    season: m[4],
    weather: m[5],
    timeOfDay: m[6],
    placeTags: JSON.parse(m[7]),
    matchTags: JSON.parse(m[8]),
    weight: Number(m[9]),
    cooldownDays: Number(m[10]),
    assetRefs: m[11],
    enabled: Number(m[12]),
  })
}

console.log(`事件池：${events.length} 条`)
if (events.length !== 30) fail(`应为 30 条，解析出 ${events.length} 条（正则和 SQL 形状对不上了）`)

// ── 叠加事件条件补丁 ───────────────────────────────────────────────────────
// 补丁是 UPDATE，只改 place_tags。这里照它的语义改内存里的值，好让下面的数字是
// 「补丁之后」的。补丁里出现事件池没有的 code → 报错（补丁写错了，或池子换了）。
const byCode = new Map(events.map((e) => [e.code, e]))
let patched = 0
if (fs.existsSync(path.join(ROOT, PATCH))) {
  const UPD = /UPDATE event SET place_tags = '(\[[^']*\])'\s*\n?\s*WHERE code = '([^']+)'/g
  for (const m of read(PATCH).matchAll(UPD)) {
    const target = byCode.get(m[2])
    if (!target) {
      fail(`条件补丁引用了不存在的事件 code：${m[2]}`)
      continue
    }
    if (target.placeTags.length !== 0) {
      // 补丁用 `AND place_tags = '[]'` 兜住「还没被人改过」的行，这里语义一致
      console.log(`  · ${m[2]} 的条件已经不是 []，补丁按语义跳过`)
      continue
    }
    target.placeTags = JSON.parse(m[1])
    patched += 1
  }
  console.log(`事件条件补丁：生效 ${patched} 条（${path.basename(PATCH)}）`)
} else {
  console.log(`  · 未找到 ${PATCH}，按原始条件计算`)
}

// ── 读换算表与 e2c 清单 ────────────────────────────────────────────────────
const compat = JSON.parse(read(COMPAT))
const sceneMap = fs.existsSync(path.join(ROOT, SCENE_MAP)) ? JSON.parse(read(SCENE_MAP)) : null

const active = compat.scenes.filter((s) => (s.status ?? 'active') === 'active')
const review = compat.scenes.filter((s) => s.status === 'delivered-review')

console.log(`换算表：${compat.scenes.length} 张场景（已入清单 ${active.length} / 待采用 ${review.length}）`)
const files = compat.scenes.map((s) => s.file)
if (new Set(files).size !== files.length) fail('换算表里有重复的场景文件')
for (const f of files) if (!/^scenes\/[a-z0-9-]+\.png$/.test(f)) fail(`场景路径不像交付命名：${f}`)

// 已入清单的那批必须与 e2c 清单逐文件对齐（张数也不能差）
if (sceneMap) {
  const mine = active.map((s) => s.file).sort().join('|')
  const theirs = [...sceneMap.scenes.map((s) => s.file)].sort().join('|')
  if (mine !== theirs) {
    fail(`换算表 active 与场景清单不一致：表 ${active.length} 张 / e2c ${sceneMap.scenes.length} 张`)
  } else {
    console.log(`  · active ${active.length} 张与 e2c 清单逐文件一致`)
  }
} else {
  console.log(`  · 未找到 ${SCENE_MAP}，跳过与 e2c 清单的交叉比对`)
}

// 待采用的那批：只验「图上真的存在」，不要求进正式清单。
// 文件在 E 自己的目录里，路径来自该场景的 sourceDir。
//
// 这里要处理一个真实状态：换算表引用的图在 E 的分支上，当前分支还没有。
// 那种情况不算错（本来就没合），但也不能静默跳过 —— 先用工作区找，再问 git，
// 两处都没有才算「表里写了一个谁都不认识的路径」。
const inGit = (ref, rel) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${rel}`], {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    })
    return true
  } catch {
    return false
  }
}

for (const s of review) {
  const rel = `${s.sourceDir ?? DEFAULT_DIR}/${s.file}`.replace(/\\/g, '/')
  if (fs.existsSync(path.join(ROOT, rel))) {
    console.log(`  · ${s.place} 的文件在当前分支（${rel}）`)
  } else if (s.sourceRef && inGit(s.sourceRef, rel)) {
    console.log(`  · ${s.place} 的文件在 ${s.sourceRef} 上，尚未合入当前分支 —— 文件级校验待合入后生效`)
  } else {
    fail(`${s.place} 声明的文件找不到：${rel}（工作区与 ${s.sourceRef ?? '未指定 sourceRef'} 都没有）`)
  }
}

// ── 守卫 ───────────────────────────────────────────────────────────────────
for (const s of compat.scenes) {
  const status = s.status ?? 'active'
  if (!STATUS.includes(status)) fail(`${s.place} 的 status 只能是 ${STATUS.join('/')}`)
  if (!Array.isArray(s.tags)) fail(`${s.place} 的 tags 不是数组`)
  for (const t of s.tags) if (!TAGS.includes(t)) fail(`${s.place} 用了不存在的标签 ${t}`)
  if (!s.why || s.why.length < 8) fail(`${s.place} 没写依据 —— 没有依据的标签等于拍脑袋`)
  // variant 只记素材事实（室外/室内），不是标签，不参与匹配
  if (s.variant && !['outdoor', 'indoor'].includes(s.variant)) fail(`${s.place} 的 variant 只能是 outdoor/indoor`)
  if (s.eventAllow) {
    if (!Array.isArray(s.eventAllow) || s.eventAllow.length === 0) fail(`${s.place} 的 eventAllow 必须是非空数组`)
    for (const code of s.eventAllow) {
      if (!byCode.has(code)) fail(`${s.place} 的 eventAllow 引用了不存在的事件 ${code}`)
    }
  }
  if (s.foot && (s.foot.length !== 2 || s.foot.some((n) => !Number.isFinite(n)))) {
    fail(`${s.place} 的 foot 必须是两个数字`)
  }
}
for (const e of events) {
  for (const t of e.placeTags) if (!TAGS.includes(t)) fail(`${e.code} 的 place_tags 含非法值 ${t}`)
}

// ── 算账：每个场景能出哪些事件 ─────────────────────────────────────────────
// eventAllow 存在时它就是**完整白名单**：这张图能出什么一眼看全，包括「不限地点」的那几条。
// 为什么需要它：同标签但空间互斥的场景（书店门口 / 书店里）光靠 place_tags 分不开。
const hits = (scene, ev) => {
  if (scene.eventAllow) return scene.eventAllow.includes(ev.code)
  return ev.placeTags.length === 0 || ev.placeTags.some((t) => scene.tags.includes(t))
}

const trulyFree = events.filter((e) => e.enabled === 1 && e.placeTags.length === 0)
const rowsOf = (list) =>
  list.map((scene) => ({ scene, able: events.filter((e) => e.enabled === 1 && hits(scene, e)) }))

const rowsActive = rowsOf(active)
const rowsReview = rowsOf(review)
const rowsAll = [...rowsActive, ...rowsReview]

const printRows = (rows) => {
  for (const { scene, able } of rows) {
    const tagText = scene.tags.length ? scene.tags.join('+') : '（无标签）'
    const marks = [scene.variant ? `[${scene.variant}]` : '', scene.eventAllow ? '[白名单]' : '']
      .filter(Boolean)
      .join('')
      .padEnd(16)
    console.log(`  ${scene.place.padEnd(9, '　')} ${tagText.padEnd(18)}${marks} ${String(able.length).padStart(2)} 条`)
  }
}

console.log('\n场景 → 可出事件（已入正式清单）')
printRows(rowsActive)
if (rowsReview.length) {
  console.log('\n场景 → 可出事件（E 已交、待 A 采用，暂不计入现行口径）')
  printRows(rowsReview)
}

// 同标签 + 室内外不同 → 必须逐张收敛，而且不能收敛成一样。
//
// 这是本次真正要防的错：书店门口和书店里同为 bookstore，如果都只靠 place_tags，
// 外景会出「最里面的角落有张椅子」，内景会出「门口摆了个纸箱」——
// 三条书店事件里三条都带明确空间位置词（门口 ×2 / 最里面的角落 ×1）。
// 街道那三张同为 street+stall 但没有 outdoor/indoor 之分，不要求白名单。
const byTagKey = new Map()
for (const s of compat.scenes) {
  const key = [...s.tags].sort().join('+')
  if (!key) continue
  byTagKey.set(key, [...(byTagKey.get(key) ?? []), s])
}
for (const [key, list] of byTagKey) {
  if (list.length < 2) continue
  const variants = new Set(list.map((s) => s.variant ?? '(未标)'))
  if (variants.size < 2) continue
  const missing = list.filter((s) => !s.eventAllow)
  if (missing.length) {
    fail(
      `标签同为 [${key}] 但室内外不同（${[...variants].join(' / ')}），` +
        `${missing.map((s) => s.place).join(' / ')} 没配 eventAllow —— 两张图会互相串事件`,
    )
    continue
  }
  const allow = list.map((s) => [...s.eventAllow].sort().join('|'))
  if (new Set(allow).size === 1) {
    fail(`标签同为 [${key}] 的 ${list.length} 张场景白名单完全一样，等于没区分（${list.map((s) => s.place).join(' / ')}）`)
  }
}

// 每条限定了地点的事件，至少得有一张场景能出；否则补了图也是白补
const unreachableAll = events.filter((e) => e.enabled === 1 && !rowsAll.some((r) => hits(r.scene, e)))
const unreachableNow = events.filter((e) => e.enabled === 1 && !rowsActive.some((r) => hits(r.scene, e)))

const tagCover = Object.fromEntries(TAGS.map((t) => [t, compat.scenes.filter((s) => s.tags.includes(t)).length]))
console.log('\n标签 → 有多少张场景能承载（含待采用）')
for (const t of TAGS) console.log(`  ${t.padEnd(10)} ${tagCover[t]} 张`)

const idle = rowsAll.filter((r) => r.able.length === trulyFree.length)
console.log(
  `\n只承载「真不限地点」事件（${trulyFree.length} 条：${trulyFree.map((e) => e.code).join(' / ')}）的场景：${idle.length} 张`,
)
for (const { scene } of idle) console.log(`  ${scene.place} —— ${scene.why}`)

const sum = (rows) => rows.reduce((n, r) => n + r.able.length, 0)
const stat = (rows) => {
  const total = sum(rows)
  return `${rows.length} 张 / 合计 ${total} 条次 / 平均 ${(total / rows.length).toFixed(2)}`
}

console.log('\n永远出不来')
if (unreachableAll.length === 0) {
  console.log('  （采用待采用场景后为 0 条）')
} else {
  for (const e of unreachableAll) console.log(`  ${e.code.padEnd(24)} [${e.placeTags.join(',')}] ${e.text}`)
}

const zeroTags = TAGS.filter((t) => tagCover[t] === 0)
console.log(
  `\n现行口径（${rowsActive.length} 张）：${stat(rowsActive)}，${unreachableNow.length} 条无场景可用` +
    `${zeroTags.length ? `，零覆盖标签 ${zeroTags.join(',')}` : ''}`,
)
if (rowsReview.length) {
  console.log(`采用后口径（${rowsAll.length} 张）：${stat(rowsAll)}，${unreachableAll.length} 条无场景可用`)
}

if (failures > 0) {
  console.log(`\n${failures} 项不合格`)
  process.exit(1)
}
console.log('\n换算表自洽（零覆盖的标签见上，是待补素材，不是脚本错误）')
