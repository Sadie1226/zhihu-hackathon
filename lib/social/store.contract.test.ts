/**
 * store.contract.test.ts —— `SocialStore` 的**行为约定**，用两套实现互相验
 *
 * 为什么要有这一份（11-21 接 c8 的直接前置）：
 *
 *   c 11/19 的答复是「业务逻辑必须独立于存储，11/21 接正式持久化只替换适配器」。
 *   这句话能不能兑现，取决于**第三个适配器**（c8 的）知不知道自己该做什么。
 *   只靠 `store.ts` 里的注释不够：注释不会跑。
 *
 *   所以这里把 10 个方法的行为写成**可执行的约定**，并且同一套断言跑两遍：
 *   `MemoryStore` 与 `SqliteStore` 必须给出**完全一致**的结果。
 *   两边不一致，就是「换适配器后逻辑会变」的证据 —— 那比 c8 上线后再发现便宜得多。
 *
 * 第三个适配器怎么用（给 c8）：
 *   把自己的实现塞进下面的 `SCENES` 数组，跑同一条命令。全绿 = 可以直接换；
 *   有红灯 = 差异在这一行，不在 meet.ts / gift.ts 里。
 *
 * 跑法：node --experimental-strip-types lib/social/store.contract.test.ts
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createMemoryStore } from './store.ts'
import type { SocialStore } from './store.ts'
import { createSqliteStore } from './sqlite-store.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA = fs.readFileSync(path.resolve(HERE, '../../contracts/schema.sql'), 'utf8')

const T1 = '2026-11-20T08:00:00Z'
const T2 = '2026-11-20T16:00:00Z'

const A = 'dog_store_a'
const B = 'dog_store_b'
const C = 'dog_store_c'
const SEED = 'dog_seed_99'

/**
 * 一场景 = 一个 store + 两个「行数」读数。
 * 行数必须由场景自己给：内存版读数组长度，真库版查 SQL，
 * 但**约定是同一个**：事务失败后这两张表都必须回到零行。
 */
type Scene = {
  name: string
  store: SocialStore
  countExchange: () => number
  countRelation: () => number
}

function memoryScene(): Scene {
  const store = createMemoryStore({
    dogs: [A, B, C, SEED],
    samples: [SEED],
    blocked: [[A, C]],
    seqs: { [A]: 0, [B]: 3, [C]: 1, [SEED]: 1 },
    trips: [
      { id: 'trip_b_3', dogId: B, seq: 3, status: 'running' },
      { id: 'trip_c_1', dogId: C, seq: 1, status: 'running' },
      { id: 'trip_seed_1', dogId: SEED, seq: 1, status: 'running' },
    ],
    finds: [
      { id: 'find_b_zhihu', dogId: B, sourceMode: 'live' },
      { id: 'find_c_scene', dogId: C, sourceMode: null },
    ],
  })
  return {
    name: 'MemoryStore',
    store,
    countExchange: () => store.exchanges.length,
    countRelation: () => store.relations.size,
  }
}

function sqliteScene(): Scene {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)

  const insertDog = (id: string, isSample = false): void => {
    db.prepare(
      `INSERT INTO dog
         (id, name, session_id, personality_tags, interest_categories, assembly, is_sample, blocked_topics, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      null,
      isSample ? 'seed' : 'session_store',
      JSON.stringify(['好奇', '看物', '当下']),
      JSON.stringify(['自然', '日常', '情绪']),
      JSON.stringify({ cloth: 'sweater', hat: null, glasses: 'round', face: 'waiting' }),
      isSample ? 1 : 0,
      '[]',
      T1,
    )
  }
  const insertTrip = (id: string, dogId: string, seq: number): void => {
    db.prepare(
      `INSERT INTO trip (id, dog_id, seq, status, trigger, created_at, started_at, ended_at)
       VALUES (?, ?, ?, 'running', 'auto', ?, ?, NULL)`,
    ).run(id, dogId, seq, T1, T1)
  }
  const insertFind = (
    id: string,
    tripId: string,
    kind: 'zhihu' | 'scene',
    mode: 'live' | null,
    url: string | null,
  ): void => {
    db.prepare(
      `INSERT INTO find (id, trip_id, kind, title, excerpt, source_url, source_mode, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(id, tripId, kind, `发现 ${id}`, url, mode, T1)
  }

  insertDog(A)
  insertDog(B)
  insertDog(C)
  insertDog(SEED, true)
  // 当前 seq 由 trip 表算：B 有 3 趟、C 有 1 趟、SEED 有 1 趟、A 一趟都没有
  insertTrip('trip_b_1', B, 1)
  insertTrip('trip_b_2', B, 2)
  insertTrip('trip_b_3', B, 3)
  insertTrip('trip_c_1', C, 1)
  insertTrip('trip_seed_1', SEED, 1)
  insertFind('find_b_zhihu', 'trip_b_1', 'zhihu', 'live', 'https://www.zhihu.com/question/000000000/answer/000000000')
  insertFind('find_c_scene', 'trip_c_1', 'scene', null, null)

  // A 与 C 拉黑
  const [lo, hi] = A < C ? [A, C] : [C, A]
  db.prepare(
    `INSERT INTO relation (id, dog_a, dog_b, first_met_at, last_met_at, met_count, is_blocked, blocked_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
  ).run(`rel_${lo}__${hi}`, lo, hi, T1, T1, T1)

  const count = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    return Number(row.n)
  }

  return {
    name: 'SqliteStore',
    store: createSqliteStore(db),
    countExchange: () => count('exchange'),
    countRelation: () => count('relation'),
  }
}

// ===========================================================================
// 断言工具
// ===========================================================================

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (err) {
    fail++
    const msg = `${name} → ${(err as Error).message}`
    failures.push(msg)
    console.log(`  ❌ ${msg}`)
  }
}

const exchangeRow = (id: string, giftName: string) => ({
  id,
  fromDog: A,
  toDog: B,
  kind: 'gift' as const,
  payload: { kind: 'gift', giftName, note: null, imagePath: null, sourceFindId: null, sourceMode: null },
  deliverAfterTripSeq: 4,
  createdAt: T1,
})

// ===========================================================================
// 十项约定，两套实现各跑一遍
// ===========================================================================

for (const scene of [memoryScene(), sqliteScene()]) {
  const { store } = scene
  console.log(`\n【${scene.name}】`)

  // 1. insertExchange —— 首写 inserted，同 id 再写 duplicate，且不覆盖第一条
  check('1 insertExchange 首写 inserted、同 id 再写 duplicate、不覆盖已落库内容', () => {
    assert.equal(store.insertExchange(exchangeRow('ex_dup', '第一次')), 'inserted')
    assert.equal(store.insertExchange(exchangeRow('ex_dup', '第二次')), 'duplicate')
    const back = store.readExchange('ex_dup')
    assert.equal(back?.payload.giftName, '第一次', '第二次把内容盖掉了 —— 幂等不是覆盖')
    assert.equal(scene.countExchange(), 1, '重复写产生了第二行')
  })

  // 2. readExchange —— 不存在返回 null，不抛错
  check('2 readExchange 不存在的 id → null，不抛错', () => {
    assert.equal(store.readExchange('ex_nope'), null)
  })

  // 3. upsertRelation —— 首次 firstTime=true、metCount=1、两个时间相等
  check('3 upsertRelation 首次 → firstTime=true、metCount=1、firstMetAt=lastMetAt', () => {
    const r = store.upsertRelation({ dogA: A, dogB: B, at: T1 })
    assert.equal(r.firstTime, true)
    assert.equal(r.relation.metCount, 1)
    assert.equal(r.relation.firstMetAt, T1)
    assert.equal(r.relation.lastMetAt, T1)
    assert.equal(r.relation.isBlocked, 0)
  })

  // 4. upsertRelation —— 再次 firstTime=false、metCount+1、firstMetAt 永不改
  check('4 upsertRelation 再次 → metCount=2、lastMetAt 更新、firstMetAt 不动', () => {
    const r = store.upsertRelation({ dogA: B, dogB: A, at: T2 }) // 顺序反过来传
    assert.equal(r.firstTime, false)
    assert.equal(r.relation.metCount, 2)
    assert.equal(r.relation.firstMetAt, T1, 'firstMetAt 被改写了 —— 首次相遇时间只能写一次')
    assert.equal(r.relation.lastMetAt, T2)
  })

  // 5. readRelation —— 顺序无关
  check('5 readRelation 传 (b,a) 也读得到 (a,b) 那条', () => {
    const r = store.readRelation(B, A)
    assert.equal(r?.metCount, 2)
    assert.equal(store.readRelation(A, 'dog_store_nobody'), null)
  })

  // 6. isBlocked —— 双向都能判，无关对为 false
  check('6 isBlocked 双向一致、无关对 false', () => {
    assert.equal(store.isBlocked(A, C), true)
    assert.equal(store.isBlocked(C, A), true)
    assert.equal(store.isBlocked(A, B), false, '相遇过的对不该被当成拉黑')
  })

  // 7. currentSeq —— 无出行 0；有 3 趟 3；只读不自增
  check('7 currentSeq 无出行 → 0、有 3 趟 → 3、连读两次不变', () => {
    assert.equal(store.currentSeq(A), 0)
    assert.equal(store.currentSeq(B), 3)
    assert.equal(store.currentSeq(B), 3, 'currentSeq 不是自增计数器')
    assert.equal(store.currentSeq('dog_store_nobody'), 0)
  })

  // 8. isSample —— 种子狗 true，普通狗 false，不存在的狗也 false
  check('8 isSample 种子狗 true、普通狗 false、不存在的狗 false', () => {
    assert.equal(store.isSample(SEED), true)
    assert.equal(store.isSample(A), false)
    assert.equal(store.isSample('dog_store_nobody'), false)
  })

  // 9. hasDog —— 存在 true，不存在 false
  check('9 hasDog 存在 true、不存在 false', () => {
    assert.equal(store.hasDog(A), true)
    assert.equal(store.hasDog('dog_store_nobody'), false)
  })

  // 10. getTrip —— 三样都读得到，不存在为 null
  check('10 getTrip 读出 dogId/status/seq，不存在 → null', () => {
    const t = store.getTrip('trip_b_3')
    assert.equal(t?.dogId, B)
    assert.equal(t?.seq, 3)
    assert.equal(t?.status, 'running')
    assert.equal(store.getTrip('trip_nope'), null)
  })

  // 11. getFindSource —— 归属经 trip 反查；scene 的 mode 为 null；不存在为 null
  check('11 getFindSource 归属经 trip 反查、scene 的 mode 为 null、不存在 → null', () => {
    const zhihu = store.getFindSource('find_b_zhihu')
    assert.equal(zhihu?.dogId, B, 'find 表没有 dog_id，归属必须由 trip 反查得到')
    assert.equal(zhihu?.sourceMode, 'live')

    const sceneFind = store.getFindSource('find_c_scene')
    assert.equal(sceneFind?.dogId, C)
    assert.equal(sceneFind?.sourceMode, null, 'scene 的档位必须是 null，不能升格成 live')

    assert.equal(store.getFindSource('find_nope'), null)
  })

  // 12. transaction —— 抛错则两条写全部消失；不抛则都留
  check('12 transaction 抛错 → exchange 与 relation 都不留（真回滚，不是假装）', () => {
    const exBefore = scene.countExchange()
    const relBefore = scene.countRelation()
    assert.throws(() => {
      store.transaction(() => {
        store.insertExchange(exchangeRow('ex_tx_rollback', '会被回滚'))
        store.upsertRelation({ dogA: A, dogB: B, at: T2 })
        throw new Error('故意失败')
      })
    }, /故意失败/)
    assert.equal(scene.countExchange(), exBefore, '交换被留下了 —— 事务没回滚')
    assert.equal(scene.countRelation(), relBefore, '关系被留下了 —— 事务没回滚')
    assert.equal(store.readExchange('ex_tx_rollback'), null)
  })

  // 13. transaction —— 不抛错时返回值透传，两条写都留
  check('13 transaction 正常返回 → 结果透传、两条写都留', () => {
    const exBefore = scene.countExchange()
    const relBefore = scene.countRelation()
    const got = store.transaction(() => {
      store.insertExchange(exchangeRow('ex_tx_ok', '会留下'))
      store.upsertRelation({ dogA: A, dogB: B, at: T2 })
      return 'ok'
    })
    assert.equal(got, 'ok', 'transaction 必须把回调的返回值透传出来')
    assert.equal(scene.countExchange(), exBefore + 1)
    assert.equal(scene.countRelation(), relBefore)
  })

  // 14. 嵌套 —— C8 在外层包一层「验证寄件权」，里面再调会开事务的业务函数
  check('14 transaction 嵌套两层 → 不撞 nested BEGIN，两层写都留', () => {
    const exBefore = scene.countExchange()
    const got = store.transaction(() => {
      store.insertExchange(exchangeRow('ex_nest_outer', '外层'))
      return store.transaction(() => {
        store.insertExchange(exchangeRow('ex_nest_inner', '内层'))
        return 'done'
      })
    })
    assert.equal(got, 'done', '内层返回值必须透传到外层')
    assert.equal(scene.countExchange(), exBefore + 2)
  })

  // 15. 内层失败、外层接住 → 只撤内层（savepoint 语义），外层已写的留
  check('15 嵌套内层抛错被外层接住 → 只撤内层，外层写留', () => {
    const exBefore = scene.countExchange()
    store.transaction(() => {
      store.insertExchange(exchangeRow('ex_nest_keep', '外层保留'))
      try {
        store.transaction(() => {
          store.insertExchange(exchangeRow('ex_nest_drop', '内层撤掉'))
          throw new Error('内层故意失败')
        })
      } catch {
        // 外层明确接住：这是「内层做不成、外层继续」的场景
      }
    })
    assert.equal(store.readExchange('ex_nest_keep') !== null, true, '外层写被一起撤了 —— 嵌套语义错了')
    assert.equal(store.readExchange('ex_nest_drop'), null, '内层写没被撤掉 —— savepoint 没生效')
    assert.equal(scene.countExchange(), exBefore + 1)
  })

  // 16. 内层失败不接住 → 整体回滚（含外层已写的）
  check('16 嵌套内层抛错不接住 → 整体回滚，外层已写的一起撤', () => {
    const exBefore = scene.countExchange()
    assert.throws(() => {
      store.transaction(() => {
        store.insertExchange(exchangeRow('ex_nest_all_outer', '外层也不留'))
        store.transaction(() => {
          throw new Error('内层炸了')
        })
      })
    }, /内层炸了/)
    assert.equal(scene.countExchange(), exBefore, '外层写没撤 —— 错误没传出去时整笔必须回滚')
    assert.equal(store.readExchange('ex_nest_all_outer'), null)
  })

  // 17—19. 事务回调必须同步。C8 最可能的写法错误就是「在事务里 await 一下」，
  // 而那种写法**不会报错**：async 回调在第一个 await 就交出控制权，外层照样 COMMIT，
  // 真正的写落在事务外面。三条用例把这个坑钉死，两套实现必须同样拒。
  check('17 事务回调是 async → 抛 ASYNC_TRANSACTION，且已写的被回滚', () => {
    const exBefore = scene.countExchange()
    let code: string | undefined
    try {
      // 故意写成 async：这正是要拦的形状
      store.transaction(async () => {
        store.insertExchange(exchangeRow('ex_async_drop', '异步里写的'))
      })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    assert.equal(code, 'ASYNC_TRANSACTION', '异步回调没被拒 —— 事务会提前提交，写落在事务外')
    assert.equal(scene.countExchange(), exBefore, '拒了却留下了写 —— 回滚没走到')
    assert.equal(store.readExchange('ex_async_drop'), null)
  })

  check('18 返回 thenable（不是真 Promise）同样拒 —— 不靠 instanceof', () => {
    let code: string | undefined
    try {
      store.transaction(() => ({ then: () => undefined }))
    } catch (err) {
      code = (err as { code?: string }).code
    }
    assert.equal(code, 'ASYNC_TRANSACTION')
  })

  check('19 内层 async 被拒、外层接住 → 只撤内层，外层写留', () => {
    const exBefore = scene.countExchange()
    store.transaction(() => {
      store.insertExchange(exchangeRow('ex_async_outer_keep', '外层同步写的'))
      try {
        store.transaction(async () => {
          store.insertExchange(exchangeRow('ex_async_inner_drop', '内层异步写的'))
        })
      } catch {
        // 外层明确接住：内层做不成、外层继续
      }
    })
    assert.equal(store.readExchange('ex_async_outer_keep') !== null, true, '外层写被一起撤了')
    assert.equal(store.readExchange('ex_async_inner_drop'), null, '内层异步写没被撤')
    assert.equal(scene.countExchange(), exBefore + 1)
  })
}

// ===========================================================================
// 汇总
// ===========================================================================

console.log('\n' + '─'.repeat(56))
console.log(`通过 ${pass} 条，失败 ${fail} 条`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  · ' + f)
  console.log('\n有一套实现没通过 —— 换适配器之前先把差异说清，别在 meet/gift 里打补丁。')
  process.exitCode = 1
} else {
  console.log('两套实现行为一致。第三个适配器照这个跑，全绿才能换。')
}
