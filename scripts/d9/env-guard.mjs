/**
 * 临时改几个环境变量、跑一段同步代码、**无论中间怎么炸都还原成原样**。
 *
 * 抽出来单独放，是为了能直接对"还原"这件事做定向测试 —— 它藏在
 * `two-device-parity.mjs` 里时，只能靠跑完整 25 项间接观察，测不出开库失败那条路径。
 *
 * 三个坑（前两版都踩过）：
 *
 *   1. `process.env.X = undefined` **不会删掉变量**，Node 会把它转成字符串
 *      `"undefined"`。于是"还原"之后环境里凭空多出一个看着像值的东西，
 *      后面再读 `DATABASE_PATH` 拿到的是 `"undefined"` 而不是"没有"。
 *      原值不存在时必须 `delete`。
 *   2. "原来有没有这个变量"要用 `key in process.env` 判断，不能看值是否为 undefined。
 *      万一环境里本来就存了字符串 `"undefined"`，按值判断会把它误删。
 *   3. 拿资源（开库、开连接）如果写在 try 外面，它自己失败时 finally 不执行，
 *      环境就永久留在被改过的状态。所以拿资源必须在 try 里，回收要判资源是否到手。
 *
 * 只接受同步 `fn`：异步函数会在 Promise 落定前就走到 finally，
 * 还原比业务代码先跑，等于没还原。传进来是 thenable 直接抛错，不静默降级。
 */
export function withTemporaryEnv(overrides, fn) {
  const saved = []
  for (const key of Object.keys(overrides)) {
    saved.push({ key, present: key in process.env, value: process.env[key] })
    process.env[key] = overrides[key]
  }
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      throw new TypeError('withTemporaryEnv 只支持同步 fn：异步函数会在 Promise 落定前就还原环境')
    }
    return result
  } finally {
    for (const { key, present, value } of saved) {
      if (present) process.env[key] = value
      else delete process.env[key]
    }
  }
}
