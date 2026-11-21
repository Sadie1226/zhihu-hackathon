/**
 * tx.concurrency.test.ts —— **两个连接同时动一张表**时的账
 *
 * 这个文件只回答一个问题：**「检查」和「写入」之间，别人能不能插进来。**
 * 单连接的单测发现不了这类问题 —— 顺序执行时任何检查都是有效的，只有第二个连接
 * 才让「读完之后、写之前」变成一个真实的时间窗口。
 *
 * 来源：A 11-21 对 `d64b6eb` 的隔离复验，三项都是它实测出来的：
 *   1. 独立 `recordExchange` 查来源 → 写行，中间另一连接把 find 从 fixture 改成 cache 并成功；
 *   2. `meet` 的状态/gate 检查在事务前，中间另一连接把 trip 改成 done，仍写入 1 条 exchange；
 *   3. 嵌套事务成功路径没有 `RELEASE SAVEPOINT`。
 *
 * 这里全部用**文件库 + 两个 DatabaseSync 连接**，不用 `:memory:` ——
 * 内存库两个连接碰不到同一份数据，测不出任何并发语义。
 *
 * 跑法：node --experimental-strip-types lib/social/tx.concurrency.test.ts
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { meet, recordExchange } from './meet.ts'
import { createSqliteStore } from './sqlite-store.ts'
import type { SocialStore } from './store.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA = fs.readFileSync(path.resolve(HERE, '../../contracts/schema.sql'), 'utf8')

const T0 = '2026-11-21T08:00:00Z'
const A = 'dog_a'
const B = 'dog_b'

// ===========================================================================
// 断言器
// ===========================================================================

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    pass += 1
    console.log(`  ✅ ${name}`)
  } catch (err) {
    fail += 1
    failures.push(`${name}\n    ${(err as Error).message.split('\n').join('\n    ')}`)
    console.log(`  ❌ ${name}`)
  }
}

// ===========================================================================
// 文件库 + 第二个连接
// ===========================================================================

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-tx-'))
let dbSeq = 0

/** 建一个独立的文件库（每个用例一份），建表 + 两只狗 + 一趟 running 的出行 + 一条 fixture 来源的 find。 */
function freshFileDb(): { file: string; db: DatabaseSync } {
  dbSeq += 1
  const file = path.join(tmpRoot, `t${dbSeq}.db`)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)

  for (const id of [A, B]) {
    db.prepare(
      `INSERT INTO dog
         (id, name, session_id, personality_tags, interest_categories,
          assembly, is_sample, blocked_topics, created_at)
       VALUES (?, NULL, 'session_tx', ?, NULL, ?, 0, '[]', ?)`,
    ).run(
      id,
      JSON.stringify(['好奇', '看物', '当下']),
      JSON.stringify({ cloth: 'sweater', hat: null, glasses: 'round', face: 'waiting' }),
      T0,
    )
  }
  db.prepare(
    `INSERT INTO trip (id, dog_id, seq, status, trigger, created_at, started_at, ended_at)
     VALUES ('trip_a1', ?, 1, 'running', 'auto', ?, ?, NULL)`,
  ).run(A, T0, T0)
  db.prepare(
    `INSERT INTO find (id, trip_id, kind, title, excerpt, source_url, source_mode, created_at)
     VALUES ('find_a1', 'trip_a1', 'zhihu', '一条发现', NULL, 'https://www.zhihu.com/question/1', 'fixture', ?)`,
  ).run(T0)
  return { file, db }
}

/** 第二个连接。同一个文件、独立的锁与事务状态 —— 这就是「另一台设备/另一个请求」。 */
function secondConnection(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

function countRows(db: DatabaseSync, table: 'exchange' | 'relation'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return Number(row.n)
}

/** 另一连接动手的结果：被拦了，还是写进去了。 */
interface AttackOutcome {
  blocked: boolean
  message: string
}

/** 把一个写操作的结果归纳成「被拦」还是「写进去了」，不让用例被错误消息的细节绊住。 */
function tryWrite(fn: () => void): AttackOutcome {
  try {
    fn()
    return { blocked: false, message: '' }
  } catch (err) {
    return { blocked: true, message: String((err as Error).message ?? err) }
  }
}

function isBusy(message: string): boolean {
  return /SQLITE_BUSY|database is locked|busy/i.test(message)
}

/**
 * 在指定时机插一刀的 store 包装。
 *
 * 为什么包 store 而不是在业务代码里留钩子：钩子留在生产代码里就是给未来埋一个
 * 「只有测试才走的分支」。包一层代理，业务代码完全不知道有人在中间动手。
 */
function attackingStore(
  base: SocialStore,
  attack: (point: 'afterGetFindSource' | 'beforeTransaction') => void,
): SocialStore {
  let findFired = false
  let txFired = false
  return {
    ...base,
    getFindSource(id: string) {
      const res = base.getFindSource(id)
      if (!findFired) {
        findFired = true
        attack('afterGetFindSource')
      }
      return res
    },
    transaction<T>(fn: () => T): T {
      if (!txFired) {
        txFired = true
        attack('beforeTransaction')
      }
      return base.transaction(fn)
    },
  }
}

// ===========================================================================
// 一、独立 recordExchange：查来源与写行必须同一个事务
// ===========================================================================

console.log('\n一、独立 recordExchange —— 查来源与写行之间不能有窗口')

check('C1 双连接：读到来源后另一连接改 find.source_mode → 改不进去，payload 与库一致', () => {
  const { file, db } = freshFileDb()
  const store = createSqliteStore(db)
  const other = secondConnection(file)

  // 装进容器而不是用裸 `let x = null`：TS 的控制流分析不认为闭包里的赋值发生过，
  // 读完仍是 null 类型，断言非空后反而收窄成 never（a 报的 7 处里有 5 处是这个）。
  // 属性访问不做这种窄化，声明类型一直是 `AttackOutcome | null`。
  const attack: { result: AttackOutcome | null } = { result: null }
  const guarded = attackingStore(store, (point) => {
    // 只打「读到来源之后」这一枪。事务开始前动手是另一回事（那时谁都拦不住，
    // 也正是 C3/C4 那两个用例要证明「必须在事务内重验」的原因）。
    if (point !== 'afterGetFindSource') return
    // 这就是 A 复现的那一手：把 fixture 改成 cache。
    attack.result = tryWrite(() => {
      other
        .prepare(`UPDATE find SET source_mode = 'cache' WHERE id = 'find_a1'`)
        .run()
    })
  })

  const r = recordExchange(
    guarded,
    {
      fromDog: A,
      toDog: B,
      kind: 'find',
      payload: {
        kind: 'find',
        findTitle: '一条发现',
        findExcerpt: null,
        sourceUrl: 'https://www.zhihu.com/question/1',
        sourceFindId: 'find_a1',
        sourceMode: 'fixture',
      },
    },
    { idempotencyKey: 'tx-src-1', createdAt: T0 },
  )

  // 先落成局部常量再断言：断言之后读的是同一个值，不会被后来的调用重置窄化。
  const outcome = attack.result
  assert.ok(outcome !== null, '攻击必须在查来源之后触发，否则这个用例没测到东西')
  assert.equal(outcome.blocked, true, '事务已拿写锁，另一连接的 UPDATE 必须被拦')
  assert.equal(isBusy(outcome.message), true, `被拦的原因应是锁冲突，实际：${outcome.message}`)

  // 库里的档位没有被改，写入的 payload 也是 fixture —— 两处一致。
  const row = db.prepare(`SELECT source_mode FROM find WHERE id = 'find_a1'`).get() as {
    source_mode: string
  }
  assert.equal(row.source_mode, 'fixture')
  assert.equal(r.exchange.payload.sourceMode, 'fixture')
  assert.equal(r.deliverAfterTripSeq, 1)
  assert.equal(countRows(db, 'exchange'), 1)

  other.close()
  db.close()
})

check('C2 双连接：事务提交后另一连接能改 —— 拦的是「中途」，不是永久堵住', () => {
  const { file, db } = freshFileDb()
  const store = createSqliteStore(db)
  const other = secondConnection(file)

  recordExchange(
    store,
    {
      fromDog: A,
      toDog: B,
      kind: 'find',
      payload: {
        kind: 'find',
        findTitle: '一条发现',
        findExcerpt: null,
        sourceUrl: 'https://www.zhihu.com/question/1',
        sourceFindId: 'find_a1',
        sourceMode: 'fixture',
      },
    },
    { idempotencyKey: 'tx-src-2', createdAt: T0 },
  )

  const after = tryWrite(() => {
    other.prepare(`UPDATE find SET source_mode = 'cache' WHERE id = 'find_a1'`).run()
  })
  assert.equal(after.blocked, false, '事务结束后锁必须释放，否则整个库就只能一个人用')

  other.close()
  db.close()
})

check('C2b 嵌套调用：外层事务里调 recordExchange，来源查询照样在事务内（不因嵌套掉保护）', () => {
  const { file, db } = freshFileDb()
  const store = createSqliteStore(db)
  const other = secondConnection(file)

  // 装进容器而不是用裸 `let x = null`：TS 的控制流分析不认为闭包里的赋值发生过，
  // 读完仍是 null 类型，断言非空后反而收窄成 never（a 报的 7 处里有 5 处是这个）。
  // 属性访问不做这种窄化，声明类型一直是 `AttackOutcome | null`。
  const attack: { result: AttackOutcome | null } = { result: null }
  const guarded = attackingStore(store, (point) => {
    if (point !== 'afterGetFindSource') return
    attack.result = tryWrite(() => {
      other
        .prepare(`UPDATE find SET source_mode = 'cache' WHERE id = 'find_a1'`)
        .run()
    })
  })

  // C8 的真实形状：外层开事务（验寄件权/写别的东西），里层调 D 的写入函数。
  guarded.transaction(() => {
    store.insertExchange({
      id: 'ex_outer_guard',
      fromDog: A,
      toDog: B,
      kind: 'greeting',
      payload: { kind: 'greeting', line: '外层先写一条', weather: null },
      deliverAfterTripSeq: 1,
      createdAt: T0,
    })
    recordExchange(
      guarded,
      {
        fromDog: A,
        toDog: B,
        kind: 'find',
        payload: {
          kind: 'find',
          findTitle: '一条发现',
          findExcerpt: null,
          sourceUrl: 'https://www.zhihu.com/question/1',
          sourceFindId: 'find_a1',
          sourceMode: 'fixture',
        },
      },
      { idempotencyKey: 'tx-nested', createdAt: T0 },
    )
  })

  const outcome = attack.result
  assert.ok(outcome !== null, '嵌套时也必须真的走到查来源那一步')
  assert.equal(outcome.blocked, true, '嵌套进 SAVEPOINT 之后，外层已持有写锁，攻击仍须被拦')
  assert.equal(countRows(db, 'exchange'), 2, '外层那条与内层那条都要落下')
  const modes = db.prepare(`SELECT source_mode FROM find WHERE id = 'find_a1'`).get() as {
    source_mode: string
  }
  assert.equal(modes.source_mode, 'fixture')

  other.close()
  db.close()
})

check('C2c 嵌套调用：内层来源不符而失败 → 只撤内层，外层已写的那条留', () => {
  const { db } = freshFileDb()
  const store = createSqliteStore(db)

  store.transaction(() => {
    store.insertExchange({
      id: 'ex_outer_keep',
      fromDog: A,
      toDog: B,
      kind: 'greeting',
      payload: { kind: 'greeting', line: '外层要留', weather: null },
      deliverAfterTripSeq: 1,
      createdAt: T0,
    })
    // 谎报档位：库里是 fixture，声明 cache → 内层抛 PROVENANCE_MISMATCH
    assert.throws(
      () =>
        recordExchange(
          store,
          {
            fromDog: A,
            toDog: B,
            kind: 'find',
            payload: {
              kind: 'find',
              findTitle: '一条发现',
              findExcerpt: null,
              sourceUrl: 'https://www.zhihu.com/question/1',
              sourceFindId: 'find_a1',
              sourceMode: 'cache',
            },
          },
          { idempotencyKey: 'tx-nested-fail', createdAt: T0 },
        ),
      /PROVENANCE_MISMATCH|不一致/,
    )
  })

  assert.equal(countRows(db, 'exchange'), 1)
  const left = db.prepare(`SELECT id FROM exchange`).get() as { id: string }
  assert.equal(left.id, 'ex_outer_keep', '内层失败只能撤内层，外层那条必须留')
  db.close()
})

// ===========================================================================
// 二、meet：决定写入的状态必须在事务内复核
// ===========================================================================

console.log('\n二、meet —— 事务前检查完之后，另一连接把前提改掉')

check('C3 双连接：检查后、事务前把 trip 改成 done → 拒 TRIP_NOT_OPEN，一行都不写', () => {
  const { file, db } = freshFileDb()
  const store = createSqliteStore(db)
  const other = secondConnection(file)

  // 装进容器而不是用裸 `let x = null`：TS 的控制流分析不认为闭包里的赋值发生过，
  // 读完仍是 null 类型，断言非空后反而收窄成 never（a 报的 7 处里有 5 处是这个）。
  // 属性访问不做这种窄化，声明类型一直是 `AttackOutcome | null`。
  const attack: { result: AttackOutcome | null } = { result: null }
  const guarded = attackingStore(store, () => {
    // 事务还没开，这次改是**会成功的** —— 这正是要堵的窗口。
    attack.result = tryWrite(() => {
      other
        .prepare(`UPDATE trip SET status = 'done', ended_at = ? WHERE id = 'trip_a1'`)
        .run(T0)
    })
  })

  assert.throws(
    () =>
      meet({
        store: guarded,
        dogId: A,
        otherDogId: B,
        tripId: 'trip_a1',
        outgoing: { kind: 'greeting', payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' } },
        now: T0,
      }),
    (err: Error) => {
      assert.match(err.message, /TRIP_NOT_OPEN|done/)
      return true
    },
  )

  const outcome = attack.result
  assert.ok(outcome !== null, '攻击必须在事务开始前触发')
  assert.equal(outcome.blocked, false, '事务外改状态是允许发生的 —— 所以必须在事务内重验，而不是假设它不会发生')

  assert.equal(countRows(db, 'exchange'), 0, '前提已失效就不能留下 exchange')
  assert.equal(countRows(db, 'relation'), 0, '关系也不能留 —— 否则下一轮把它当老关系')

  other.close()
  db.close()
})

check('C4 双连接：检查后、事务前把这一对拉黑 → 拒 BLOCKED_RELATION，一行都不写', () => {
  const { file, db } = freshFileDb()
  const store = createSqliteStore(db)
  const other = secondConnection(file)

  const guarded = attackingStore(store, () => {
    other
      .prepare(
        `INSERT INTO relation (id, dog_a, dog_b, first_met_at, last_met_at, met_count, is_blocked, blocked_at)
         VALUES ('rel_a__b', ?, ?, ?, ?, 1, 1, ?)`,
      )
      .run(A, B, T0, T0, T0)
  })

  assert.throws(
    () =>
      meet({
        store: guarded,
        dogId: A,
        otherDogId: B,
        tripId: 'trip_a1',
        outgoing: { kind: 'greeting', payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' } },
        now: T0,
      }),
    /BLOCKED_RELATION|拉黑/,
  )

  assert.equal(countRows(db, 'exchange'), 0)
  assert.equal(countRows(db, 'relation'), 1, '只应有攻击插的那一条拉黑记录，没有相遇写的关系')

  other.close()
  db.close()
})

check('C5 gate 会被调两次（事务外快速拒 + 事务内重验），约定无副作用', () => {
  const { db } = freshFileDb()
  const store = createSqliteStore(db)
  let calls = 0

  meet({
    store,
    dogId: A,
    otherDogId: B,
    tripId: 'trip_a1',
    outgoing: { kind: 'greeting', payload: { kind: 'greeting', line: '我这边晴。', weather: '晴' } },
    now: T0,
    gate: () => {
      calls += 1
      return { ok: true }
    },
  })

  assert.equal(calls, 2, 'gate 必须跑两次：外层一次、事务内一次；只跑一次就说明重验没接上')
  db.close()
})

// ===========================================================================
// 三、SAVEPOINT 的释放
// ===========================================================================
//
// 断言手法：`RELEASE` 一个已经释放的 savepoint 会报 `no such savepoint`。
// 反过来说 —— 如果它**没报错**，说明这个 savepoint 还挂在栈上。
// 这依赖 `sqlite-store.ts` 里的命名 `sp_d4_<n>`；改名要连这里一起改。

console.log('\n三、SAVEPOINT —— 成功路径也要 RELEASE')

function expectReleased(db: DatabaseSync, sp: string): void {
  assert.throws(
    () => db.exec(`RELEASE ${sp}`),
    /no such savepoint/,
    `${sp} 应当已被释放，但还能 RELEASE —— 说明成功路径漏了 RELEASE`,
  )
}

check('C6 内层成功后立即 RELEASE（原来只有失败路径才释放）', () => {
  const { db } = freshFileDb()
  const store = createSqliteStore(db)

  store.transaction(() => {
    store.transaction(() => {
      store.insertExchange({
        id: 'ex_sp_1',
        fromDog: A,
        toDog: B,
        kind: 'greeting',
        payload: { kind: 'greeting', line: 'x', weather: null },
        deliverAfterTripSeq: 1,
        createdAt: T0,
      })
    })
    // 内层已经返回，它的 savepoint 此刻必须不在了。
    expectReleased(db, 'sp_d4_1')
  })

  assert.equal(countRows(db, 'exchange'), 1)
  db.close()
})

check('C7 连着两次内层成功 → 各自释放，名字不撞（原来两次都叫 sp_d4_1）', () => {
  const { db } = freshFileDb()
  const store = createSqliteStore(db)

  store.transaction(() => {
    for (const id of ['ex_seq_1', 'ex_seq_2']) {
      store.transaction(() => {
        store.insertExchange({
          id,
          fromDog: A,
          toDog: B,
          kind: 'greeting',
          payload: { kind: 'greeting', line: id, weather: null },
          deliverAfterTripSeq: 1,
          createdAt: T0,
        })
      })
    }
    expectReleased(db, 'sp_d4_1')
    expectReleased(db, 'sp_d4_2')
  })

  assert.equal(countRows(db, 'exchange'), 2, '连着两次内层都成功，两条都该留下')
  db.close()
})

check('C8 三层嵌套成功 → 层数递减、三个都释放、数据全留', () => {
  const { db } = freshFileDb()
  const store = createSqliteStore(db)

  store.transaction(() => {
    store.transaction(() => {
      store.transaction(() => {
        store.insertExchange({
          id: 'ex_deep',
          fromDog: A,
          toDog: B,
          kind: 'greeting',
          payload: { kind: 'greeting', line: 'deep', weather: null },
          deliverAfterTripSeq: 1,
          createdAt: T0,
        })
      })
      expectReleased(db, 'sp_d4_3')
    })
    expectReleased(db, 'sp_d4_2')
  })

  expectReleased(db, 'sp_d4_1')
  assert.equal(countRows(db, 'exchange'), 1)
  db.close()
})

check('C9 内层失败被外层接住 → 只撤内层，且 savepoint 不留', () => {
  const { db } = freshFileDb()
  const store = createSqliteStore(db)

  store.transaction(() => {
    store.insertExchange({
      id: 'ex_keep',
      fromDog: A,
      toDog: B,
      kind: 'greeting',
      payload: { kind: 'greeting', line: 'keep', weather: null },
      deliverAfterTripSeq: 1,
      createdAt: T0,
    })
    try {
      store.transaction(() => {
        store.insertExchange({
          id: 'ex_drop',
          fromDog: A,
          toDog: B,
          kind: 'greeting',
          payload: { kind: 'greeting', line: 'drop', weather: null },
          deliverAfterTripSeq: 1,
          createdAt: T0,
        })
        throw new Error('内层失败')
      })
    } catch {
      /* 外层接住：这正是 C8「验权失败但继续」的形状 */
    }
    expectReleased(db, 'sp_d4_1')
  })

  assert.equal(countRows(db, 'exchange'), 1, '只留外层那条')
  const left = db.prepare(`SELECT id FROM exchange`).get() as { id: string }
  assert.equal(left.id, 'ex_keep')
  db.close()
})

check('C10 外层失败 → 全撤（含已成功的内层），depth 归零后还能继续用这个 store', () => {
  const { db } = freshFileDb()
  const store = createSqliteStore(db)

  assert.throws(() =>
    store.transaction(() => {
      store.transaction(() => {
        store.insertExchange({
          id: 'ex_inner_ok',
          fromDog: A,
          toDog: B,
          kind: 'greeting',
          payload: { kind: 'greeting', line: 'inner', weather: null },
          deliverAfterTripSeq: 1,
          createdAt: T0,
        })
      })
      throw new Error('外层失败')
    }),
  )
  assert.equal(countRows(db, 'exchange'), 0, '内层成功过也要跟着外层一起撤')

  // depth 复位验证：上一轮炸完之后，这个 store 还能正常开新事务。
  store.transaction(() => {
    store.insertExchange({
      id: 'ex_after_crash',
      fromDog: A,
      toDog: B,
      kind: 'greeting',
      payload: { kind: 'greeting', line: 'after', weather: null },
      deliverAfterTripSeq: 1,
      createdAt: T0,
    })
  })
  assert.equal(countRows(db, 'exchange'), 1, '失败后 depth 必须复位，否则后面的事务全乱')
  db.close()
})

// ===========================================================================
// 汇总
// ===========================================================================

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 })
} catch {
  /* Windows 上文件句柄偶尔还没落下，临时目录留着即可，不能因此把用例结果盖掉 */
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
