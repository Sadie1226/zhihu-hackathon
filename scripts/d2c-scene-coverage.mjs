#!/usr/bin/env node
// d · 事件池场景覆盖率报告
//
// 为什么要有这个脚本：`place_tags` 是四个抽象值（street/stall/riverside/bookstore），
// e2c 交的是具体地点。两边没有换算表时，a 拿「南头古城」去和 `street` 求交集，
// 交集恒为空 —— 结果是只剩几条不限地点的事件会出，而没人会发现。
//
// 本脚本做三件事：
//   1. 守卫：标签合法、场景清单与 e2c 的 scene-map 逐文件一致、每个场景都得写依据。
//   2. 算账：每张图能出多少条、哪个标签一张图都没有、哪几条事件永远出不来。
//   3. 生效条件：把事件条件补丁（`1123-d2c-事件条件修正-v1.sql`）叠到事件池上再算，
//      否则报的是「补丁前」的数字，等于没改。
//
// 用法：
//   node scripts/d2c-scene-coverage.mjs
//   node scripts/d2c-scene-coverage.mjs <scene-map.json>   # 指定的 e2c 清单（比对用）
// 失败 exit 1。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPAT = 'team/2026-11-23/d/scene-place-compat.json'
const EVENTS = 'team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql'
const PATCH = 'team/2026-11-23/d/1123-d2c-事件条件修正-v1.sql'
const SCENE_MAP = process.argv[2] ?? 'team/2026-11-22/e/e2c/scene-map.json'

const TAGS = ['street', 'stall', 'riverside', 'bookstore']

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

console.log(`换算表：${compat.scenes.length} 张场景`)
const files = compat.scenes.map((s) => s.file)
if (new Set(files).size !== files.length) fail('换算表里有重复的场景文件')
for (const f of files) if (!/^scenes\/[a-z0-9-]+\.png$/.test(f)) fail(`场景路径不像 e2c 的交付命名：${f}`)

if (sceneMap) {
  const mine = [...files].sort().join('|')
  const theirs = [...sceneMap.scenes.map((s) => s.file)].sort().join('|')
  if (mine !== theirs) {
    fail(`换算表与场景清单不一致：表 ${files.length} 张 / e2c ${sceneMap.scenes.length} 张`)
  } else {
    console.log(`  · 与 e2c 清单逐文件一致（${sceneMap.scenes.length} 张）`)
  }
} else {
  console.log(`  · 未找到 ${SCENE_MAP}，跳过与 e2c 清单的交叉比对`)
}

// ── 守卫 ───────────────────────────────────────────────────────────────────
for (const s of compat.scenes) {
  if (!Array.isArray(s.tags)) fail(`${s.place} 的 tags 不是数组`)
  for (const t of s.tags) if (!TAGS.includes(t)) fail(`${s.place} 用了不存在的标签 ${t}`)
  if (!s.why || s.why.length < 8) fail(`${s.place} 没写依据 —— 没有依据的标签等于拍脑袋`)
  // variant 只记素材事实（室外/室内），不是标签，不参与匹配
  if (s.variant && !['outdoor', 'indoor'].includes(s.variant)) fail(`${s.place} 的 variant 只能是 outdoor/indoor`)
}
for (const e of events) {
  for (const t of e.placeTags) if (!TAGS.includes(t)) fail(`${e.code} 的 place_tags 含非法值 ${t}`)
}

// ── 算账：每个场景能出哪些事件 ─────────────────────────────────────────────
const hits = (scene, ev) => ev.placeTags.length === 0 || ev.placeTags.some((t) => scene.tags.includes(t))
const trulyFree = events.filter((e) => e.enabled === 1 && e.placeTags.length === 0)

const rows = compat.scenes.map((scene) => ({
  scene,
  able: events.filter((e) => e.enabled === 1 && hits(scene, e)),
}))

console.log('\n场景 → 可出事件')
for (const { scene, able } of rows) {
  const tagText = scene.tags.length ? scene.tags.join('+') : '（无标签）'
  const variant = scene.variant ? `[${scene.variant}]` : ''
  console.log(`  ${scene.place.padEnd(9, '　')} ${tagText.padEnd(18)}${variant.padEnd(8)} ${String(able.length).padStart(2)} 条`)
}

const tagCover = Object.fromEntries(TAGS.map((t) => [t, compat.scenes.filter((s) => s.tags.includes(t)).length]))
console.log('\n标签 → 有多少张场景能承载')
for (const t of TAGS) console.log(`  ${t.padEnd(10)} ${tagCover[t]} 张`)

const unreachable = events.filter((e) => e.enabled === 1 && !compat.scenes.some((s) => hits(s, e)))
console.log('\n永远出不来')
if (unreachable.length === 0) console.log('  （没有）')
for (const e of unreachable) console.log(`  ${e.code.padEnd(24)} [${e.placeTags.join(',')}] ${e.text}`)

const idle = rows.filter((r) => r.able.length === trulyFree.length)
console.log(
  `\n只承载「真不限地点」事件（${trulyFree.length} 条：${trulyFree.map((e) => e.code).join(' / ')}）的场景：${idle.length} 张`,
)
for (const { scene } of idle) console.log(`  ${scene.place} —— ${scene.why}`)

const total = rows.reduce((n, r) => n + r.able.length, 0)
const avg = total / rows.length
const zeroTags = TAGS.filter((t) => tagCover[t] === 0)
console.log(
  `\n合计：${events.length} 条事件，平均每张场景 ${avg.toFixed(1)} 条，` +
    `${unreachable.length} 条无场景可用，零覆盖标签 ${zeroTags.length} 个${zeroTags.length ? `（${zeroTags.join(',')}）` : ''}`,
)

if (failures > 0) {
  console.log(`\n${failures} 项不合格`)
  process.exit(1)
}
console.log('\n换算表自洽（零覆盖的标签见上，是待补素材，不是脚本错误）')
