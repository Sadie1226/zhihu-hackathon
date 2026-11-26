/**
 * d7 来回 —— 真实生产构建 + 真实 HTTP 的完整链路证据
 *
 * 为什么不能只用 `node --test`：那组用例跑在进程内，`handleExchangeSend` 是被直接调用的。
 * 它能证明「逻辑对」，但不能证明「一个真的浏览器/真的两台手机连上去能走通」——
 * cookie、origin、content-type、路由分派、生产构建这几层，只有真起服务才会暴露。
 *
 * 这条链要一次走完（d7 验收原话：「一个人能走完的完整来回」）：
 *
 *   1. 两台设备各自登录（两个 owner，两套 cookie）→ 各领养一只狗
 *   2. 甲的主人写一句话，托自己的狗带给乙的狗   POST /api/exchanges
 *   3. 乙的狗出门                                POST /api/dogs/:id/trips + POST /api/trips/:id/start
 *   4. 乙在收件箱里看到这句话、点开                GET inbox?filter=arrived + PATCH /api/exchanges/:id/read
 *   5. 乙回一句（真实 HTTP）                       POST /api/replies
 *   6. 甲在自己的发件箱里看到回音，不再「在等」     GET /api/exchanges?from_dog=
 *
 * 第 5 步走 `POST /api/replies`（实现在 `app/(b)/api/replies/route.ts`，B 的路由组）。
 * 抓路由时别只扫 `app/api/` —— 路由组 `(b)` 不改 URL，但会藏住文件。
 *
 * 除主链外还挡三个反例，都在同一个真服务上：
 *   · 同一请求重放 → `duplicate: true`，同一个 reply id，库里仍 1 行，`replied_at` 不动
 *   · 还没送达就回 → 409（「这条交换还没送达」）
 *   · 替别人的交换回 → 404（来源不属于当前会话）
 *
 * 跑法（dev server 按需编译，不必先 build）：
 *   node scripts/d7/roundtrip-http.mjs --db <新库路径> --out <证据路径> [--code-sha <sha>]
 *   `--reply-transport=service` 可退回服务层直写，仅用于对照排查。
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout } from 'node:timers/promises'
import { writeReply } from '../../lib/replies/idempotency.ts'

const WORDS = '楼下的桂花开了，你那边闻得到吗'
const ANSWER = '闻得到，风是从西边来的'

// ===========================================================================
// 参数
// ===========================================================================

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const dbPath = resolve(arg('db') ?? './tmp-d7/a5-development-d7.sqlite')
const outPath = resolve(arg('out') ?? './tmp-d7/d7-roundtrip.json')
const codeSha = arg('code-sha', 'unknown')
const replyTransport = arg('reply-transport', 'http')
if (!['http', 'service'].includes(replyTransport)) {
  throw new Error(`--reply-transport 只接受 http 或 service，收到 ${replyTransport}`)
}

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

async function startServer() {
  mkdirSync(dirname(dbPath), { recursive: true })
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  // `--webpack`：本工作树的 node_modules 是指向主仓的 junction，turbopack 会把它判成坏软链。
  const child = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)],
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
      if ((await fetch(base, { signal: AbortSignal.timeout(2000) })).ok) return { base, stop }
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
  return { json, setCookie: response.headers.get('set-cookie') }
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
      assembly: { cloth: 'hoodie', hat: 'beanie', glasses: null, face: 'hopeful' },
      fingerprint: generated.fingerprint,
      requestId: randomUUID(),
    },
  })
  return { cookie, dog: created.dog }
}

// ===========================================================================
// 主流程
// ===========================================================================

const started = Date.now()
const server = await startServer()
const evidence = { kind: 'd7-roundtrip', code: { sha: codeSha }, meta: { base: server.base, dbPath, words: WORDS } }

try {
  // ---- 1. 两台设备，两只真狗 ----
  const alpha = await adopt(server.base, 'ownerA', '阿桂')
  const beta = await adopt(server.base, 'ownerB', '小满')
  evidence.dogs = {
    sender: { id: alpha.dog.id, owner: 'ownerA', name: alpha.dog.name },
    receiver: { id: beta.dog.id, owner: 'ownerB', name: beta.dog.name },
  }
  if (alpha.cookie === beta.cookie) throw new Error('两个 owner 拿到了同一个会话，来回就退化成自问自答')

  // ---- 2. 甲的主人写一句话 ----
  const { json: sent } = await call(server.base, 'send', '甲托狗捎话（寄出即「在路上」）', {
    method: 'POST',
    path: '/api/exchanges',
    cookie: alpha.cookie,
    headers: { 'idempotency-key': `d7-${alpha.dog.id}-${randomUUID()}` },
    body: {
      fromDog: alpha.dog.id,
      toDog: beta.dog.id,
      kind: 'co_owner_message',
      payload: { kind: 'co_owner_message', message: WORDS },
    },
  })
  const exchange = sent.exchange
  if (exchange.deliveredAt !== null) throw new Error('寄出就是「已到」—— 即时到达被破')
  if (exchange.payload.message !== WORDS) throw new Error('原话在寄出这一步就被改了')
  if (exchange.payload.fromOwnerOf !== alpha.dog.id) throw new Error('fromOwnerOf 不等于寄件狗')

  // 在路上：乙的收件箱 arrived 为空、onTheWay 有它。
  const { json: beforeArrive } = await call(server.base, 'receiver.onTheWay', '乙尚在路上的收件箱', {
    path: `/api/dogs/${encodeURIComponent(beta.dog.id)}/inbox?filter=onTheWay`, cookie: beta.cookie,
  })
  const arrivedNow = await call(server.base, 'receiver.arrived.before', '乙已到收件箱（应为空）', {
    path: `/api/dogs/${encodeURIComponent(beta.dog.id)}/inbox?filter=arrived`, cookie: beta.cookie,
  })

  // ---- 3. 乙的狗出门，东西在这一刻到 ----
  const { json: tripCreated } = await call(server.base, 'trip.create', '乙的狗安排一次出行', {
    method: 'POST', path: `/api/dogs/${encodeURIComponent(beta.dog.id)}/trips`, cookie: beta.cookie,
    body: { trigger: 'auto' },
  })
  const { json: tripStarted } = await call(server.base, 'trip.start', '乙的狗出发（投递器在此刻写 delivered_at）', {
    method: 'POST', path: `/api/trips/${encodeURIComponent(tripCreated.trip.id)}/start`, cookie: beta.cookie, body: {},
  })
  if (!tripStarted.delivered.some((row) => row.id === exchange.id)) throw new Error('出发了但这句话没到')

  // ---- 4. 乙看到、点开 ----
  const { json: arrived } = await call(server.base, 'receiver.arrived', '乙的收件箱里看到这句话', {
    path: `/api/dogs/${encodeURIComponent(beta.dog.id)}/inbox?filter=arrived`, cookie: beta.cookie,
  })
  const received = arrived.exchanges.find((row) => row.id === exchange.id)
  if (!received) throw new Error('到了却不在乙的收件箱里')
  if (received.payload.message !== WORDS) throw new Error('到达后原话被改')
  const { json: readBack } = await call(server.base, 'receiver.read', '乙点开这封来信', {
    method: 'PATCH', path: `/api/exchanges/${encodeURIComponent(exchange.id)}/read`, cookie: beta.cookie, body: {},
  })
  if (!readBack.exchange.readAt) throw new Error('点开之后 readAt 仍为空')

  // 甲此刻在等回音。
  const { json: waitingBox } = await call(server.base, 'sender.waiting', '甲的发件箱：已到、在等回音', {
    path: `/api/exchanges?from_dog=${encodeURIComponent(alpha.dog.id)}`, cookie: alpha.cookie,
  })
  const waitingRow = waitingBox.exchanges.find((row) => row.id === exchange.id)

  // ---- 5. 乙回一句 ----
  let replyId, repliedAtAfter, replayOk = false
  if (replyTransport === 'http') {
    const { json: replied } = await call(server.base, 'receiver.reply', '乙回一句（POST /api/replies，真实 HTTP）', {
      method: 'POST', path: '/api/replies', cookie: beta.cookie,
      body: { exchangeId: exchange.id, text: ANSWER },
    })
    if (!replied.reply?.id) throw new Error('回应返回 200 但没有 reply')
    if (replied.duplicate) throw new Error('首次回应就被判成 duplicate')
    replyId = replied.reply.id

    // 同一条原样再打一次：必须还是这一条，不许多一行、不许改时间。
    const { json: replay } = await call(server.base, 'receiver.reply.replay', '同一请求重放（幂等）', {
      method: 'POST', path: '/api/replies', cookie: beta.cookie,
      body: { exchangeId: exchange.id, text: ANSWER },
    })
    replayOk = replay.reply?.id === replyId && replay.duplicate === true
    record('receiver.reply.idempotent', '重放仍是同一 reply，标 duplicate', { replyId, duplicate: replay.duplicate })
  } else {
    const db = new DatabaseSync(dbPath)
    try {
      const created = writeReply(db, { source: { kind: 'exchange', id: exchange.id }, text: ANSWER, photoUrl: null })
      if (created.kind !== 'created') throw new Error(`回应没写进去：${created.kind}`)
      replyId = created.reply.id
    } finally {
      db.close()
    }
    record('receiver.reply', '乙回一句（服务层直写，仅对照用）', { transport: 'service:writeReply', replyId })
  }
  {
    const readBack = new DatabaseSync(dbPath, { readOnly: true })
    try {
      repliedAtAfter = readBack.prepare('SELECT replied_at FROM exchange WHERE id = ?').get(exchange.id).replied_at
    } finally {
      readBack.close()
    }
  }
  if (!repliedAtAfter) throw new Error('replied_at 没被写上')

  // ---- 6. 甲看到回音 ----
  const { json: finalBox } = await call(server.base, 'sender.inbox.after', '甲的发件箱：回过之后不再等', {
    path: `/api/exchanges?from_dog=${encodeURIComponent(alpha.dog.id)}`, cookie: alpha.cookie,
  })
  const finalRow = finalBox.exchanges.find((row) => row.id === exchange.id)
  if (finalRow.repliedAt !== repliedAtAfter) throw new Error('甲看到的 repliedAt 与库里不一致')

  // ---- 反例：这两条必须被挡住，否则「能回」等于「谁都能回、随时能回」 ----
  const { json: pending } = await call(server.base, 'send.pending', '甲再寄一句（乙这次不出门）', {
    method: 'POST', path: '/api/exchanges', cookie: alpha.cookie,
    headers: { 'idempotency-key': `d7-pending-${randomUUID()}` },
    body: {
      fromDog: alpha.dog.id,
      toDog: beta.dog.id,
      kind: 'co_owner_message',
      payload: { kind: 'co_owner_message', message: '第二句，还没到' },
    },
  })
  await call(server.base, 'reply.beforeArrival', '还没到就回：应被拒（409）', {
    method: 'POST', path: '/api/replies', cookie: beta.cookie,
    body: { exchangeId: pending.exchange.id, text: '还没看到就回' },
    expect: 409,
  })
  await call(server.base, 'reply.notMine', '替别人的交换回：应被拒（404）', {
    method: 'POST', path: '/api/replies', cookie: alpha.cookie,
    body: { exchangeId: exchange.id, text: '我不是收件人' },
    expect: 404,
  })

  // ---- 收尾：库侧对账 ----
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
      replyRows: q('SELECT count(*) AS n FROM reply WHERE exchange_id = ?', exchange.id).n,
      replyRow: q('SELECT id, text, kind FROM reply WHERE exchange_id = ?', exchange.id),
      // 被 409 挡下的那条不能留下任何残行 —— 「拒了但偷偷写了」比不拒更糟。
      pendingReplyRows: q('SELECT count(*) AS n FROM reply WHERE exchange_id = ?', pending.exchange.id).n,
      trips: after.prepare('SELECT id, seq, status, started_at AS startedAt FROM trip WHERE dog_id = ? ORDER BY seq')
        .all(beta.dog.id),
    }
  } finally {
    after.close()
  }

  // 「等回音」这条判定只有一份实现，这里不重写：直接用它算给证据。
  const { isWaitingForReply } = await import('../../lib/mailbox/service.ts')
  const checks = [
    ['寄出即在路上', exchange.deliveredAt === null],
    ['在路上时乙的已到箱为空', arrivedNow.json.exchanges.length === 0],
    ['在路上时乙的在途箱有它', beforeArrive.exchanges.some((row) => row.id === exchange.id)],
    ['出发那一刻到达', received.deliveredAt === tripStarted.trip.startedAt],
    ['原话到达未改', received.payload.message === WORDS],
    ['fromOwnerOf = 寄件狗', received.payload.fromOwnerOf === alpha.dog.id],
    ['乙点开后 readAt 有值', Boolean(readBack.exchange.readAt)],
    ['到达后甲在等回音', waitingRow ? isWaitingForReply(waitingRow) : false],
    ['回应落了库（1 行）', facts.replyRows === 1],
    ['回应的文字是乙写的那句', facts.replyRow?.text === ANSWER],
    ...(replyTransport === 'http'
      ? [['重放仍是同一 reply 且未新增行', replayOk && facts.replyRows === 1]]
      : []),
    ['没到就回没留下残行', facts.pendingReplyRows === 0],
    ['回应后甲不再等', finalRow ? !isWaitingForReply(finalRow) : false],
    ['回应不改到达时间', facts.exchange.deliveredAt === received.deliveredAt],
    ['库里 replied_at 与回执一致', facts.exchange.repliedAt === repliedAtAfter],
    ['整库无外键问题', facts.foreignKeys === 0],
    ['integrity ok', facts.integrity === 'ok'],
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  evidence.chains = checks.map(([name, ok]) => ({ name, ok }))
  evidence.path = { words: WORDS, answer: ANSWER }
  evidence.steps = trail
  evidence.facts = facts
  evidence.replyTransport = replyTransport === 'http'
    ? {
        used: 'http:POST /api/replies',
        route: 'app/(b)/api/replies/route.ts',
        body: 'application/json { exchangeId, text }',
        firstReplyId: replyId,
        replayDuplicate: replayOk,
      }
    : { used: 'service:writeReply', route: null, firstReplyId: replyId }
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
const dbInfo = snapshotAndHash(dbPath)
evidence.db = dbInfo
writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`)
process.stdout.write(
  `\n${evidence.verdict === 'pass' ? '全绿' : '有失败'} — ${evidence.chains?.filter((c) => c.ok).length}/${evidence.chains?.length} 项，` +
  `证据 ${outPath}\n现场库 ${dbPath}（主文件 ${dbInfo.liveBytes} 字节 + wal ${dbInfo.liveWalBytes} 字节）\n` +
  `快照 ${dbInfo.snapshotPath}（${dbInfo.bytes} 字节）\nsha256 ${dbInfo.sha256}\n`,
)
if (evidence.verdict !== 'pass') process.exitCode = 1

function snapshotAndHash(path) {
  const snapshotPath = path.replace(/\.sqlite$/i, '.evidence.sqlite')
  try {
    unlinkSync(snapshotPath)
  } catch { /* 第一次跑就没有，正常 */ }
  // SQL 字符串里的路径用正斜杠，避免 Windows 反斜杠被当成转义。
  const target = snapshotPath.replace(/\\/g, '/').replace(/'/g, "''")
  const db = new DatabaseSync(path)
  try {
    /**
     * `next dev` 会起子进程，父进程被 kill 后那一小段时间里文件仍被映射着，
     * `VACUUM INTO` 会报 `SQLITE_IOERR`（10）。这不是数据坏了，是锁还没放干净 ——
     * 重试几次就过。**不重试的话，取证脚本会在最不该失败的地方随机红。**
     */
    let lastError
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        db.exec(`VACUUM INTO '${target}'`)
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
      }
    }
    if (lastError) throw lastError
    // 快照必须自洽：不然「哈希漂亮」但内容坏了。
    const check = db.prepare('PRAGMA integrity_check').get().integrity_check
    if (check !== 'ok') throw new Error(`快照 integrity_check 不是 ok：${check}`)
  } finally {
    db.close()
  }
  const bytes = readFileSync(snapshotPath)
  let liveWalBytes = 0
  try {
    liveWalBytes = readFileSync(`${path}-wal`).length
  } catch { /* 没有 wal 文件 */ }
  return {
    path,
    liveBytes: readFileSync(path).length,
    liveWalBytes,
    snapshotPath,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
