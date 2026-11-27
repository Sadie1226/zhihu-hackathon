/**
 * 定向检查 `withTemporaryEnv` 的还原行为。
 *
 * 为什么要单独测：上一版是在 `signSecondDevice` 里手写还原的，有三个洞 ——
 *   · `process.env.NODE_ENV = saved.nodeEnv` 在原值不存在时留下字符串 `"undefined"`；
 *   · `new DatabaseSync()` 写在 try 外面，开库失败时 finally 不执行，环境不还原；
 *   · 恢复只覆盖"正常返回"，没有任何用例真跑过"抛错路径"。
 * 这三个洞都不会让 25 项变红，只会把脏环境留给同一进程里的后续代码。
 *
 * 覆盖：原变量不存在 / 有原值 × 正常返回 / 抛错，另加开库失败与异步误用两条。
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { withTemporaryEnv } from './env-guard.mjs'

const KEYS = ['NODE_ENV', 'APP_IDENTITY_PROVIDER', 'DATABASE_PATH']

/** 让三个键回到"全都不存在"，并清掉可能残留的字符串 undefined。 */
function clearEnv() {
  for (const key of KEYS) delete process.env[key]
}

/** 快照三个键的真实存在性与值，用来做逐键比对。 */
function snapshotEnv() {
  return Object.fromEntries(KEYS.map((key) => [key, { present: key in process.env, value: process.env[key] }]))
}

function assertSameEnv(before, when) {
  for (const key of KEYS) {
    assert.equal(
      key in process.env,
      before[key].present,
      `${when}：${key} 的存在性应恢复为 ${before[key].present}`,
    )
    if (before[key].present) {
      assert.equal(process.env[key], before[key].value, `${when}：${key} 的值应恢复为原值`)
    } else {
      // 这一条是上一版真正的病：不存在被"还原"成字符串 "undefined"。
      // 只在原值不存在时才有意义 —— 原值本身可能就是字符串 "undefined"。
      assert.notEqual(process.env[key], 'undefined', `${when}：${key} 不能变成字符串 "undefined"`)
    }
  }
}

test('原变量不存在 + 正常返回 → 仍不存在，不留下字符串 undefined', () => {
  clearEnv()
  const before = snapshotEnv()
  const out = withTemporaryEnv(
    { NODE_ENV: 'development', APP_IDENTITY_PROVIDER: 'development', DATABASE_PATH: '/tmp/whatever.sqlite' },
    () => {
      assert.equal(process.env.NODE_ENV, 'development', 'fn 执行期间应看到临时值')
      return 'ok'
    },
  )
  assert.equal(out, 'ok')
  assertSameEnv(before, '正常返回')
})

test('原变量有值 + 正常返回 → 精确恢复原值', () => {
  clearEnv()
  process.env.NODE_ENV = 'test'
  process.env.APP_IDENTITY_PROVIDER = 'zhihu'
  process.env.DATABASE_PATH = '/data/real.sqlite'
  const before = snapshotEnv()
  withTemporaryEnv(
    { NODE_ENV: 'development', APP_IDENTITY_PROVIDER: 'development', DATABASE_PATH: '/tmp/whatever.sqlite' },
    () => {},
  )
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.APP_IDENTITY_PROVIDER, 'zhihu')
  assert.equal(process.env.DATABASE_PATH, '/data/real.sqlite')
  assertSameEnv(before, '正常返回')
})

test('原变量不存在 + 抛错 → 仍不存在', () => {
  clearEnv()
  const before = snapshotEnv()
  assert.throws(
    () => withTemporaryEnv({ NODE_ENV: 'development', APP_IDENTITY_PROVIDER: 'development' }, () => {
      throw new Error('业务炸了')
    }),
    /业务炸了/,
  )
  assertSameEnv(before, '抛错返回')
})

test('原变量有值 + 抛错 → 恢复原值', () => {
  clearEnv()
  process.env.NODE_ENV = 'test'
  process.env.DATABASE_PATH = '/data/real.sqlite'
  const before = snapshotEnv()
  assert.throws(
    () => withTemporaryEnv({ NODE_ENV: 'development', DATABASE_PATH: '/tmp/whatever.sqlite' }, () => {
      throw new Error('业务炸了')
    }),
    /业务炸了/,
  )
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.DATABASE_PATH, '/data/real.sqlite')
  assertSameEnv(before, '抛错返回')
})

test('开库失败（连接没拿到）→ 环境照样还原，不因 close 崩在 undefined 上', () => {
  clearEnv()
  const before = snapshotEnv()
  // 目录不存在，DatabaseSync 会直接抛（SQLITE_CANTOPEN）；此时 db 从未被赋值。
  const doomed = 'Z:/no-such-dir-for-d9/a5-development-.sqlite'
  assert.throws(() =>
    withTemporaryEnv({ NODE_ENV: 'development', DATABASE_PATH: doomed }, () => {
      let db
      try {
        db = new DatabaseSync(doomed)
      } finally {
        // 这就是 signSecondDevice 的形状：只有拿到才关。
        if (db) db.close()
      }
    }),
  )
  assertSameEnv(before, '开库失败')
})

test('环境里本来就存着字符串 "undefined" → 按存在性判断，不被误删也不被改写', () => {
  clearEnv()
  process.env.DATABASE_PATH = 'undefined'
  const before = snapshotEnv()
  withTemporaryEnv({ DATABASE_PATH: '/tmp/whatever.sqlite' }, () => {})
  assert.equal('DATABASE_PATH' in process.env, true, '原值存在就必须还在')
  assert.equal(process.env.DATABASE_PATH, 'undefined', '按值判断的实现会把它误删，按 in 判断才会保留')
  assertSameEnv(before, '字符串 undefined 原值')
})

test('传异步 fn 直接拒绝，并仍还原环境（不静默降级）', () => {
  clearEnv()
  const before = snapshotEnv()
  assert.throws(
    () => withTemporaryEnv({ NODE_ENV: 'development' }, async () => {}),
    /只支持同步 fn/,
  )
  assertSameEnv(before, '异步误用')
})
