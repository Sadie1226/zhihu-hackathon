/**
 * d9 双设备一致性 —— 两台设备上是不是「同一个故事」
 *
 * d7 证明的是「一条链能走通」。d9 要证的是另一件事：
 * **同一段经历在两台设备上必须是同一份**（不变量五：一段经历只有一个出处）。
 * 「能走通」和「两边看到的是同一份」是两件事 —— 后者错了，用户会觉得被骗，
 * 而后者恰好不会有任何报错。
 *
 * 三个设备身份：
 *   dev1  = ownerA 的第一台设备（真 HTTP 开发登录）
 *   dev2  = ownerB 的设备（真 HTTP 开发登录）
 *   dev1b = ownerA 的第二台设备（服务端直接签发的第二个会话）
 *          ⚠ 这一条不是 HTTP 登录换来的：脚本按同一 owner 再签一个 session 模拟
 *            「甲换了台手机」。证据里标 `simulated: true`，不当成真机。
 *
 * 验什么（每条都是「两份读数必须逐字段相等」，不是「请求返回 200」）：
 *   1. 甲寄话 → 乙狗出发时送达（时间口径：两边读到的 UTC 字符串逐字符相等）
 *   2. 甲从 from_dog 读 vs 乙从 to_dog 读 → 同一个 exchange id、同 payload、
 *      同 deliveredAt / readAt / repliedAt
 *   3. 甲的第二台设备（dev1b）读到与 dev1 完全相同的一行 —— 换设备，故事还在
 *   4. 乙点开两次 → readAt 只写一次、值不变
 *   5. 乙回 → 甲两台设备看到的 repliedAt 一致
 *   6. 库内该 exchange 1 行、reply 1 行（不是每台设备一份）
 *   7. 第三方 ownerC 的收件箱里没有这条（不串味）
 *
 * 外加一条时间窗反例，补 d6 被 A 补掉的 TOCTOU：
 *   会话在「服务端读完 body 之前」被撤销 → 写必须失败、且不留残行。
 *   （d7 的三条反例全是横向越权，没有一条带时间窗。）
 *
 * 边界：开发服务、开发身份、单机多会话、无 UI 操作、无真双物理设备、无举报屏蔽。
 * **不把单机多会话说成真双设备**：真机部分需要手机连本机 LAN 地址单独验证，
 * 脚本只在**运行期间**绑 0.0.0.0 并打印地址，结束即停服务，不是常驻预览。
 *
 * 跑法：
 *   node scripts/d9/two-device-parity.mjs --db <新库> --out <证据.json> \
 *     --expected-sha <sha> [--allow-dirty] [--lan]
 *   `--lan` 让服务在本次运行期间绑 0.0.0.0 并打印局域网地址。
 *   打印出地址 ≠ 第二台设备已能连上（校园网可能有客户端隔离），真机由 A 协调。
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { networkInterfaces } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { issueOwnerSession } from '../../lib/auth/session.ts'
import { withTemporaryEnv } from './env-guard.mjs'

const WORDS = '楼下的桂花开了，你那边闻得到吗'
const ANSWER = '闻得到，风是从西边来的'
// 两个标记串：一个用于确认「被拒的没写进去」，一个用于确认「对照那条真的写进去了」。
const TOCTOU_MARK = 'd9-toctou-midbody-revoke'
const CONTROL_MARK = 'd9-control-split-body'
const LIVE_PROOF_MARK = 'd9-live-proof-same-session'

// ===========================================================================
// 参数
// ===========================================================================

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const dbPath = resolve(arg('db') ?? './tmp-d9/a5-development-d9.sqlite')
const outPath = resolve(arg('out') ?? './tmp-d9/d9-two-device.json')
const lanMode = process.argv.includes('--lan')
const expectedSha = arg('expected-sha', null)
const allowDirty = process.argv.includes('--allow-dirty')

/**
 * 为什么是 `next dev` 而不是 `next start`：
 *
 * 生产模式下 `developmentEnabled()` 恒为 false（`NODE_ENV === 'production'` 直接排除），
 * 本地没有知乎 OAuth 就登不进去 —— 这是**有意的护栏**，不是绕不过的坑：
 * 开发身份只在 `a5-development*.sqlite` 这种「一眼看出是本地库」的文件上开放。
 * 换库名去骗开关等于自己拆护栏，不干。
 *
 * 所以本地真实 HTTP 走 dev server + 开发身份；上线走知乎身份。两条路都真，
 * 只是本地这条能自动跑。证据里会写明这一点，不冒充「生产环境已验证」。
 */
if (!/a5-development(?:-[a-z0-9-]+)?\.sqlite$/i.test(dbPath)) {
  throw new Error(`本脚本走开发身份，库名必须是 a5-development*.sqlite，收到 ${dbPath}`)
}

// ===========================================================================
// 代码身份：自己查，不是「你说我记」
// ===========================================================================
//
// 上一版 `--code-sha` 只是把参数原样抄进证据——传什么就记什么，
// 于是「证据说它跑在 bdd86af 上」这件事从来没有被验证过。这等于给证据留了后门：
// 代码改了、或者传错一个 SHA，证据照样漂亮。
//
// 现在改成：
//   · HEAD 由 `git rev-parse` 现取；
//   · tracked 改动由 `git status --porcelain` 现取（untracked 不算，那是本次产物）；
//   · `--expected-sha` 给了就必须等于 HEAD，不等直接拒绝出证据；
//   · 工作区有 tracked 改动也拒绝，除非显式 `--allow-dirty`（此时 `formal: false`）。

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Windows 上 `git` 常不在 PATH（PowerShell 里尤其），`GIT_EXE` 是队里既有的兜底。
 * 找不到就明确报错 —— 静默记一个 `unknown` 又变成后门了。
 */
function resolveGit() {
  for (const bin of [process.env.GIT_EXE, 'git'].filter(Boolean)) {
    try {
      execFileSync(bin, ['--version'], { cwd: repoRoot, stdio: 'pipe' })
      return bin
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到 git，无法核验代码身份。请把 git 加进 PATH，或设置 GIT_EXE 指向 git.exe')
}

const gitBin = resolveGit()
// `core.quotepath=false`：不然中文路径会被转义成 `"\346\215\216..."`，比对全废。
const gitOut = (...args) =>
  execFileSync(gitBin, ['-c', 'core.quotepath=false', ...args], { cwd: repoRoot, encoding: 'utf8' }).trim()

/** 本次运行自己产出的文件，不该被算成「源码被改过」。 */
function artifactPaths() {
  return new Set(
    [
      dbPath,
      `${dbPath}-wal`,
      `${dbPath}-shm`,
      dbPath.replace(/\.sqlite$/i, '.evidence.sqlite'),
      outPath,
    ].map((p) => p.replace(/\\/g, '/').toLowerCase()),
  )
}

function readCodeIdentity() {
  const head = gitOut('rev-parse', 'HEAD')
  const artifacts = artifactPaths()
  // 不能用 gitOut：它 trim 了整段输出，而 ` M path` 的**前导空格本身就是状态码的一部分**。
  // 被 trim 掉再 slice(3)，路径就会少首字母 —— 我第一版就是这么错的。
  const raw = execFileSync(gitBin, ['-c', 'core.quotepath=false', 'status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const entries = raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      code: line.slice(0, 2),
      // 重命名是 `R  old -> new`，只关心新路径。
      path: line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop(),
    }))
  const trackedDirty = entries.filter(
    (e) => !e.code.includes('?') && !artifacts.has(resolve(repoRoot, e.path).replace(/\\/g, '/').toLowerCase()),
  )
  return { head, trackedDirty, untracked: entries.filter((e) => e.code.includes('?')).length }
}

function refuse(reason) {
  process.stderr.write(`\n拒绝出证据：${reason}\n`)
  process.exit(1)
}

const codeIdentity = readCodeIdentity()
if (expectedSha && codeIdentity.head !== expectedSha) {
  refuse(`实际 HEAD ${codeIdentity.head} ≠ 期望 ${expectedSha}。要按实际代码出证据，就别传 --expected-sha。`)
}
if (codeIdentity.trackedDirty.length > 0 && !allowDirty) {
  refuse(
    `工作区有 ${codeIdentity.trackedDirty.length} 处 tracked 改动：\n` +
      codeIdentity.trackedDirty.map((e) => `  ${e.code} ${e.path}`).join('\n') +
      '\n正式证据必须来自干净已提交源码。先提交，或加 --allow-dirty（证据会标 formal:false）。',
  )
}

const codeEvidence = {
  head: codeIdentity.head,
  expected: expectedSha,
  matchesExpected: expectedSha ? true : null,
  dirty: codeIdentity.trackedDirty.length > 0,
  dirtyFiles: codeIdentity.trackedDirty.map((e) => `${e.code} ${e.path}`),
  formal: codeIdentity.trackedDirty.length === 0 && (!expectedSha || codeIdentity.head === expectedSha),
  /**
   * formal 的作用域必须写明：它只覆盖「本次证据跑在哪个提交、工作区干不干净」。
   * 不代表 D9 整体验收通过，更不代表 P0 终验 —— 那些由 A 在取入 main 后做组合复验。
   */
  formalScope: 'formal 仅表示本次证据的代码身份（HEAD）与 tracked 干净状态；不代表 D9 全部验收，也不代表 P0 终验。',
  server: 'next dev --webpack（开发服务，非生产构建）',
  login: 'development（开发身份，非知乎身份）',
  deviceModel: '单机多会话（dev1 / dev2 / dev1b），非两台物理设备；其中 dev1b 由 issueOwnerSession 直接签发（simulated）',
  notCovered: [
    '真双物理设备（需同一局域网内第二台机器/手机）',
    '完整双账号 UI 长链（无 UI 操作，全部走 HTTP）',
    '举报与屏蔽路径',
  ],
  lanMode,
  lanModeNote: lanMode
    ? '--lan 仅在本次运行期间把服务绑到 0.0.0.0 并打印局域网地址；脚本 finally 会 stop 服务，不是常驻真机预览。'
      + ' 打印出地址不等于第二台设备已能连上（校园网可能有客户端隔离），真机验证由 A 协调服务与人工完成。'
    : null,
  node: process.version,
  command: [process.execPath, ...process.argv.slice(1)].join(' '),
  repoRoot,
  capturedAt: new Date().toISOString(),
}

// ===========================================================================
// 服务
// ===========================================================================

async function freePort() {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise((done, fail) => probe.close((error) => (error ? fail(error) : done())))
  return port
}

function lanAddress() {
  const found = Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
  return found.length > 0 ? found[0].address : null
}

async function startServer() {
  mkdirSync(dirname(dbPath), { recursive: true })
  const port = await freePort()
  // --lan 时绑 0.0.0.0：只是让第二台设备"有机会"连进来，能不能连通取决于网络策略
  // （校园网常有客户端隔离）。本机访问仍走 127.0.0.1。服务在本脚本结束时关闭。
  const host = lanMode ? '0.0.0.0' : '127.0.0.1'
  const base = `http://127.0.0.1:${port}`
  // `--webpack`：本工作树的 node_modules 是指向主仓的 junction，turbopack 会把它判成坏软链。
  const child = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', host, '--port', String(port)],
    {
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        APP_IDENTITY_PROVIDER: 'development',
        DATABASE_PATH: dbPath,
        ZHIHU_ACCESS_SECRET: '',
      },
    },
  )
  const exited = once(child, 'exit')
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  }
  for (let attempt = 0; attempt < 600; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('服务在就绪前退出')
    try {
      if ((await fetch(base, { signal: AbortSignal.timeout(2000) })).ok) {
        return { base, stop, lanUrl: lanMode && lanAddress() ? `http://${lanAddress()}:${port}` : null }
      }
    } catch { /* 还没起来，继续等 */ }
    await setTimeout(200)
  }
  await stop()
  throw new Error('服务就绪超时（200ms × 600）')
}

// ===========================================================================
// HTTP
// ===========================================================================

const trail = []

function record(step, note, data) {
  trail.push({ step, note, ...data })
  const mark = data.status === undefined ? '' : ` ${data.status}`
  process.stdout.write(`  ${step}${mark}\n`)
  return data
}

async function call(base, step, note, { method = 'GET', path, cookie, body, headers = {}, expect = 200 }) {
  const all = { ...headers }
  if (cookie) all.cookie = cookie
  if (body !== undefined) all['content-type'] = 'application/json'
  if (method !== 'GET') all.origin = base
  const response = await fetch(base + path, {
    method,
    headers: all,
    body: body === undefined ? undefined : JSON.stringify(body),
    // dev server 首次访问某路由要现编译，10s 不够。
    signal: AbortSignal.timeout(120000),
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : null
  record(step, note, {
    method, path, status: response.status, cacheControl: response.headers.get('cache-control'),
  })
  if (response.status !== expect) {
    throw new Error(`${step} 期望 ${expect} 实得 ${response.status}：${text.slice(0, 300)}`)
  }
  return { json, setCookie: response.headers.get('set-cookie'), status: response.status }
}

const cookieOf = (setCookie) => {
  if (!setCookie) throw new Error('登录没拿到 Set-Cookie')
  return setCookie.split(';', 1)[0]
}

/** 按 E 的领养流程走一遍：登录 → 生成性格 → 建狗。 */
async function adopt(base, who, name) {
  const draft = { name, interestCategories: ['自然风景', '手作与食物'], tendencies: [0.4, -0.2, 0.6, 0, -0.4, 0.2] }
  const { setCookie } = await call(base, `${who}.login`, '开发登录（建 owner）', {
    method: 'POST', path: '/api/auth/development', body: {},
  })
  const cookie = cookieOf(setCookie)
  const { json: generated } = await call(base, `${who}.personality`, '生成性格词与指纹', {
    method: 'POST', path: '/api/adoption/personality', cookie, body: draft,
  })
  const { json: created } = await call(base, `${who}.adopt`, '领养，狗落库', {
    method: 'POST',
    path: '/api/dogs',
    cookie,
    body: {
      ...draft,
      assembly: { outfit: 'T01-frog', cloth: null, accessory: null, face: 'F04-smile' },
      fingerprint: generated.fingerprint,
      requestId: randomUUID(),
    },
  })
  return { cookie, dog: created.dog }
}

/**
 * 给同一 owner 再签一个会话 = 「这个人换了台手机」。
 *
 * ⚠ 这条不是 HTTP 登录换来的：`POST /api/auth/development` 没带 cookie 时会新建 owner，
 * 拿不到「同一个 owner 的第二个设备」。所以直接调服务端同一个 `issueOwnerSession()`，
 * 用同一个 provider_subject 签第二个 token。证据里标 `simulated: true`。
 *
 * ⚠ 为什么取证进程要临时补环境：`issueOwnerSession()` → `activeNamespace()` 会
 * 一边读 `process.env`（NODE_ENV / APP_IDENTITY_PROVIDER / DATABASE_PATH），
 * 一边核实际库文件的 realpath 与开发库命名；对齐之后，才按**库内**记录的
 * namespace / provider / subject 去读身份。所以这里补环境只是让"它认的是同一个库"，
 * 身份本身仍从库里读 —— 不是"它只看 env、不读库"。脚本进程本来没有这几个变量
 * （只有 next dev 子进程有），不补会抛 `Identity namespace unavailable`，
 * 那是环境没对齐，不是权限问题。产品的隔离校验保持原样，不为模拟开任何签发口子。
 */
function signSecondDevice(dogId) {
  return withTemporaryEnv(
    { NODE_ENV: 'development', APP_IDENTITY_PROVIDER: 'development', DATABASE_PATH: dbPath },
    () => {
      let db
      try {
        // 开库放在 try 内：开库本身失败时也要走回收，环境不能留在改过的状态。
        db = new DatabaseSync(dbPath)
        db.exec('PRAGMA busy_timeout = 5000')
        const row = db
          .prepare(`SELECT o.id AS ownerId, o.namespace AS namespace, o.provider_subject AS subject
            FROM dog d JOIN owner o ON o.id = d.owner_id WHERE d.id = ?`)
          .get(dogId)
        if (!row) throw new Error(`狗 ${dogId} 没有 owner，签不出第二台设备`)
        const issued = issueOwnerSession(db, { provider: row.namespace, subject: row.subject })
        return { cookie: issued.setCookie.split(';', 1)[0], ownerId: issued.ownerId, simulated: true }
      } finally {
        // 只关真正拿到的连接。开库失败时 db 还是 undefined。
        if (db) db.close()
      }
    },
  )
}

/** 撤销该 owner 名下所有活着的会话（模拟人主动退出登录）。 */
function revokeSessionsOf(dogId) {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const owner = db.prepare('SELECT owner_id AS ownerId FROM dog WHERE id = ?').get(dogId)
    if (!owner?.ownerId) throw new Error(`狗 ${dogId} 没有 owner`)
    const info = db
      .prepare('UPDATE owner_session SET revoked_at = MAX(created_at, ?) WHERE owner_id = ? AND revoked_at IS NULL')
      .run(Date.now(), owner.ownerId)
    return info.changes
  } finally {
    db.close()
  }
}

/**
 * 分两截发 body，**中间留一个钩子**。
 *
 * 这是复现 TOCTOU 的唯一办法：服务端先解析 auth，再 `await request.json()`；
 * 只要 body 没读完，那个 await 就挂着。此刻撤销会话，再放行后半截，
 * 就能让「auth 是旧的、写的时候已经失效」这个时间窗真实发生。
 *
 * 不用 `duplex: 'half'` 的话 undici 直接拒绝流式 body。
 */
async function sendWithSplitBody({ base, cookie, body, onFirstHalf }) {
  const payload = JSON.stringify(body)
  const half = Math.max(1, Math.floor(payload.length / 2))
  const encoder = new TextEncoder()
  let openGate
  const gate = new Promise((release) => { openGate = release })
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(payload.slice(0, half)))
      await gate
      controller.enqueue(encoder.encode(payload.slice(half)))
      controller.close()
    },
  })
  const pending = fetch(`${base}/api/exchanges`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: base,
      cookie,
      'idempotency-key': `d9-split-${randomUUID()}`,
    },
    body: stream,
    duplex: 'half',
    signal: AbortSignal.timeout(60000),
  })
  // 给服务端 500ms 去读 auth、进到 body 读取那一步。
  // 这是「给它机会」，不是「保证它已经到了那一步」：请求调度、框架层的 body 缓冲
  // 都可能让实际顺序与写脚本时的预期不同。所以本项不承诺「挂起的那一刻必然停在
  // await request.json() 上」；要那条时间窗有确定性保证，靠进程内回归（直接构造
  // 已撤销会话 + 已解析 auth），不靠 HTTP 时序碰运气。
  await setTimeout(500)
  const hook = onFirstHalf ? await onFirstHalf() : null
  openGate()
  const response = await pending
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null, hook }
}

/** 只读数一下某条 exchange 现在有几行（确认「拒了就没写」）。 */
function countExchangeRows(idempotencyMatch) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare(`SELECT count(*) AS n FROM exchange WHERE payload LIKE ?`).get(`%${idempotencyMatch}%`).n
  } finally {
    db.close()
  }
}

// ===========================================================================
// 主流程
// ===========================================================================

const started = Date.now()
// 主流程算完的事实，留给最后一步核快照用（fast-fail 时为空）。
const runState = { snapshot: null }
const server = await startServer()
const evidence = {
  kind: 'd9-two-device-parity',
  code: codeEvidence,
  meta: { base: server.base, lanUrl: server.lanUrl, dbPath, outPath, words: WORDS },
}

/** 三边读数取核心字段，比对必须逐字段相等。 */
const CORE_FIELDS = ['id', 'kind', 'payload', 'createdAt', 'deliveredAt', 'repliedAt']
const coreOf = (row) => {
  if (!row) return null
  const picked = {}
  for (const key of CORE_FIELDS) picked[key] = row[key] ?? null
  return picked
}

try {
  // ---- 0. 三个设备身份 ----
  const dev1 = await adopt(server.base, 'dev1', '阿桂')
  const dev2 = await adopt(server.base, 'dev2', '小满')
  // 甲的「第二台手机」：同 owner 再签一个会话（不经过 HTTP 登录，证据标 simulated）
  const dev1b = signSecondDevice(dev1.dog.id)
  const { json: dev1bSession } = await call(server.base, 'dev1b.session', '甲的第二台设备：同一个 owner、同一只狗', {
    path: '/api/session', cookie: dev1b.cookie,
  })
  if (dev1bSession.dog?.id !== dev1.dog.id) throw new Error('第二台设备看到的不是同一只狗')
  if (dev1b.cookie === dev1.cookie) throw new Error('第二台设备拿到的是同一个 cookie，等于没换设备')

  evidence.devices = {
    dev1: { owner: 'A', dogId: dev1.dog.id, how: 'http:POST /api/auth/development', simulated: false },
    dev2: { owner: 'B', dogId: dev2.dog.id, how: 'http:POST /api/auth/development', simulated: false },
    dev1b: {
      owner: 'A', dogId: dev1bSession.dog.id,
      how: 'issueOwnerSession（同一 owner 的第二会话，不经过 HTTP 登录）',
      simulated: true,
    },
  }

  // ---- 1. 甲寄话 ----
  const { json: sent } = await call(server.base, 'send', '甲（dev1）托狗捎话', {
    method: 'POST',
    path: '/api/exchanges',
    cookie: dev1.cookie,
    headers: { 'idempotency-key': `d9-${dev1.dog.id}-${randomUUID()}` },
    body: {
      fromDog: dev1.dog.id,
      toDog: dev2.dog.id,
      kind: 'co_owner_message',
      payload: { kind: 'co_owner_message', message: WORDS },
    },
  })
  const exchange = sent.exchange
  if (exchange.deliveredAt !== null) throw new Error('寄出就「已到」—— 即时到达被破')

  // ---- 2. 乙的狗出发：送达时刻 ----
  const { json: tripCreated } = await call(server.base, 'dev2.trip.create', '乙的狗安排出行', {
    method: 'POST', path: `/api/dogs/${encodeURIComponent(dev2.dog.id)}/trips`, cookie: dev2.cookie,
    body: { trigger: 'auto' },
  })
  const { json: tripStarted } = await call(server.base, 'dev2.trip.start', '出发（投递器写 delivered_at）', {
    method: 'POST', path: `/api/trips/${encodeURIComponent(tripCreated.trip.id)}/start`, cookie: dev2.cookie, body: {},
  })
  if (!tripStarted.delivered.some((row) => row.id === exchange.id)) throw new Error('出发了但没送到')

  // ---- 3. 乙点开两次：readAt 只写一次 ----
  const { json: firstRead } = await call(server.base, 'dev2.read.1', '乙第一次点开', {
    method: 'PATCH', path: `/api/exchanges/${encodeURIComponent(exchange.id)}/read`, cookie: dev2.cookie, body: {},
  })
  const readAtFirst = firstRead.exchange.readAt
  if (!readAtFirst) throw new Error('点开后 readAt 仍为空')
  const { json: secondRead } = await call(server.base, 'dev2.read.2', '乙连续重复点开（同一请求立刻再打一次，不涉及时钟推进）', {
    method: 'PATCH', path: `/api/exchanges/${encodeURIComponent(exchange.id)}/read`, cookie: dev2.cookie, body: {},
  })
  const readAtSecond = secondRead.exchange.readAt

  // ---- 4. 乙回一句 ----
  const { json: replied } = await call(server.base, 'dev2.reply', '乙回一句（真实 HTTP）', {
    method: 'POST', path: '/api/replies', cookie: dev2.cookie,
    body: { exchangeId: exchange.id, text: ANSWER },
  })
  if (!replied.reply?.id) throw new Error('回应返回 200 但没有 reply')

  // ---- 5. 三边读同一条：这才是 d9 的正题 ----
  const { json: boxA } = await call(server.base, 'dev1.outbox', '甲的第一台设备：发件箱', {
    path: `/api/exchanges?from_dog=${encodeURIComponent(dev1.dog.id)}`, cookie: dev1.cookie,
  })
  const { json: boxA2 } = await call(server.base, 'dev1b.outbox', '甲的第二台设备：发件箱（换设备）', {
    path: `/api/exchanges?from_dog=${encodeURIComponent(dev1.dog.id)}`, cookie: dev1b.cookie,
  })
  const { json: boxB } = await call(server.base, 'dev2.inbox', '乙的设备：收件箱', {
    path: `/api/dogs/${encodeURIComponent(dev2.dog.id)}/inbox?filter=arrived`, cookie: dev2.cookie,
  })
  const rowA = boxA.exchanges.find((row) => row.id === exchange.id)
  const rowA2 = boxA2.exchanges.find((row) => row.id === exchange.id)
  const rowB = boxB.exchanges.find((row) => row.id === exchange.id)
  if (!rowA || !rowA2 || !rowB) {
    throw new Error(`三边没有都读到同一条：dev1=${!!rowA} dev1b=${!!rowA2} dev2=${!!rowB}`)
  }

  const coreA = coreOf(rowA)
  const coreA2 = coreOf(rowA2)
  const coreB = coreOf(rowB)
  const parity = CORE_FIELDS.map((field) => ({
    field,
    dev1: coreA[field],
    dev1b: coreA2[field],
    dev2: coreB[field],
    equal: JSON.stringify(coreA[field]) === JSON.stringify(coreA2[field])
      && JSON.stringify(coreA[field]) === JSON.stringify(coreB[field]),
  }))
  // 每台设备各自有、但别人没有的字段，如实记下来（不是失败，是不对称）
  const asym = [...new Set([...Object.keys(rowA), ...Object.keys(rowA2), ...Object.keys(rowB)])]
    .filter((key) => new Set([key in rowA, key in rowA2, key in rowB]).size > 1)

  // ---- 6. 不串味：第三方看不见这条 ----
  const dev3 = await adopt(server.base, 'dev3', '阿柚')
  const { json: boxC } = await call(server.base, 'dev3.inbox', '第三方（dev3）的收件箱', {
    path: `/api/dogs/${encodeURIComponent(dev3.dog.id)}/inbox?filter=arrived`, cookie: dev3.cookie,
  })
  const { json: leaked } = await call(server.base, 'dev3.outbox.foreign', '第三方去读甲的狗的发件箱：应被拒（404）', {
    path: `/api/exchanges?from_dog=${encodeURIComponent(dev1.dog.id)}`, cookie: dev3.cookie, expect: 404,
  })

  // ---- 7. 库侧对账 ----
  const after = new DatabaseSync(dbPath, { readOnly: true })
  let facts
  try {
    const q = (sql, ...params) => after.prepare(sql).get(...params)
    facts = {
      integrity: q('PRAGMA integrity_check').integrity_check,
      foreignKeys: after.prepare('PRAGMA foreign_key_check').all().length,
      exchange: q(`SELECT id, from_dog AS fromDog, to_dog AS toDog, kind, payload,
        deliver_after_trip_seq AS seq, created_at AS createdAt, delivered_at AS deliveredAt,
        replied_at AS repliedAt, read_at AS readAt FROM exchange WHERE id = ?`, exchange.id),
      exchangeRows: q('SELECT count(*) AS n FROM exchange WHERE id = ?', exchange.id).n,
      replyRows: q('SELECT count(*) AS n FROM reply WHERE exchange_id = ?', exchange.id).n,
      replyRow: q('SELECT id, text, kind FROM reply WHERE exchange_id = ?', exchange.id),
      trips: after.prepare('SELECT id, seq, status, started_at AS startedAt FROM trip WHERE dog_id = ? ORDER BY seq')
        .all(dev2.dog.id),
    }
  } finally {
    after.close()
  }

  // ---- 8. 时间窗反例：读 body 期间撤销会话（补 d6 的 TOCTOU） ----
  // 对照组先跑：同一个分块发法、不撤销 → 必须 200，证明失败不是「流式 body」本身造成的
  const devCtrl = await adopt(server.base, 'dev.control', '对照')
  const control = await sendWithSplitBody({
    base: server.base,
    cookie: devCtrl.cookie,
    body: {
      fromDog: devCtrl.dog.id,
      toDog: dev2.dog.id,
      kind: 'co_owner_message',
      payload: { kind: 'co_owner_message', message: CONTROL_MARK },
    },
  })
  const devTail = await adopt(server.base, 'dev.tail', '竞态')
  const revoked = await sendWithSplitBody({
    base: server.base,
    cookie: devTail.cookie,
    body: {
      fromDog: devTail.dog.id,
      toDog: dev2.dog.id,
      kind: 'co_owner_message',
      payload: { kind: 'co_owner_message', message: TOCTOU_MARK },
    },
    onFirstHalf: async () => {
      /**
       * 关键一步：**证明撤销发生的那一刻，这个会话对这条连接还是有效的**。
       *
       * 未登录和复验拦下返回的是同一个 404、同一句 detail（`这条记录不在这里`），
       * 光看响应分不出「撤销太早，请求根本没通过首验」和「首验过了、是复验拦的」。
       * 所以在第一个请求还挂着 body 的这一刻，用**同一个会话**再打一条完整的写入：
       *   · 它 200 → 撤销之前会话确实有效，挂着的那个请求有机会读到有效 auth
       *   · 撤销 → 放行后半截 → 它 404，说明读 body 之后的那道校验起了作用
       *
       * ⚠ 这条推断的力度要说清：同会话 200 只证明「那个时刻会话有效」，
       * **不能严格推出挂起的请求必然已经走完首验**。请求调度、框架 body 缓冲
       * 都可能让实际顺序不同 —— 挂起请求有可能压根还没进到读 auth 那行。
       * 所以本项定位是**支持性证据**：它排除的是「撤销发生在请求还没被受理之前」
       * 这种平凡解释；「精确命中 await 窗口」的确定性保证，由已合 main 的
       * 进程内回归承担，不靠这条 HTTP 时序兜。
       */
      const proof = await call(server.base, 'toctou.liveProof', '挂起期间同一会话仍能正常写入（撤销时点会话有效）', {
        method: 'POST',
        path: '/api/exchanges',
        cookie: devTail.cookie,
        headers: { 'idempotency-key': `d9-live-${randomUUID()}` },
        body: {
          fromDog: devTail.dog.id,
          toDog: dev2.dog.id,
          kind: 'co_owner_message',
          payload: { kind: 'co_owner_message', message: LIVE_PROOF_MARK },
        },
      })
      // 记实得状态，不写死 200：call() 在非 200 时已经抛错，但证据里该出现的
      // 是这次请求真实返回的状态码，不是脚本希望它返回的那个数。
      return { liveProofStatus: proof.status, liveProofId: proof.json.exchange.id, revokedRows: revokeSessionsOf(devTail.dog.id) }
    },
  })

  runState.snapshot = {
    facts,
    exchangeId: exchange.id,
    senderDogId: dev1.dog.id,
    receiverDogId: dev2.dog.id,
  }

  // 「等回音」这条判定只有一份实现，这里不重写：直接用它算给证据。
  const { isWaitingForReply } = await import('../../lib/mailbox/service.ts')
  const checks = [
    ['第二台设备（dev1b）看到的是同一只狗', dev1bSession.dog?.id === dev1.dog.id],
    ['两套设备 cookie 不同', dev1.cookie !== dev1b.cookie],
    ['寄出即在路上', exchange.deliveredAt === null],
    ['送达时刻 = 出发时刻', rowB?.deliveredAt === tripStarted.trip.startedAt],
    ['乙点开两次，readAt 不变', readAtSecond === readAtFirst],
    ['回应落了库（1 行）', facts.replyRows === 1],
    ['回应的文字是乙写的那句', facts.replyRow?.text === ANSWER],
    ['exchange 只有 1 行（不是每台设备一份）', facts.exchangeRows === 1],
    ...parity.map((item) => [`三边一致：${item.field}`, item.equal]),
    ['回应后甲不再等', rowA ? !isWaitingForReply(rowA) : false],
    ['甲两台设备看到的 repliedAt 相同', rowA?.repliedAt === rowA2?.repliedAt && Boolean(rowA?.repliedAt)],
    ['三方箱子里没有这条（不串味）', boxC.exchanges.every((row) => row.id !== exchange.id)],
    ['第三方读别人的发件箱被拒（404）', leaked?.code === 'NOT_FOUND'],
    ['整库无外键问题', facts.foreignKeys === 0],
    ['integrity ok', facts.integrity === 'ok'],
    ['对照组：同一个分块发法不撤销 → 200', control.status === 200],
    ['三边字段集合完全相同（不对称字段数 = 0）', asym.length === 0],
    ['挂起期间同一会话仍能写（撤销时点会话有效，支持性证据）', revoked.hook?.liveProofStatus === 200],
    ['读完 body 之前撤销 → 写被拒（404）', revoked.status === 404],
    ['被拒的那条没留在库里', countExchangeRows(TOCTOU_MARK) === 0],
    ['对照组那条正常落库（证明检查本身没写坏）', countExchangeRows(CONTROL_MARK) === 1],
  ]

  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  evidence.chains = checks.map(([name, ok]) => ({ name, ok }))
  evidence.parity = parity
  evidence.asymmetricFields = asym
  evidence.toctou = {
    control: { status: control.status, marker: CONTROL_MARK },
    revokedMidBody: {
      status: revoked.status,
      revokedRows: revoked.hook?.revokedRows ?? null,
      liveProofStatus: revoked.hook?.liveProofStatus ?? null,
      liveProofExchangeId: revoked.hook?.liveProofId ?? null,
      marker: TOCTOU_MARK,
    },
    claimLevel: 'supporting',
    note: '服务端先解析 auth、再 await request.json()；body 分两截发送，第二截放行前先用同一会话完整写一条（200）再撤销。'
      + ' 这条 200 证明的是「撤销那一刻会话有效、挂起请求有机会读到有效 auth」，'
      + '**不能严格推出挂起请求必然已走完首验** —— 请求调度与框架 body 缓冲都可能改变实际顺序。'
      + ' 未登录与复验拦截返回同一个 404 与同一句 detail，所以仅凭响应分不出两者。',
    deterministicCoverage: '精确命中 await 窗口的保证由已合 main 的进程内回归承担（构造已撤销会话 + 已解析 auth），本项不替代它。',
    negativeValidation: '见 evidence/d9-negative-cdb9eb5.json（独立记录原 SHA、临时 diff 指纹、命令与实际结果、还原检查）。',
  }
  evidence.steps = trail
  evidence.facts = facts
  evidence.verdict = failed.length === 0 ? 'pass' : `fail: ${failed.join(' / ')}`
  evidence.elapsedMs = Date.now() - started
} finally {
  await server.stop()
}

mkdirSync(dirname(outPath), { recursive: true })
/**
 * **哈希算在「一致快照」上，不是算在现场库文件上。**
 *
 * 这台机器上跑完两轮，两次 `app.sqlite` 的 sha256 一模一样 —— 不是巧合，是因为
 * 数据全在 `-wal` 里、主库文件还停在「只有 schema」的状态。只对主文件求哈希，
 * 等于对着一份不含任何消息的空壳盖章。A 11/25 的更正说的就是这件事：
 * 空 WAL 可以忽略，**非空 WAL 必须算进去**。
 *
 * 先试过 `wal_checkpoint(TRUNCATE)`，在 Windows 上撞到 `SQLITE_IOERR_DELETE_NOENT`
 * （进程刚被杀，-shm 还映射着，checkpoint 删不掉 WAL）。所以改用 SQLite 自己的
 * 一致快照接口 `VACUUM INTO`：产物是自包含文件、不含 WAL，哈希才有唯一含义。
 */
const dbInfo = snapshotVerifyAndHash(dbPath, runState.snapshot)
evidence.db = dbInfo
if (dbInfo.problems.length > 0) {
  evidence.verdict = `fail: 快照核验（${dbInfo.problems.join(' / ')}）`
}
writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`)
process.stdout.write(
  `\n${evidence.verdict === 'pass' ? '全绿' : '有失败'} — ${evidence.chains?.filter((c) => c.ok).length}/${evidence.chains?.length} 项，` +
  `证据 ${outPath}\n` +
  `代码 HEAD ${evidence.code.head.slice(0, 12)}（${evidence.code.formal ? 'formal' : '非正式：dirty 或未传 expected-sha'}）\n` +
  `现场库 ${dbPath}（主文件 ${dbInfo.liveBytes} 字节 + wal ${dbInfo.liveWalBytes} 字节）\n` +
  `快照 ${dbInfo.snapshotPath}（${dbInfo.bytes} 字节，只读自核 ${dbInfo.problems.length === 0 ? '通过' : '失败'}）\n` +
  `sha256 ${dbInfo.sha256}\n`,
)
if (evidence.verdict !== 'pass') process.exitCode = 1


/**
 * 在**快照自己的连接**上核验，不留「拿源库的检查结果给快照盖章」的口子。
 *
 * 上一版就是那么干的：`VACUUM INTO` 之后在源连接上跑 `integrity_check`，
 * 然后直接对生成的快照文件算哈希。核的是源库 —— 快照要是拷漏了、截断了，
 * 一样「通过」。现在：关源连接 → 只读打开快照 → 核完整性/外键/本批核心行 →
 * 与源库已记录的事实逐项比对 → 全对上才允许算哈希并出 pass。
 */
function snapshotVerifyAndHash(path, ctx) {
  const snapshotPath = path.replace(/\.sqlite$/i, '.evidence.sqlite')
  try {
    unlinkSync(snapshotPath)
  } catch { /* 第一次跑就没有，正常 */ }
  // SQL 字符串里的路径用正斜杠，避免 Windows 反斜杠被当成转义。
  const target = snapshotPath.replace(/\\/g, '/').replace(/'/g, "''")
  const source = new DatabaseSync(path)
  try {
    /**
     * `next dev` 会起子进程，父进程被 kill 后那一小段时间里文件仍被映射着，
     * `VACUUM INTO` 会报 `SQLITE_IOERR`（10）。这不是数据坏了，是锁还没放干净 ——
     * 重试几次就过。**不重试的话，取证脚本会在最不该失败的地方随机红。**
     */
    let lastError
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        source.exec(`VACUUM INTO '${target}'`)
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
      }
    }
    if (lastError) throw lastError
  } finally {
    // 必须关掉源连接再核 —— 否则核的可能还是「正在被写的那一份」。
    source.close()
  }

  const problems = ctx
    ? verifySnapshot(snapshotPath, ctx)
    : ['主流程未走完，没有可与快照对账的事实']

  const bytes = readFileSync(snapshotPath)
  let liveWalBytes = 0
  try {
    liveWalBytes = readFileSync(`${path}-wal`).length
  } catch { /* 没有 wal 文件就是最干净的情况 */ }
  return {
    path,
    liveBytes: readFileSync(path).length,
    liveWalBytes,
    snapshotPath,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    openedReadOnly: true,
    checkedOn: 'snapshot（不是源库）',
    problems,
  }
}

/** 只读打开快照本体：完整性、外键、本批核心行，逐项与源库事实比对。 */
function verifySnapshot(snapshotPath, ctx) {
  const problems = []
  const db = new DatabaseSync(snapshotPath, { readOnly: true })
  try {
    const q = (sql, ...params) => db.prepare(sql).get(...params)
    const integrity = q('PRAGMA integrity_check').integrity_check
    if (integrity !== 'ok') problems.push(`snapshot integrity_check = ${integrity}`)
    const fk = db.prepare('PRAGMA foreign_key_check').all()
    if (fk.length > 0) problems.push(`snapshot 外键问题 ${fk.length} 条`)

    const same = (label, actual, expected) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`${label} 与源库不一致`)
    }
    same(
      'exchange 行',
      q(`SELECT id, from_dog AS fromDog, to_dog AS toDog, kind, payload,
        deliver_after_trip_seq AS seq, created_at AS createdAt, delivered_at AS deliveredAt,
        replied_at AS repliedAt, read_at AS readAt FROM exchange WHERE id = ?`, ctx.exchangeId),
      ctx.facts.exchange,
    )
    same(
      'reply 行',
      q('SELECT id, text, kind FROM reply WHERE exchange_id = ?', ctx.exchangeId),
      ctx.facts.replyRow,
    )
    same(
      'reply 条数',
      q('SELECT count(*) AS n FROM reply WHERE exchange_id = ?', ctx.exchangeId).n,
      ctx.facts.replyRows,
    )
    same(
      'trip 行',
      db.prepare('SELECT id, seq, status, started_at AS startedAt FROM trip WHERE dog_id = ? ORDER BY seq')
        .all(ctx.receiverDogId),
      ctx.facts.trips,
    )
    same(
      'exchange 条数',
      q('SELECT count(*) AS n FROM exchange WHERE id = ?', ctx.exchangeId).n,
      ctx.facts.exchangeRows,
    )
    // d9 特有：寄件狗在快照里也必须只出现一次这段经历（不按设备复制）。
    same(
      '寄件狗寄出的条数（不是每台设备一条）',
      q('SELECT count(*) AS n FROM exchange WHERE from_dog = ?', ctx.senderDogId).n,
      1,
    )
  } finally {
    db.close()
  }
  return problems
}
