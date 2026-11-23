#!/usr/bin/env node
// d · 事件池场景覆盖率报告
//
// 为什么要有这个脚本：`place_tags` 是四个抽象值（street/stall/riverside/bookstore），
// e2c 交的是 12 张具体地点。两边没有换算表时，a 拿「南头古城」去和 `street` 求交集，
// 交集恒为空 —— 结果是只剩 4 条不限地点的事件会出，而没人会发现。
//
// 这张表是换算表，本脚本负责两件事：
//   1. 守卫：表里的标签必须合法、必须覆盖 e2c 的每一张图、事件池里的标签也必须是四值之一。
//   2. 算账：每张图能出多少条、哪个标签一张图都没有、哪几条事件永远出不来。
//
// 用法：node scripts/d2c-scene-coverage.mjs     失败 exit 1

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPAT = 'team/2026-11-23/d/scene-place-compat.json'
const EVENTS = 'team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql'
const SCENE_MAP = 'team/2026-11-22/e/e2c/scene-map.json'

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

// ── 读换算表与 e2c 清单 ────────────────────────────────────────────────────
const compat = JSON.parse(read(COMPAT))
const sceneMap = fs.existsSync(path.join(ROOT, SCENE_MAP))
  ? JSON.parse(read(SCENE_MAP))
  : null

console.log(`换算表：${compat.scenes.length} 张场景`)
if (sceneMap) {
  const a = compat.scenes.map((s) => s.file).sort().join('|')
  const b = sceneMap.scenes.map((s) => s.file).sort().join('|')
  if (a !== b) fail('换算表的场景清单与 e2c scene-map.json 不一致（有图没进表，或有表没图）')
} else {
  // e2c 的 scene-map.json 还没进 main（E 的包按「未推仓库」交付），所以交叉比对只能跳过。
  // 退一步做结构检查：12 个不同的文件、都在 scenes/ 下、都是 png —— 至少保证表的形状没歪。
  console.log(`  · 未找到 ${SCENE_MAP}，跳过与 e2c 清单的交叉比对（E 的包未推仓库）`)
  const files = compat.scenes.map((s) => s.file)
  if (new Set(files).size !== files.length) fail('换算表里有重复的场景文件')
  if (files.length !== 12) fail(`e2c 交的是 12 张，换算表里是 ${files.length} 张`)
  for (const f of files) if (!/^scenes\/[a-z-]+\.png$/.test(f)) fail(`场景路径不像 e2c 的交付命名：${f}`)
}

// ── 守卫 ───────────────────────────────────────────────────────────────────
for (const s of compat.scenes) {
  if (!Array.isArray(s.tags)) fail(`${s.place} 的 tags 不是数组`)
  for (const t of s.tags) if (!TAGS.includes(t)) fail(`${s.place} 用了不存在的标签 ${t}`)
  if (!s.why || s.why.length < 8) fail(`${s.place} 没写依据 —— 没有依据的标签等于拍脑袋`)
}
for (const e of events) {
  for (const t of e.placeTags) if (!TAGS.includes(t)) fail(`${e.code} 的 place_tags 含非法值 ${t}`)
}

// ── 算账：每个场景能出哪些事件 ─────────────────────────────────────────────
const hits = (scene, ev) =>
  ev.placeTags.length === 0 || ev.placeTags.some((t) => scene.tags.includes(t))

const rows = compat.scenes.map((scene) => {
  const able = events.filter((e) => e.enabled === 1 && hits(scene, e))
  return { scene, able }
})

console.log('\n场景 → 可出事件')
for (const { scene, able } of rows) {
  const tagText = scene.tags.length ? scene.tags.join('+') : '（无标签）'
  console.log(`  ${scene.place.padEnd(9, '　')} ${tagText.padEnd(18)} ${String(able.length).padStart(2)} 条`)
}

const tagCover = Object.fromEntries(
  TAGS.map((t) => [t, compat.scenes.filter((s) => s.tags.includes(t)).length]),
)
console.log('\n标签 → 有多少张场景能承载')
for (const t of TAGS) console.log(`  ${t.padEnd(10)} ${tagCover[t]} 张`)

const unreachable = events.filter(
  (e) => e.enabled === 1 && !compat.scenes.some((s) => hits(s, e)),
)
console.log('\n永远出不来')
if (unreachable.length === 0) console.log('  （没有）')
for (const e of unreachable) console.log(`  ${e.code.padEnd(24)} [${e.placeTags.join(',')}] ${e.text}`)

const idle = rows.filter((r) => r.able.length === events.filter((e) => e.placeTags.length === 0).length)
const free = events.filter((e) => e.placeTags.length === 0).length
console.log(`\n只承载不限地点事件（${free} 条）的空转场景：${idle.length} 张`)
for (const { scene } of idle) console.log(`  ${scene.place} —— ${scene.why}`)

const avg = rows.reduce((n, r) => n + r.able.length, 0) / rows.length
console.log(
  `\n合计：${events.length} 条事件，平均每张场景 ${avg.toFixed(1)} 条，` +
    `${unreachable.length} 条无场景可用，${Object.keys(tagCover).filter((t) => tagCover[t] === 0).length} 个标签零覆盖`,
)

if (failures > 0) {
  console.log(`\n${failures} 项不合格`)
  process.exit(1)
}
console.log('\n换算表自洽（零覆盖的标签见上，是待补素材，不是脚本错误）')
