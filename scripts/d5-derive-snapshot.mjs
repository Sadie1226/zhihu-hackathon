#!/usr/bin/env node
// d5 · 从真实 trip / trip_event / exchange 派生 snapshot（只读，不改库）
//
// 用法：
//   node scripts/d5-derive-snapshot.mjs --db <path>      # 对真库派生，输出报告
//   node scripts/d5-derive-snapshot.mjs --db <path> --sql # 额外输出可执行 UPSERT
//   node scripts/d5-derive-snapshot.mjs --selftest        # 内存库造 3 趟，验证机制
//
// 为什么要有这个脚本：A 11/23 要的是「5 只实际旅途 / Find 来源到摘要的证据」。
// 手写五条摘要能过形状校验，但那只是样例，不是「它真的走过」。所以把派生写成代码：
// 每一句摘要都必须指回一个 trip.id 和一条 event.code，指不回去的就输出空，不编。
//
// 三条口径（都能在 self test 里看到反例）：
//   1) 3 是**趟次数**不是条数。最近 3 趟都在超时，recentTrips 就该是 []，
//      不能往前捞「最近三次有收获的」—— 那等于把没发生的经历补上。
//   2) timeout 算一趟（契约原话：超时是正常结束，不是空状态），failed 不算
//      （那是系统故障，主人看到的是重试，不是「它回来了」）。
//   3) 摘要用 event.text，不用 message.text。event.text 是「发生了什么」，
//      第三方可见；message.text 是「它对主人说的话」，进快照就把主人语境带出去了。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const MAX_TRIPS = 3
const TRIP_SUMMARY_MAX = 40 // 与 snapshot.recent_trips 的单条上限一致
const WAITING_FOR_MAX = 40

// 算「回来过」的终点状态。failed 故意不在内。
const COUNTED_STATUS = ['done', 'timeout']

// 会留下「我在等回音」的交换种类。find / greeting 不需要回应，不产生等待。
const WAITING_KIND = {
  gift: '等一份礼物的回音',
  co_owner_message: '等一句回话',
}

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

function openMemory() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(fs.readFileSync(path.join(ROOT, 'contracts/schema.sql'), 'utf8'))
  return db
}

function loadSeedDogs(db) {
  const p = path.join(ROOT, 'team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql')
  if (!fs.existsSync(p)) return
  db.exec(fs.readFileSync(p, 'utf8'))
}

// ---------------------------------------------------------------------------
// 派生
// ---------------------------------------------------------------------------

/**
 * 摘要能不能原样塞进快照。
 *
 * 现在两侧都是 40 字（event.text 的 CHECK 与 snapshot.recent_trips 的单条上限），
 * 所以这一关正常情况下不会响。留着是因为它防的不是「现在」，是「哪天 C 把事件文本放宽」：
 * 那时候如果这里悄悄截断，快照上的话就跟事件原文对不上了，而这种不一致在界面上看起来完全正常。
 * **不截断，报错，让人来对齐两处口径。**
 */
function assertSummaryFits(text, code) {
  if (text.length <= TRIP_SUMMARY_MAX) return
  throw new Error(
    `${code} 的文本 ${text.length} 字，超过快照单条上限 ${TRIP_SUMMARY_MAX}；` +
      `event.text 与 snapshot.recent_trips 的口径已经不一致，请先对齐再派生。`,
  )
}

/** 最近 MAX_TRIPS 趟「回来过」的出行，按 seq 倒序（最近的在前）。 */
function recentTrips(db, dogId) {
  return db
    .prepare(
      `SELECT id, seq, status, ended_at, started_at
         FROM trip
        WHERE dog_id = ? AND status IN (${COUNTED_STATUS.map(() => '?').join(',')})
        ORDER BY seq DESC
        LIMIT ?`,
    )
    .all(dogId, ...COUNTED_STATUS, MAX_TRIPS)
}

/** 这一趟里最早发生的那条事件；没有就返回 null（超时趟就是这种）。 */
function earliestEvent(db, tripId, dogId) {
  return (
    db
      .prepare(
        `SELECT te.event_id, te.happened_at, e.code, e.text
           FROM trip_event te JOIN event e ON e.id = te.event_id
          WHERE te.trip_id = ? AND te.dog_id = ?
          ORDER BY te.happened_at ASC, te.event_id ASC
          LIMIT 1`,
      )
      .get(tripId, dogId) ?? null
  )
}

/** 已到达、还没被回应的最早一条礼物或捎话。 */
function pendingWaiting(db, dogId) {
  return (
    db
      .prepare(
        `SELECT id, kind, created_at, delivered_at
           FROM exchange
          WHERE to_dog = ?
            AND delivered_at IS NOT NULL
            AND replied_at IS NULL
            AND kind IN (${Object.keys(WAITING_KIND).map(() => '?').join(',')})
          ORDER BY created_at ASC, id ASC
          LIMIT 1`,
      )
      .get(dogId, ...Object.keys(WAITING_KIND)) ?? null
  )
}

function deriveDog(db, dog) {
  const trips = recentTrips(db, dog.id)

  const picked = []
  for (const t of trips) {
    const ev = earliestEvent(db, t.id, dog.id)
    picked.push({ trip: t, event: ev })
  }

  // 摘要按「趟」推进（最近的在前），每趟最多一条；没有事件的趟贡献 0 条。
  const summaries = []
  const provenance = []
  for (const { trip, event } of picked) {
    if (!event) {
      provenance.push({ tripId: trip.id, seq: trip.seq, status: trip.status, eventCode: null, text: null })
      continue
    }
    assertSummaryFits(event.text, event.code)
    summaries.push(event.text)
    provenance.push({ tripId: trip.id, seq: trip.seq, status: trip.status, eventCode: event.code, text: event.text })
  }

  const wait = pendingWaiting(db, dog.id)
  let waitingFor = null
  let waitingFrom = null
  if (wait) {
    waitingFor = WAITING_KIND[wait.kind]
    waitingFrom = { exchangeId: wait.id, kind: wait.kind, deliveredAt: wait.delivered_at }
    if (waitingFor.length > WAITING_FOR_MAX) {
      throw new Error(`waiting_for 模板超过 ${WAITING_FOR_MAX} 字，改模板前先改这里`)
    }
  }

  return {
    dogId: dog.id,
    personalityTags: JSON.parse(dog.personality_tags),
    interestCategories: dog.interest_categories === null ? null : JSON.parse(dog.interest_categories),
    tripsConsidered: trips.length,
    recentTrips: summaries,
    waitingFor,
    waitingFrom,
    provenance,
    // 「有没有经历」的判断：一趟都没回来过，就别说自己有经历。
    hasRealTrips: trips.length > 0,
  }
}

function deriveAll(db) {
  const dogs = db
    .prepare(`SELECT id, personality_tags, interest_categories FROM dog WHERE is_sample = 1 ORDER BY id`)
    .all()
  return dogs.map((d) => deriveDog(db, d))
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

function toUpsertSql(row, version) {
  const tags = JSON.stringify(row.personalityTags)
  const inter = row.interestCategories === null ? 'NULL' : sqlQuote(JSON.stringify(row.interestCategories))
  const trips = sqlQuote(JSON.stringify(row.recentTrips))
  const waiting = row.waitingFor === null ? 'NULL' : sqlQuote(row.waitingFor)
  const src = row.provenance
    .filter((p) => p.eventCode)
    .map((p) => `${p.seq}:${p.eventCode}`)
    .join(' ')
  return [
    `-- ${row.dogId}：${row.tripsConsidered} 趟 / ${row.recentTrips.length} 条摘要${src ? ' / 来源 ' + src : ''}` +
      (row.waitingFrom ? ` / 等待来自 ${row.waitingFrom.exchangeId}` : ''),
    `INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)`,
    `SELECT id, ${version}, personality_tags, interest_categories, ${trips}, ${waiting}, ${sqlQuote(new Date().toISOString())}`,
    `  FROM dog WHERE id = ${sqlQuote(row.dogId)}`,
    `ON CONFLICT(dog_id, version) DO UPDATE SET recent_trips = excluded.recent_trips, waiting_for = excluded.waiting_for;`,
  ].join('\n')
}

function report(rows, { withSql = false, compact = false } = {}) {
  console.log(`种子狗 ${rows.length} 只\n`)
  let noTrips = 0
  for (const r of rows) {
    if (!r.hasRealTrips) noTrips += 1
    if (compact) {
      console.log(
        `  ${r.dogId}  ${String(r.tripsConsidered).padStart(2)} 趟·${r.recentTrips.length} 条摘要` +
          `  ${r.waitingFor === null ? 'waiting null' : 'waiting 「' + r.waitingFor + '」'}`,
      )
      continue
    }
    const head = `${r.dogId}  标签 ${r.personalityTags.join('/')}  兴趣 ${r.interestCategories ? r.interestCategories.length + '类' : 'null'}`
    console.log(head)
    console.log(`  回来过 ${r.tripsConsidered} 趟（最多看 ${MAX_TRIPS} 趟），摘要 ${r.recentTrips.length} 条`)
    for (const p of r.provenance) {
      if (p.eventCode) console.log(`    seq${p.seq} ${p.status.padEnd(7)} ${p.eventCode.padEnd(26)} ${p.text}`)
      else console.log(`    seq${p.seq} ${p.status.padEnd(7)} —— 这趟没有事件，不补、不往前捞`)
    }
    console.log(
      `  waiting_for  ${r.waitingFor === null ? 'null（没有已到达未回应的礼物或捎话）' : `${r.waitingFor}   ← ${r.waitingFrom.kind} ${r.waitingFrom.exchangeId}`}`,
    )
    console.log()
  }
  const withTrips = rows.length - noTrips
  console.log(`小计：有真实旅途 ${withTrips} 只 / 0 趟 ${noTrips} 只`)
  if (noTrips > 0) {
    console.log(
      `\n⚠ ${noTrips} 只没有可用的 trip：它们的 recent_trips 只能是 []，waiting_for 只能是 null。\n` +
        `  这不叫「做完 d5」，叫「机制就位、缺真实数据」。真实 trip 只有 c8 能写。`,
    )
  }
  if (withSql) {
    console.log('\n-- ===== 可执行 SQL（版本号请人工确认后再定）=====\n')
    for (const r of rows) console.log(toUpsertSql(r, 1) + '\n')
  }
}

// ---------------------------------------------------------------------------
// 自检：机制对不对，用造出来的数据验；这不是 D5 证据，是「验证据生成器」
// ---------------------------------------------------------------------------

function selftest() {
  const db = openMemory()
  loadSeedDogs(db)
  const dogId = 'dog_seed_07'
  const T = (h) => `2026-11-23T0${h}:00:00Z`

  db.exec(`INSERT INTO event (id,code,text,season,weather,time_of_day,place_tags)
           VALUES ('evt_a','test_a','楼下。猫在。','any','any','any','[]'),
                  ('evt_b','test_b','听见有人在楼道里练琴。','any','any','any','[]'),
                  ('evt_c','test_c','门口有人蹲下系鞋带，系了很久。','any','any','any','[]')`)

  // 三趟：seq1 done（两条事件）、seq2 timeout（没有事件）、seq3 done（一条）
  db.exec(`INSERT INTO trip (id,dog_id,seq,status,trigger,created_at,started_at,ended_at) VALUES
    ('t1','${dogId}',1,'done','auto','${T(1)}','${T(1)}','${T(2)}'),
    ('t2','${dogId}',2,'timeout','auto','${T(3)}','${T(3)}','${T(4)}'),
    ('t3','${dogId}',3,'done','auto','${T(5)}','${T(5)}','${T(6)}')`)
  db.exec(`INSERT INTO trip_event (trip_id,event_id,dog_id,happened_at) VALUES
    ('t1','evt_b','${dogId}','${T(1)}:30'),
    ('t1','evt_a','${dogId}','${T(1)}:10'),
    ('t3','evt_c','${dogId}','${T(5)}:20')`)

  // 一条已到达未回应的礼物；一条没到达的（不该进 waiting）；一条不需要回应的 find
  db.exec(`INSERT INTO exchange (id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at,delivered_at) VALUES
    ('ex_gift','dog_seed_01','${dogId}','gift','{"kind":"gift","giftName":"x","note":null,"imagePath":null,"sourceFindId":null,"sourceMode":null}',3,'${T(1)}','${T(5)}'),
    ('ex_notyet','dog_seed_02','${dogId}','gift','{"kind":"gift","giftName":"y","note":null,"imagePath":null,"sourceFindId":null,"sourceMode":null}',9,'${T(2)}',NULL),
    ('ex_find','dog_seed_04','${dogId}','find','{"kind":"find","findTitle":"t","findExcerpt":"e","sourceUrl":null,"sourceFindId":null,"sourceMode":null}',1,'${T(2)}','${T(3)}')`)

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

  const row = deriveDog(db, db.prepare('SELECT * FROM dog WHERE id=?').get(dogId))

  check('S1 三趟都算（含 timeout），不是「三条有收获的」', () => eq(row.tripsConsidered, 3, '趟数'))
  check('S2 超时趟不贡献摘要，也不往前捞（最近在前）', () =>
    eq(row.recentTrips, ['门口有人蹲下系鞋带，系了很久。', '楼下。猫在。'], '摘要'),)
  check('S3 每趟取最早一条事件（seq1 里 evt_b 比 evt_a 晚）', () =>
    eq(row.provenance[2].eventCode, 'test_a', 'seq1 取的事件'),)
  check('S4 超时趟在 provenance 里留痕（eventCode=null）', () =>
    eq(row.provenance[1].eventCode, null, 'seq2'),)
  check('S5 waiting 只认「已到达 + 未回应 + 礼物/捎话」', () => {
    eq(row.waitingFor, '等一份礼物的回音', '模板')
    eq(row.waitingFrom.exchangeId, 'ex_gift', '来源')
  })
  check('S6 没到达的不算等待（ex_notyet 被排除）', () =>
    eq(row.waitingFrom.exchangeId === 'ex_notyet', false, '不该选没到的'),)
  check('S7 find 不产生等待（不需要回应）', () =>
    eq(row.waitingFrom.exchangeId === 'ex_find', false, '不该选 find'),)
  check('S8 最近 3 趟全无事件 → recentTrips 为 []，不补旧趟', () => {
    const db2 = openMemory()
    loadSeedDogs(db2)
    db2.exec(`INSERT INTO trip (id,dog_id,seq,status,trigger,created_at,started_at,ended_at) VALUES
      ('x1','${dogId}',1,'done','auto','${T(1)}','${T(1)}','${T(2)}'),
      ('x2','${dogId}',2,'timeout','auto','${T(3)}','${T(3)}','${T(4)}'),
      ('x3','${dogId}',3,'timeout','auto','${T(5)}','${T(5)}','${T(6)}'),
      ('x4','${dogId}',4,'timeout','auto','${T(7)}','${T(7)}','${T(8)}')`)
    db2.exec(`INSERT INTO event (id,code,text,season,weather,time_of_day,place_tags)
              VALUES ('evt_old','test_old','很久以前那趟的收获。','any','any','any','[]')`)
    db2.exec(`INSERT INTO trip_event (trip_id,event_id,dog_id,happened_at)
              VALUES ('x1','evt_old','${dogId}','${T(1)}:10')`)
    const r = deriveDog(db2, db2.prepare('SELECT * FROM dog WHERE id=?').get(dogId))
    eq(r.tripsConsidered, 3, '只看最近三趟')
    eq(r.recentTrips, [], '最近三趟都没收获，就是空的')
    db2.close()
  })
  check('S9 failed 趟不算「回来过」', () => {
    const db3 = openMemory()
    loadSeedDogs(db3)
    db3.exec(`INSERT INTO trip (id,dog_id,seq,status,trigger,created_at,started_at,ended_at) VALUES
      ('f1','${dogId}',1,'failed','auto','${T(1)}','${T(1)}','${T(2)}'),
      ('f2','${dogId}',2,'done','auto','${T(3)}','${T(3)}','${T(4)}')`)
    db3.exec(`INSERT INTO event (id,code,text,season,weather,time_of_day,place_tags)
              VALUES ('evt_d','test_d','回来了，带了点东西。','any','any','any','[]')`)
    db3.exec(`INSERT INTO trip_event (trip_id,event_id,dog_id,happened_at) VALUES ('f2','evt_d','${dogId}','${T(3)}:10')`)
    const r = deriveDog(db3, db3.prepare('SELECT * FROM dog WHERE id=?').get(dogId))
    eq(r.tripsConsidered, 1, 'failed 不计入')
    db3.close()
  })
  // 库里 event.text 有 CHECK ≤40，造不出超长行 —— 所以直接测守卫本身。
  check('S10 摘要超 40 字报错不截断，40 字放行', () => {
    assertSummaryFits('很'.repeat(TRIP_SUMMARY_MAX), 'ok')
    let threw = false
    try {
      assertSummaryFits('很'.repeat(TRIP_SUMMARY_MAX + 1), 'too_long')
    } catch {
      threw = true
    }
    if (!threw) throw new Error('超一个字就该报错，而不是砍成 40 字')
  })

  console.log(`\n自检 ${pass} 过 / ${fail} 败`)
  console.log('（这是「证据生成器」的验证，不是 D5 完成 —— 这里的数据是我造的，不是它走出来的。）')
  db.close()
  if (fail > 0) process.exitCode = 1
}

// ---------------------------------------------------------------------------

const dbPath = valueOf('--db')

if (has('--selftest')) {
  selftest()
} else if (dbPath) {
  const abs = path.resolve(dbPath)
  if (!fs.existsSync(abs)) {
    console.error(`找不到库：${abs}`)
    process.exit(1)
  }
  const db = new DatabaseSync(abs)
  try {
    report(deriveAll(db), { withSql: has('--sql') })
  } finally {
    db.close()
  }
} else {
  // 没给库：用内存库跑一遍「只有种子狗、没有旅途」的真实起点，
  // 让人看到此刻的诚实结论是什么，而不是看到五条好看的摘要。
  const db = openMemory()
  loadSeedDogs(db)
  console.log('未指定 --db，用内存库（schema + 20 只种子狗，无任何 trip）跑一遍：\n')
  report(deriveAll(db), { compact: true })
  console.log('（20 只都是 0 趟。等 c8 的种子触发能写真 trip，再带 --db 跑一次，那时才有 D5 证据。）')
  db.close()
}
