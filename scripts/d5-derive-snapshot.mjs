#!/usr/bin/env node
// d5 · 从真实 trip / trip_event / exchange 派生 snapshot（只读，不改库）
//
// 规则在 `lib/social/snapshot-derive.ts` 里，本文件只做三件事：跑自检、出报告、出分离的 SQL 文件。
// 分工：D 定规则 → C 在出发事务里分配版本并写 → A 只读验收。
//
// 用法：
//   node scripts/d5-derive-snapshot.mjs                        # 本地内存库跑一遍（只证空库起点）
//   node scripts/d5-derive-snapshot.mjs --db <path>            # 对演练库只读派生，出报告
//   node scripts/d5-derive-snapshot.mjs --db <path> --out <f>  # 另存结构化 JSON 证据
//   node scripts/d5-derive-snapshot.mjs --db <path> --sql-out <f> --version 1
//                                                              # SQL 单独落文件，只插不改
//   node scripts/d5-derive-snapshot.mjs --selftest             # 内存库造数据，验机制
//
// 11-23 晚按 A 的复核意见改的四处（每条都有用例兜住）：
//   1. `waiting_for` 方向：**寄件方**视角（`from_dog`），不是收件方。首版写反了。
//   2. 旧版本不可覆盖：删掉「version 写死 1 + ON CONFLICT DO UPDATE」，SQL 只在显式给
//      `--version` 且另存文件时产出，语句自带 `NOT EXISTS`，已存在的版本拒改。
//   3. 一致读取与可追溯：`--db` 走只读连接 + 单次读事务；证据落到 trip.id / seq / status /
//      started_at、event.id / code / happened_at，以及这趟的 find.id / source_mode。
//   4. 摘要走统一的 `validateSnapshot`，不再自己复制「≤40 字」常量。

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 规则本体在 TS 里（C 也要 import 同一份，不能有两套）。Node 22.18+ 默认剥类型。
const DERIVE_SRC = path.join(ROOT, 'lib/social/snapshot-derive.ts')
const {
  COUNTED_TRIP_STATUS,
  TRIPS_LOOKBACK,
  deriveSnapshot,
  deriveAllSnapshots,
  toSnapshot,
  assertSnapshotShape,
} = await import(pathToFileURL(DERIVE_SRC).href)

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

// ---------------------------------------------------------------------------
// 输出格式（SQL 与报告分家，见 emitInsertSql 的注释）
// ---------------------------------------------------------------------------

const sqlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`

/**
 * 生成**只插入、不覆盖**的 SQL。
 *
 * 首版是 `INSERT … ON CONFLICT(dog_id, version) DO UPDATE SET …`，配合写死的 `version = 1`：
 * 那不是「重跑一次」，那是「把已经固定下来的旧经历改成今天的样子」。
 * 现在两条都堵上：
 *   · 版本必须由调用方显式给（`--version`），没有默认值；
 *   · 语句自带 `NOT EXISTS`，同版本已存在时影响 0 行；生成前还会先查一遍并标 SKIP。
 */
function emitInsertSql(results, { version, existing }) {
  const now = new Date().toISOString()
  return results.map(({ body, evidence }) => {
    const tag = JSON.stringify(body.personalityTags)
    const inter = body.interestCategories === null ? 'NULL' : sqlQuote(JSON.stringify(body.interestCategories))
    const trips = sqlQuote(JSON.stringify(body.recentTrips))
    const waiting = body.waitingFor === null ? 'NULL' : sqlQuote(body.waitingFor)
    const src = evidence.trips
      .filter((t) => t.event)
      .map((t) => `seq${t.seq}:${t.event.code}(${t.tripId})`)
      .join(' ')

    if (existing.has(`${evidence.dogId}#${version}`)) {
      return {
        dogId: evidence.dogId,
        skipped: true,
        reason: `${evidence.dogId} 已有 version ${version}`,
        sql: `-- SKIP ${evidence.dogId}：version ${version} 已存在，拒改（旧经历不随重跑变化）`,
      }
    }

    return {
      dogId: evidence.dogId,
      skipped: false,
      sql: [
        `-- ${evidence.dogId}：${evidence.tripsConsidered} 趟 / ${body.recentTrips.length} 条摘要` +
          `${src ? ' / 来源 ' + src : ''}` +
          `${evidence.waiting ? ` / 等待来自 ${evidence.waiting.exchangeId}` : ''}`,
        `INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)`,
        `SELECT id, ${version}, ${sqlQuote(tag)}, ${inter}, ${trips}, ${waiting}, ${sqlQuote(now)}`,
        `  FROM dog`,
        ` WHERE id = ${sqlQuote(evidence.dogId)}`,
        `   AND NOT EXISTS (SELECT 1 FROM snapshot s WHERE s.dog_id = dog.id AND s.version = ${version});`,
      ].join('\n'),
    }
  })
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

function printDog({ body, evidence }, { compact }) {
  if (compact) {
    const w = evidence.waiting
    console.log(
      `  ${evidence.dogId}  ${String(evidence.tripsConsidered).padStart(2)} 趟·${body.recentTrips.length} 条摘要` +
        `  ${body.waitingFor === null ? 'waiting null' : `waiting 「${body.waitingFor}」← ${w.exchangeId}`}`,
    )
    return
  }

  // 既没旅途也没挂念的狗折成一行：20 只里 19 只这样时，逐只铺开会把有证据的那只埋掉
  if (evidence.tripsConsidered === 0 && evidence.waiting === null) {
    console.log(
      `${evidence.dogId}  —— 0 趟·无挂念（无 done/timeout 的 trip，也没有自己寄出待回应的礼物/捎话）`,
    )
    return
  }

  console.log(`${evidence.dogId}  标签 ${body.personalityTags.join('/')}  兴趣 ${body.interestCategories ? body.interestCategories.length + '类' : 'null'}`)
  console.log(
    `  回来过 ${evidence.tripsConsidered} 趟（最多看 ${TRIPS_LOOKBACK} 趟，${COUNTED_TRIP_STATUS.join(' / ')}），摘要 ${body.recentTrips.length} 条` +
      `${evidence.failedTripsIgnored ? `；另有 ${evidence.failedTripsIgnored} 趟 failed 没算` : ''}`,
  )
  for (const t of evidence.trips) {
    const head = `    ${t.tripId} seq${t.seq} ${t.status.padEnd(7)} ${t.startedAt}→${t.endedAt}`
    if (t.event) {
      console.log(`${head}`)
      console.log(
        `      event ${t.event.id} ${t.event.code} @ ${t.event.happenedAt}` +
          `${t.eventCount > 1 ? `（本趟共 ${t.eventCount} 条，取最早）` : ''}`,
      )
      console.log(`      摘要 「${t.summary}」`)
    } else {
      console.log(`${head}  —— 这趟没有 trip_event，不补、不往前捞`)
    }
    if (t.finds.length) {
      console.log(`      find ${t.finds.map((f) => `${f.id}[${f.kind}/${f.sourceMode ?? '-'}]`).join(' ')}`)
    }
  }
  const w = evidence.waiting
  console.log(
    `  waiting_for  ${body.waitingFor === null ? 'null（没有自己寄出、已到达、还没被回应的礼物/捎话）' : `「${body.waitingFor}」← ${w.kind} ${w.exchangeId}（${w.deliveredAt} 到达）`}`,
  )
  if (evidence.otherPendingWaiting > 0) {
    console.log(`  （另有 ${evidence.otherPendingWaiting} 条也在等，只作证据、不进快照）`)
  }
  console.log(
    `  Find 覆盖  ${evidence.findCoverage.tripsWithFind} 趟有 / ${evidence.findCoverage.tripsWithoutFind} 趟无 —— 事件链不等于 Find 链`,
  )
  console.log()
}

function report(results, { compact = false } = {}) {
  console.log(`种子狗 ${results.length} 只\n`)
  const withTrips = results.filter((r) => r.evidence.tripsConsidered > 0)
  const withWaiting = results.filter((r) => r.evidence.waiting !== null)

  if (compact) for (const r of results) printDog(r, { compact })
  else for (const r of results) printDog(r, { compact: false })

  console.log(
    `小计：有真实旅途 ${withTrips.length} 只 / 无 ${results.length - withTrips.length} 只；` +
      `有在等的回音 ${withWaiting.length} 只`,
  )
  return { withTrips, withWaiting }
}

// ---------------------------------------------------------------------------
// 自检：机制对不对，用造出来的数据验。**这不是 D5 证据，是「验证据生成器」。**
// ---------------------------------------------------------------------------

function selftest() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(fs.readFileSync(path.join(ROOT, 'contracts/schema.sql'), 'utf8'))
  db.exec(fs.readFileSync(path.join(ROOT, 'team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql'), 'utf8'))

  const D = 'dog_seed_07' // 青椒
  const OTHER = 'dog_seed_01'
  const T = (h) => `2026-11-23T0${h}:00:00Z`
  const payload = (kind) =>
    kind === 'gift'
      ? '{"kind":"gift","giftName":"x","note":null,"imagePath":null,"sourceFindId":null,"sourceMode":null}'
      : '{"kind":"co_owner_message","message":"m","fromOwnerOf":"dog_seed_01"}'

  const mkEvents = (d) =>
    d.exec(`INSERT INTO event (id,code,text,season,weather,time_of_day,place_tags)
            VALUES ('evt_a','test_a','楼下。猫在。','any','any','any','[]'),
                   ('evt_b','test_b','听见有人在楼道里练琴。','any','any','any','[]'),
                   ('evt_c','test_c','门口有人蹲下系鞋带，系了很久。','any','any','any','[]')`)

  const mkTrips = (d, rows) => d.exec(`INSERT INTO trip (id,dog_id,seq,status,trigger,created_at,started_at,ended_at) VALUES ${rows}`)

  mkEvents(db)
  // 三趟：seq1 done（两条事件）、seq2 timeout（有事件，走到一半回来了）、seq3 done（一条）
  mkTrips(
    db,
    `('t1','${D}',1,'done','auto','${T(1)}','${T(1)}','${T(2)}'),
     ('t2','${D}',2,'timeout','auto','${T(3)}','${T(3)}','${T(4)}'),
     ('t3','${D}',3,'done','auto','${T(5)}','${T(5)}','${T(6)}')`,
  )
  db.exec(`INSERT INTO trip_event (trip_id,event_id,dog_id,happened_at) VALUES
    ('t1','evt_b','${D}','${T(1)}:30'),
    ('t1','evt_a','${D}','${T(1)}:10'),
    ('t2','evt_a','${D}','${T(3)}:10'),
    ('t3','evt_c','${D}','${T(5)}:20')`)

  // 甲寄乙：ex_gift 由 OTHER 寄给 D（D 是收件方）；ex_out 由 D 寄给 OTHER（D 是寄件方）
  db.exec(`INSERT INTO exchange (id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at,delivered_at) VALUES
    ('ex_in','${OTHER}','${D}','gift','${payload('gift')}',3,'${T(1)}','${T(5)}'),
    ('ex_out','${D}','${OTHER}','gift','${payload('gift')}',1,'${T(2)}','${T(3)}'),
    ('ex_out2','${D}','${OTHER}','co_owner_message','${payload('co_owner_message')}',1,'${T(3)}','${T(4)}'),
    ('ex_notyet','${D}','${OTHER}','gift','${payload('gift')}',9,'${T(2)}',NULL),
    ('ex_replied','${D}','${OTHER}','co_owner_message','${payload('co_owner_message')}',1,'${T(3)}','${T(4)}'),
    ('ex_find','${OTHER}','${D}','find','{"kind":"find","findTitle":"t","findExcerpt":"e","sourceUrl":null,"sourceFindId":null,"sourceMode":null}',1,'${T(2)}','${T(3)}')`)
  db.exec(`UPDATE exchange SET replied_at = '${T(6)}' WHERE id = 'ex_replied'`)

  let pass = 0
  let fail = 0
  const check = (name, fn) => {
    try {
      fn()
      pass += 1
      console.log(`  ✅ ${name}`)
    } catch (e) {
      fail += 1
      console.log(`  ❌ ${name} → ${e.message}`)
    }
  }
  const eq = (a, b, msg) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
  }

  const r = deriveSnapshot(db, D)

  check('S1 三趟都算（含 timeout），不是「三条有收获的」', () => eq(r.evidence.tripsConsidered, 3, '趟数'))
  check('S2 每趟取最早一条；超时趟有事件就照给（不能一概当没摘要）', () =>
    eq(r.body.recentTrips, ['门口有人蹲下系鞋带，系了很久。', '楼下。猫在。', '楼下。猫在。'], '摘要（最近在前）'),)
  check('S3 seq1 里 evt_b 比 evt_a 晚 → 取 evt_a', () => eq(r.evidence.trips[2].event.code, 'test_a', 'seq1 取的事件'))
  check('S4 timeout 趟在 evidence 里留痕，状态如实', () => {
    eq(r.evidence.trips[1].status, 'timeout', 'seq2 状态')
    eq(r.evidence.trips[1].event.code, 'test_a', 'seq2 事件')
  })
  check('S5 waiting 只认「自己寄出 + 已到达 + 未回应 + 礼物/捎话」', () => {
    eq(r.body.waitingFor, '等一份礼物的回音', '模板（取最早到达那条）')
    eq(r.evidence.waiting.exchangeId, 'ex_out', '来源')
    eq(r.evidence.otherPendingWaiting, 1, '另一条也在等，只作证据')
  })
  check('S6 方向：D 是收件方时不算等待（ex_in 不收）', () =>
    eq(r.evidence.waiting.exchangeId === 'ex_in', false, '收件方不该产生等待'),)
  check('S7 没到达的不算（ex_notyet）', () => eq(r.evidence.waiting.exchangeId === 'ex_notyet', false, '不该选没到的'))
  check('S8 已回应的不算（ex_replied 有 replied_at）', () => eq(r.evidence.waiting.exchangeId === 'ex_replied', false, '不该选已回应的'))
  check('S9 find 不产生等待（不需要回应）', () => eq(r.evidence.waiting.exchangeId === 'ex_find', false, '不该选 find'))
  check('S10 甲/乙双向：各等自己寄出的那条，不替对方等', () => {
    const other = deriveSnapshot(db, OTHER)
    // ex_in 是甲（OTHER）寄给 D 的、已到达未回应 → 甲在等
    eq(other.body.waitingFor, '等一份礼物的回音', '甲等自己寄出的礼物回音')
    eq(other.evidence.waiting.exchangeId, 'ex_in', '甲等的正是 ex_in')
    // ex_out / ex_out2 是 D 寄给甲的：甲只是收件方，不该等
    eq(other.evidence.waiting.exchangeId === 'ex_out', false, '甲不替收件方等 ex_out')
    // 反过来 D 也不该等 ex_in
    eq(r.evidence.waiting.exchangeId === 'ex_in', false, 'D 不替寄件方等 ex_in')
  })
  check('S11 最近 3 趟全无事件 → recentTrips 为 []，不补旧趟', () => {
    const d2 = new DatabaseSync(':memory:')
    d2.exec('PRAGMA foreign_keys = ON')
    d2.exec(fs.readFileSync(path.join(ROOT, 'contracts/schema.sql'), 'utf8'))
    d2.exec(fs.readFileSync(path.join(ROOT, 'team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql'), 'utf8'))
    mkTrips(
      d2,
      `('x1','${D}',1,'done','auto','${T(1)}','${T(1)}','${T(2)}'),
       ('x2','${D}',2,'timeout','auto','${T(3)}','${T(3)}','${T(4)}'),
       ('x3','${D}',3,'timeout','auto','${T(5)}','${T(5)}','${T(6)}'),
       ('x4','${D}',4,'timeout','auto','${T(7)}','${T(7)}','${T(8)}')`,
    )
    d2.exec(`INSERT INTO event (id,code,text,season,weather,time_of_day,place_tags)
             VALUES ('evt_old','test_old','很久以前那趟的收获。','any','any','any','[]')`)
    d2.exec(`INSERT INTO trip_event (trip_id,event_id,dog_id,happened_at) VALUES ('x1','evt_old','${D}','${T(1)}:10')`)
    const x = deriveSnapshot(d2, D)
    eq(x.evidence.tripsConsidered, 3, '只看最近三趟')
    eq(x.body.recentTrips, [], '最近三趟都没收获，就是空的')
    d2.close()
  })
  check('S12 failed 不算「回来过」，但要在证据里露出来', () => {
    const d3 = new DatabaseSync(':memory:')
    d3.exec('PRAGMA foreign_keys = ON')
    d3.exec(fs.readFileSync(path.join(ROOT, 'contracts/schema.sql'), 'utf8'))
    d3.exec(fs.readFileSync(path.join(ROOT, 'team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql'), 'utf8'))
    mkTrips(
      d3,
      `('f1','${D}',1,'failed','auto','${T(1)}','${T(1)}','${T(2)}'),
       ('f2','${D}',2,'done','auto','${T(3)}','${T(3)}','${T(4)}')`,
    )
    d3.exec(`INSERT INTO event (id,code,text,season,weather,time_of_day,place_tags)
             VALUES ('evt_d','test_d','回来了，带了点东西。','any','any','any','[]')`)
    d3.exec(`INSERT INTO trip_event (trip_id,event_id,dog_id,happened_at) VALUES ('f2','evt_d','${D}','${T(3)}:10')`)
    const y = deriveSnapshot(d3, D)
    eq(y.evidence.tripsConsidered, 1, 'failed 不计入')
    eq(y.evidence.failedTripsIgnored, 1, 'failed 露出来')
    d3.close()
  })
  check('S13 没有 trip 也能有 waiting —— 两项独立派生', () => {
    const d4 = new DatabaseSync(':memory:')
    d4.exec('PRAGMA foreign_keys = ON')
    d4.exec(fs.readFileSync(path.join(ROOT, 'contracts/schema.sql'), 'utf8'))
    d4.exec(fs.readFileSync(path.join(ROOT, 'team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql'), 'utf8'))
    d4.exec(`INSERT INTO exchange (id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at,delivered_at)
             VALUES ('ex_only','${D}','${OTHER}','co_owner_message','${payload('co_owner_message')}',1,'${T(1)}','${T(2)}')`)
    const z = deriveSnapshot(d4, D)
    eq(z.evidence.tripsConsidered, 0, '没有旅途')
    eq(z.body.recentTrips, [], '经历为空')
    eq(z.body.waitingFor, '等一句回话', '但挂念不为空')
    d4.close()
  })
  check('S14 证据可追溯：trip.id / seq / status + event.id / code / happened_at', () => {
    const t = r.evidence.trips[2]
    eq([t.tripId, t.seq, t.status], ['t1', 1, 'done'], 'trip 三元组')
    eq([t.event.id, t.event.code], ['evt_a', 'test_a'], 'event 二元组')
    if (!t.event.happenedAt) throw new Error('happened_at 丢了')
    eq(r.evidence.textSource, 'event.text', '文本来源标注')
    eq(r.evidence.textMutable, true, '可变性标注')
  })
  check('S15 派生结果过统一 validateSnapshot；超 40 字由它拒，不是本地常量', () => {
    assertSnapshotShape(r.body, { dogId: D, createdAt: T(1) })
    const long = { ...r.body, recentTrips: ['很'.repeat(41)] }
    let threw = false
    try {
      assertSnapshotShape(long, { dogId: D, createdAt: T(1) })
    } catch (e) {
      threw = String(e.message).includes('validateSnapshot') || String(e.message).includes('TOO_LONG')
    }
    if (!threw) throw new Error('41 字该被统一校验拒掉')
    // 契约外的键也必须被拒（白名单是主防线）
    const extra = { ...r.body, ownerWords: '主人原话' }
    let threw2 = false
    try {
      toSnapshot(extra, { dogId: D, version: 1, createdAt: T(1) })
    } catch {
      threw2 = true
    }
    if (!threw2) throw new Error('契约外的键没被拒 —— 白名单失效了')
  })
  check('S16 同库连读两次结果一致（版本重读稳定）', () => {
    const a = deriveAllSnapshots(db)
    const b = deriveAllSnapshots(db)
    eq(JSON.stringify(a), JSON.stringify(b), '两次派生应完全一致')
  })
  check('S17 SQL 只插不改：已存在的版本被执行后仍是旧值', () => {
    const d5 = new DatabaseSync(':memory:')
    d5.exec('PRAGMA foreign_keys = ON')
    d5.exec(fs.readFileSync(path.join(ROOT, 'contracts/schema.sql'), 'utf8'))
    d5.exec(fs.readFileSync(path.join(ROOT, 'team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql'), 'utf8'))
    const body = { personalityTags: ['话痨', '好奇', '看物'], interestCategories: null, recentTrips: ['旧的一句话。'], waitingFor: null }
    // 先落一条 version 1（模拟「已经固定下来的旧经历」）
    d5.prepare(
      `INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
       VALUES (?, 1, ?, NULL, ?, NULL, ?)`,
    ).run(D, JSON.stringify(body.personalityTags), JSON.stringify(body.recentTrips), T(1))
    const existing = new Set(d5.prepare(`SELECT dog_id, version FROM snapshot`).all().map((x) => `${x.dog_id}#${x.version}`))
    const ready = { dogId: D, tripsConsidered: 1, body: { ...body, recentTrips: ['今天新的一句话。'] }, evidence: { dogId: D, tripsConsidered: 1, waiting: null, trips: [{ seq: 1, tripId: 't9', event: { code: 'x' } }] } }
    const [out] = emitInsertSql([ready], { version: 1, existing })
    if (!out.skipped) throw new Error('已存在的版本没被标 SKIP')
    // 就算无视 SKIP、把「今天的话」硬插一遍，语句里的 NOT EXISTS 也要挡住（影响 0 行）
    d5.exec(
      `INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
       SELECT id, 1, '["话痨","好奇","看物"]', NULL, '["今天新的一句话。"]', NULL, '${T(9)}'
         FROM dog WHERE id = ${sqlQuote(D)}
          AND NOT EXISTS (SELECT 1 FROM snapshot s WHERE s.dog_id = dog.id AND s.version = 1);`,
    )
    const kept = d5.prepare(`SELECT recent_trips FROM snapshot WHERE dog_id = ? AND version = 1`).get(D)
    eq(JSON.parse(kept.recent_trips), ['旧的一句话。'], '旧版本被改了')
    d5.close()
  })
  check('S18 派生模块只读、不碰主人原文（payload / message.text / wish / find 正文）', () => {
    const src = fs.readFileSync(DERIVE_SRC, 'utf8')
    const banned = [
      [/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i, '出现写语句'],
      [/\bFROM\s+message\b/i, '读了 message 表'],
      [/\bFROM\s+wish\b/i, '读了 wish 表'],
      [/\bpayload\b/i, '读了 payload'],
      [/\bexcerpt\b/i, '读了 find.excerpt'],
      [/\btitle\b/i, '读了 title'],
    ]
    for (const [re, why] of banned) if (re.test(src)) throw new Error(`${why} —— 主人原文/聊天内容不许进公开快照`)
  })

  console.log(`\n自检 ${pass} 过 / ${fail} 败`)
  console.log('（这是「证据生成器」的验证，不是 D5 完成 —— 这里的数据是造的，不是它走出来的。）')
  db.close()
  if (fail > 0) process.exitCode = 1
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function loadJsonEvidence(results, dbLabel) {
  return {
    generatedAt: new Date().toISOString(),
    db: dbLabel,
    readOnly: true,
    note: '本文件是只读派生的证据，不含可执行 SQL；版本号由 C 的分配器给，D 不写库。',
    textSource: { column: 'event.text', mutable: true },
    dogs: results.map(({ body, evidence }) => ({ body, evidence })),
  }
}

const dbPath = valueOf('--db')
const outPath = valueOf('--out')
const sqlOut = valueOf('--sql-out')
const versionArg = valueOf('--version')

if (has('--selftest')) {
  selftest()
} else if (dbPath) {
  const abs = path.resolve(dbPath)
  if (!fs.existsSync(abs)) {
    console.error(`找不到库：${abs}`)
    process.exit(1)
  }
  // 只读连接：写一句就报 `attempt to write a readonly database`，不靠自觉。
  const db = new DatabaseSync(abs, { readOnly: true })
  let results
  try {
    // 单次读事务：同一只狗的经历和挂念出自同一个时间点，不会读到「写了一半」的中间态。
    db.exec('BEGIN')
    try {
      results = deriveAllSnapshots(db)
      // 落库前的形状校验，用的是 lib/social/snapshot.ts 那一套
      const now = new Date().toISOString()
      for (const r of results) assertSnapshotShape(r.body, { dogId: r.evidence.dogId, createdAt: now })
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    console.log(`库：${abs}（只读，单次读事务）\n`)
    report(results)

    if (outPath) {
      fs.writeFileSync(path.resolve(outPath), JSON.stringify(loadJsonEvidence(results, abs), null, 2) + '\n')
      console.log(`证据 JSON：${path.resolve(outPath)}（与报告、SQL 分三个落点）`)
    }

    if (sqlOut) {
      if (!versionArg) {
        console.error('\n--sql-out 必须同时给 --version：版本号没有默认值，写死 1 会把旧经历改掉。')
        process.exit(1)
      }
      const version = Number(versionArg)
      if (!Number.isInteger(version) || version < 1) {
        console.error(`--version 必须是 ≥1 的整数，收到 ${versionArg}`)
        process.exit(1)
      }
      const existing = new Set(
        db.prepare(`SELECT dog_id, version FROM snapshot WHERE version = ?`).all(version).map((x) => `${x.dog_id}#${x.version}`),
      )
      const stmts = emitInsertSql(results, { version, existing })
      const skipped = stmts.filter((s) => s.skipped)
      const header = [
        `-- d5 派生 SQL · version ${version} · 只插入、不覆盖`,
        `-- 生成时间 ${new Date().toISOString()}；库 ${abs}`,
        `-- ${stmts.length} 只狗，其中 ${skipped.length} 只该版本已存在 → 已 SKIP。`,
        '-- 版本号应由 C 的分配器逐狗给出；本文件的 version 是调用时显式传入的，不是默认值。',
        '-- 本文件不含任何 UPSERT / ON CONFLICT：旧版本不随重跑变化。',
        '',
      ].join('\n')
      fs.writeFileSync(path.resolve(sqlOut), header + '\n' + stmts.map((s) => s.sql).join('\n\n') + '\n')
      console.log(`SQL：${path.resolve(sqlOut)}（${stmts.length} 条，SKIP ${skipped.length} 条；与报告分离，不混在一屏）`)
    }
  } finally {
    db.close()
  }
} else {
  // 没给库：用内存库跑一遍「只有种子狗、没有旅途」的起点。
  //
  // **这只是空库起点，不是业务库的调查结果。** 首版在这里写「20 只都是 0 趟」，
  // 那是把本地内存库当成了业务库 —— 两件事完全不同（见报告末尾三条依赖）。
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(fs.readFileSync(path.join(ROOT, 'contracts/schema.sql'), 'utf8'))
  db.exec(fs.readFileSync(path.join(ROOT, 'team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql'), 'utf8'))
  console.log('未指定 --db：本地内存库（schema + 20 只种子狗装配单，一行 trip 都没有）。\n')
  const results = deriveAllSnapshots(db)
  report(results, { compact: true })
  console.log(
    '\n⚠ 这份输出证明的是「派生器在空库上不编造」，' +
      '**不证明**业务库/演练库里 20 只都是 0 趟 —— 那要 --db 指过去跑。',
  )
  console.log(
    '  而且要分清三件事，它们互相不代替：\n' +
      '    ① 可信触发（服务端能触发 is_sample=1）—— C8\n' +
      '    ② 旅行执行（create/start/finish 真跑，含合法 timeout）—— C4 + C8\n' +
      '    ③ 事件与 Find 落库（trip_event / find 有真行）—— C7 + 场景接入\n' +
      '  三者都到位，带 --db 跑出来的才是 D5 的实际经历证据。',
  )
  db.close()
}
