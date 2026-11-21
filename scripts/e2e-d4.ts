/**
 * d4 端到端实测：真文件库 + 真 contracts/schema.sql。
 * 验的不是函数返回值，是 SELECT 出来的表里到底有几行。
 *
 * 跑法：node --experimental-strip-types scripts/e2e-d4.ts
 *
 * 断言失败时退出码为 1 —— 结论不能只靠打印，CI 和人都得能一眼判。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { meet } from '../lib/social/meet.ts'
import { sendGift, sendCoOwnerMessage, type GiftInput } from '../lib/social/gift.ts'
import { createSqliteStore } from '../lib/social/sqlite-store.ts'

// 仓库根：本文件在 scripts/ 下，上一级就是根。不依赖 cwd。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 每次运行一个自己的目录：不假设系统有 /tmp（Windows 没有），也不和同时跑的
// 另一份抢同名库文件。目录在 finally 里删掉，库文件不留在机器上。
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-e2e-'))
const DBFILE = path.join(RUN_DIR, 'd4_e2e.db')

// 建库、读 schema 这一步也可能失败（schema 被改坏、磁盘满、权限不够）。
// 所以它和 main() 一起在 try 里 —— 只在 main() 外面建的话，初始化抛错就留下一个空目录。
// 目录都建出来了，清理的责任就已经背上，不能等 main() 开始才算数。
let db: DatabaseSync | null = null

// 断言器：只比「值对不对」，不中断执行 —— 一次跑完能看到所有不符项，最后统一退非零。
let failures = 0
const expect = (label: string, actual: unknown, wanted: unknown): void => {
  if (Object.is(actual, wanted)) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures += 1
  console.error(`  ✗ ${label}：期望 ${String(wanted)}，实际 ${String(actual)}`)
}

function main(db: DatabaseSync): void {
  const T0 = '2026-11-19T08:00:00Z'
  const T1 = '2026-11-19T16:00:00Z'
  const dogRow = (id: string, sample = 0) =>
    db
      .prepare(
        `INSERT INTO dog (id,name,session_id,personality_tags,interest_categories,assembly,is_sample,blocked_topics,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        null,
        's',
        JSON.stringify(['好奇', '看物', '当下']),
        JSON.stringify(['自然风景', '冷知识']),
        JSON.stringify({ cloth: 'sweater', hat: null, glasses: 'round', face: 'waiting' }),
        sample,
        '[]',
        T0,
      )

  dogRow('dog_a')
  dogRow('dog_b')
  dogRow('dog_seed', 1)

  const trip = (id: string, dogId: string, seq: number) =>
    db
      .prepare(
        `INSERT INTO trip (id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
         VALUES (?,?,?,'running','auto',?,?,NULL)`,
      )
      .run(id, dogId, seq, T0, T0)

  trip('trip_a1', 'dog_a', 1)
  trip('trip_b1', 'dog_b', 1)
  trip('trip_b2', 'dog_b', 2)
  trip('trip_b3', 'dog_b', 3)

  // `SQLInputValue` 是 node:sqlite 接受的绑定值联合（null / number / bigint / string / 视图）。
  // 用 unknown[] 会在 `get(...args)` 处被拒 —— 类型检查能过，运行时才炸的写法不接受。
  const one = <T>(sql: string, ...args: SQLInputValue[]): T =>
    db.prepare(sql).get(...args) as T
  const n = (t: string): number => Number(one<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`).n)
  const rel = () =>
    one<{ met_count: number; first_met_at: string; last_met_at: string }>(
      `SELECT met_count, first_met_at, last_met_at FROM relation WHERE dog_a='dog_a' AND dog_b='dog_b'`,
    )

  const step = (s: string) => console.log(`\n── ${s}`)

  // ===========================================================================
  step('1｜第一次相遇：greeting 送出 + 关系建立')
  const store = createSqliteStore(db)

  const m1 = meet({
    store,
    dogId: 'dog_a',
    otherDogId: 'dog_b',
    tripId: 'trip_a1',
    now: T0,
    outgoing: { kind: 'greeting', payload: { line: '你也爱在下雨天出来啊', weather: '雨' } },
  })
  console.log('返回值  replayed =', m1.replayed, ' exchanges =', m1.exchanges.length)
  console.log('库里   exchange =', n('exchange'), ' relation =', n('relation'), ' met_count =', rel().met_count)
  expect('第 1 次相遇：不是重放', m1.replayed, false)
  expect('第 1 次相遇：exchange 1 条', n('exchange'), 1)
  expect('第 1 次相遇：relation 1 条', n('relation'), 1)
  expect('第 1 次相遇：met_count = 1', rel().met_count, 1)

  // ===========================================================================
  step('2｜同一趟重试一次（网络重发）')
  const m2 = meet({
    store,
    dogId: 'dog_a',
    otherDogId: 'dog_b',
    tripId: 'trip_a1',
    now: T0,
    outgoing: { kind: 'greeting', payload: { line: '你也爱在下雨天出来啊', weather: '雨' } },
  })
  console.log('返回值  replayed =', m2.replayed)
  console.log('库里   exchange =', n('exchange'), ' met_count =', rel().met_count, '← 必须仍是 1')
  expect('同趟重发：返回 replayed', m2.replayed, true)
  expect('同趟重发：exchange 仍 1 条', n('exchange'), 1)
  expect('同趟重发：met_count 仍 1', rel().met_count, 1)

  // ===========================================================================
  step('3｜换一趟出行再遇（trip_a2）：met_count 必须 +1，first_met_at 必须不动')
  trip('trip_a2', 'dog_a', 2)
  const before = rel()
  const m3 = meet({
    store,
    dogId: 'dog_a',
    otherDogId: 'dog_b',
    tripId: 'trip_a2',
    now: T1,
    outgoing: { kind: 'greeting', payload: { line: '又碰到你了', weather: '阴' } },
  })
  const after = rel()
  console.log('返回值  replayed =', m3.replayed)
  console.log(
    'met_count',
    before.met_count,
    '→',
    after.met_count,
    '| first_met_at 变了吗：',
    before.first_met_at !== after.first_met_at ? '变了（错）' : '没变（对）',
  )
  console.log('last_met_at 变了吗：', before.last_met_at !== after.last_met_at ? '变了（对）' : '没变（错）')
  expect('换一趟再遇：met_count +1', after.met_count, before.met_count + 1)
  expect('换一趟再遇：first_met_at 不动', after.first_met_at, before.first_met_at)
  expect('换一趟再遇：last_met_at 更新', after.last_met_at !== before.last_met_at, true)

  // ===========================================================================
  step('4｜字典序：反过来传（dog_b 发起）也不报 CHECK')
  const m4 = meet({
    store,
    dogId: 'dog_b',
    otherDogId: 'dog_a',
    tripId: 'trip_b1',
    now: T1,
    incoming: { kind: 'find', payload: { findTitle: '雨天为什么有土腥味', findExcerpt: '放线菌', sourceUrl: 'https://www.zhihu.com/question/1' } },
  })
  console.log('返回值  replayed =', m4.replayed, ' met_count =', rel().met_count, ' relation 行数 =', n('relation'))
  expect('反向发起：relation 仍 1 行（字典序归对）', n('relation'), 1)
  expect('反向发起：met_count = 3', rel().met_count, 3)

  // ===========================================================================
  step('5｜礼物：dog_b 3 趟，deliver_after_trip_seq 应为 4')
  const g1 = sendGift({
    store,
    fromDog: 'dog_a',
    toDog: 'dog_b',
    idempotencyKey: 'gift-1119-001',
    giftName: '一小卷灰蓝色的毛线',
    note: '天气要冷了',
    now: T1,
  })
  console.log('返回值  inserted =', g1.inserted, ' 趟次 =', g1.deliverAfterTripSeq, ' heldBack =', JSON.stringify(g1.heldBack))
  console.log('库里   exchange =', n('exchange'))
  expect('礼物：新插入', g1.inserted, true)
  expect('礼物：趟次 = 4（dog_b 已有 3 趟）', g1.deliverAfterTripSeq, 4)

  // ===========================================================================
  step('6｜同一个 idempotencyKey 再发一次（重试）')
  const g2 = sendGift({
    store,
    fromDog: 'dog_a',
    toDog: 'dog_b',
    idempotencyKey: 'gift-1119-001',
    giftName: '一小卷灰蓝色的毛线',
    note: '天气要冷了',
    now: T1,
  })
  console.log('返回值  inserted =', g2.inserted, ' 趟次 =', g2.deliverAfterTripSeq)
  console.log('库里   exchange =', n('exchange'), '← 必须仍是 4 条（3 条相遇 + 1 条礼物）')
  expect('重发同 key：inserted = false', g2.inserted, false)
  expect('重发同 key：趟次不变（仍 4）', g2.deliverAfterTripSeq, 4)
  expect('重发同 key：exchange 仍 4 条', n('exchange'), 4)

  // ===========================================================================
  step('7｜捎话：给种子狗发「主人原话」→ 能写进去（种子狗可以收话）')
  let seedCanReceive = false
  let seedReceiveError: string | undefined
  try {
    sendCoOwnerMessage({
      store,
      fromDog: 'dog_a',
      toDog: 'dog_seed',
      idempotencyKey: 'msg-1119-001',
      message: '楼下的桂花开了',
      now: T1,
    })
    seedCanReceive = true
    console.log('写进去了 —— 对。种子狗可以「收」话，只是不能以自己主人的名义「发」话。')
  } catch (e: unknown) {
    seedReceiveError = (e as { code?: string }).code
    console.log('被拒：', seedReceiveError, '← 不该拒，见 1119-d4-给种子狗捎话 文档')
  }
  expect(`给种子狗捎话：写进去了（实际 ${seedReceiveError ?? '未拒'}）`, seedCanReceive, true)

  step('7b｜反向：种子狗以自己主人名义发话 → 必须拒（伪造真实用户内容）')
  let seedCannotSpeak = false
  let seedSpeakCode: string | undefined
  try {
    sendCoOwnerMessage({
      store,
      fromDog: 'dog_seed',
      toDog: 'dog_a',
      idempotencyKey: 'msg-1119-002',
      message: '主人说他也想你',
      now: T1,
    })
    console.log('居然写进去了（错）—— 这条是阻断缺陷')
  } catch (e: unknown) {
    seedCannotSpeak = true
    seedSpeakCode = (e as { code?: string }).code
    console.log('被拒：', seedSpeakCode, '← 对')
  }
  expect('种子狗以自己主人名义发话：被拒', seedCannotSpeak, true)
  expect('拒的理由是 SEED_OWNER_SPEAKS', seedSpeakCode, 'SEED_OWNER_SPEAKS')

  // ===========================================================================
  step('7c｜K v4 来源：真 find 落库 / 假来源 / 跨狗 / 谎报档位 全部分开验')

  // 一条真 find，挂在 dog_a 的 trip_a1 上（find 表没有 dog_id，归属靠 trip 反查）
  db.prepare(
    `INSERT INTO find (id,trip_id,kind,title,excerpt,source_url,source_mode,created_at)
     VALUES ('find_a_zhihu','trip_a1','zhihu','雨天为什么有土腥味','放线菌','https://www.zhihu.com/question/1','live',?)`,
  ).run(T1)
  // dog_b 也有一条，用来验「借别人的发现当自己的出处」
  db.prepare(
    `INSERT INTO find (id,trip_id,kind,title,excerpt,source_url,source_mode,created_at)
     VALUES ('find_b_zhihu','trip_b1','zhihu','井盖为什么是圆的','因为不会掉下去','https://www.zhihu.com/question/2','cache',?)`,
  ).run(T1)

  const g3 = sendGift({
    store, fromDog: 'dog_a', toDog: 'dog_b',
    idempotencyKey: 'gift-src-real',
    giftName: '一小卷灰蓝色的毛线',
    sourceFindId: 'find_a_zhihu',
    now: T1,
  })
  const src = JSON.parse(one<{ payload: string }>('SELECT payload FROM exchange WHERE id=?', g3.id).payload)
  console.log('真来源   sourceFindId =', src.sourceFindId, ' sourceMode =', src.sourceMode, '← 库里是 live，调用方没传 mode，由库派生')
  expect('真来源：sourceFindId 落库', src.sourceFindId, 'find_a_zhihu')
  expect('真来源：mode 由库派生为 live（调用方没传）', src.sourceMode, 'live')

  // 故意非法的入参（假 id、别人的发现、谎报档位）在运行期非法，类型层面完全合法 ——
  // 所以这里不需要 `as never`，按 GiftInput 的真实字段写就行。
  type GiftProbe = Partial<
    Pick<GiftInput, 'sourceFindId' | 'sourceMode' | 'idempotencyKey' | 'imagePath'>
  >
  const tryGift = (label: string, extra: GiftProbe): string | null => {
    try {
      sendGift({ store, fromDog: 'dog_a', toDog: 'dog_b', giftName: '毛线', now: T1, ...extra })
      console.log(label, '居然写进去了（错）')
      return null
    } catch (e: unknown) {
      const code = (e as { code?: string }).code ?? 'UNKNOWN'
      console.log(label, '被拒：', code)
      return code
    }
  }
  const ghost = tryGift('假来源   ', { sourceFindId: 'find_ghost', idempotencyKey: 'gift-src-ghost' })
  const cross = tryGift('跨狗     ', { sourceFindId: 'find_b_zhihu', idempotencyKey: 'gift-src-cross' })
  const lie = tryGift('谎报档位 ', { sourceFindId: 'find_a_zhihu', sourceMode: 'cache', idempotencyKey: 'gift-src-lie' })
  // 11-20 晚 c 的边界：显式 null 是「明确声明没有档位」，与库里的 live 矛盾必须拒
  const explicitNull = tryGift('显式 null ', { sourceFindId: 'find_a_zhihu', sourceMode: null, idempotencyKey: 'gift-src-null' })
  expect('假来源被拒', ghost, 'PROVENANCE_MISMATCH')
  expect('跨狗被拒', cross, 'PROVENANCE_MISMATCH')
  expect('谎报档位被拒', lie, 'PROVENANCE_MISMATCH')
  expect('显式 null 与库冲突被拒', explicitNull, 'PROVENANCE_MISMATCH')

  // step 4 那条 incoming find 没给来源 —— 键必须仍在，值为 null
  const noSrc = JSON.parse(
    one<{ payload: string }>(`SELECT payload FROM exchange WHERE kind='find' LIMIT 1`).payload,
  )
  console.log('无来源 find 的两键 =', JSON.stringify(noSrc.sourceFindId), '/', JSON.stringify(noSrc.sourceMode), '← 键必须在，值必须是 null')
  expect('无来源：sourceFindId 键在且为 null', 'sourceFindId' in noSrc && noSrc.sourceFindId === null, true)
  expect('无来源：sourceMode 键在且为 null', 'sourceMode' in noSrc && noSrc.sourceMode === null, true)

  // ===========================================================================
  step('8｜最后的表里到底有什么')
  console.log('\n[exchange]')
  const rows = db
    .prepare(
      `SELECT id, from_dog, to_dog, kind, deliver_after_trip_seq,
              delivered_at, replied_at, read_at, substr(payload,1,64) AS payload
       FROM exchange ORDER BY deliver_after_trip_seq, id`,
    )
    .all() as Array<Record<string, unknown>>
  for (const r of rows) {
    console.log(
      `  ${r.from_dog} → ${r.to_dog}  ${r.kind}  趟次=${r.deliver_after_trip_seq}` +
        `  三个时间戳=${r.delivered_at ?? 'NULL'}/${r.replied_at ?? 'NULL'}/${r.read_at ?? 'NULL'}`,
    )
    console.log(`     payload: ${r.payload}...`)
  }

  console.log('\n[relation]')
  console.log(db.prepare('SELECT dog_a, dog_b, met_count, first_met_at, last_met_at, is_blocked FROM relation').all())

  console.log(`\n合计：exchange ${n('exchange')} 行 · relation ${n('relation')} 行 · 库文件 ${DBFILE}`)

  // 收尾的行数也是断言，不是「打印出来给人看」—— 前面任何一步多写或漏写，
  // 单看每一步的断言可能都对，只有总数会露出来。
  expect('收尾：exchange 6 行', n('exchange'), 6)
  expect('收尾：relation 1 行', n('relation'), 1)
  expect('收尾：met_count = 3', rel().met_count, 3)

  if (failures > 0) {
    console.error(`\n${failures} 项断言未通过`)
    process.exitCode = 1
  } else {
    console.log('\n全部断言通过')
  }
}

try {
  db = new DatabaseSync(DBFILE)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(fs.readFileSync(path.join(ROOT, 'contracts/schema.sql'), 'utf8'))
  main(db)
} finally {
  // 先关句柄再删目录：Windows 上文件还开着就删不掉。
  // 用 ?. —— 如果 new DatabaseSync 就失败了，这里没有句柄可关，但目录仍然要删。
  try {
    db?.close()
  } catch {
    // 关不掉也要继续删目录
  }
  try {
    fs.rmSync(RUN_DIR, { recursive: true, force: true })
  } catch {
    // 删不掉只是留一个临时目录，不能盖掉断言结果 —— 否则「断言失败」会被清目录的
    // 异常顶替成另一个错，退出码的来源就说不清了。
  }
}
