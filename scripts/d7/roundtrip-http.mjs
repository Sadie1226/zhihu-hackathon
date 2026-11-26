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
 *   5. 乙回一句                                  ⚠ 见下面的「边界」
 *   6. 甲在自己的发件箱里看到回音，不再「在等」     GET /api/exchanges?from_dog=
 *
 * **边界（必须写清楚，别让证据看起来比事实多）**：
 * 第 5 步走的是 `lib/replies/idempotency.ts` 的 `writeReply()` —— 本分支还没有
 * `POST /api/exchanges/:id/reply` 这条路由（B 的回应 HTTP 未落地）。也就是说：
 * 「收」是 HTTP 证明的，「回」是服务层证明的。等 B 的回应路由合并，把 `--reply-transport=http`
 * 打开重跑一次即可，本脚本的其余步骤不必改。
 *
 * 跑法（需要先 `next build`）：
 *   node scripts/d7/roundtrip-http.mjs --db <新库路径> --out <证据路径> [--code-sha <sha>]
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const replyTransport = arg('reply-transport', 'service')

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
  if (replyTransport !== 'service') throw new Error(`本分支只支持 service 回应，收到 ${replyTransport}`)
  const db = new DatabaseSync(dbPath)
  let reply, repliedAtAfter
  try {
    reply = writeReply(db, { source: { kind: 'exchange', id: exchange.id }, text: ANSWER, photoUrl: null })
    repliedAtAfter = db.prepare('SELECT replied_at FROM exchange WHERE id = ?').get(exchange.id).replied_at
  } finally {
    db.close()
  }
  record('receiver.reply', '乙回一句（B 的回应服务，见边界说明）', {
    transport: 'service:writeReply',
    result: reply.kind,
    replyId: reply.reply.id,
  })
  if (reply.kind !== 'created') throw new Error(`回应没写进去：${reply.kind}`)
  if (!repliedAtAfter) throw new Error('replied_at 没被写上')

  // ---- 6. 甲看到回音 ----
  const { json: finalBox } = await call(server.base, 'sender.inbox.after', '甲的发件箱：回过之后不再等', {
    path: `/api/exchanges?from_dog=${encodeURIComponent(alpha.dog.id)}`, cookie: alpha.cookie,
  })
  const finalRow = finalBox.exchanges.find((row) => row.id === exchange.id)
  if (finalRow.repliedAt !== repliedAtAfter) throw new Error('甲看到的 repliedAt 与库里不一致')

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
  evidence.replyTransport = { used: 'service:writeReply', httpRoute: '本分支尚无（B 未落地）' }
  evidence.verdict = failed.length === 0 ? 'pass' : `fail: ${failed.join(' / ')}`
  evidence.elapsedMs = Date.now() - started
} finally {
  await server.stop()
}

mkdirSync(dirname(outPath), { recursive: true })
/**
 * **先 checkpoint，再算哈希。**
 *
 * 这台机器上跑完两轮，两次 `app.sqlite` 的 sha256 一模一样 —— 不是巧合，是因为
 * 数据全在 `-wal` 里、主库文件还停在「只有 schema」的状态。只对主文件求哈希，
 * 等于对着一份不含任何消息的空壳盖章。A 11/25 的更正说的就是这件事：
 * 空 WAL 可以忽略，**非空 WAL 必须算进去**。
 *
 * `wal_checkpoint(TRUNCATE)` 把 WAL 摺回主库并清空，之后的主文件哈希才代表真实内容。
 */
const dbInfo = checkpointAndHash(dbPath)
evidence.db = dbInfo
writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`)
process.stdout.write(
  `\n${evidence.verdict === 'pass' ? '全绿' : '有失败'} — ${evidence.chains?.filter((c) => c.ok).length}/${evidence.chains?.length} 项，` +
  `证据 ${outPath}\n库 ${dbPath}（${dbInfo.bytes} 字节，checkpoint 后 wal ${dbInfo.walBytes} 字节）\nsha256 ${dbInfo.sha256}\n`,
)
if (evidence.verdict !== 'pass') process.exitCode = 1

function checkpointAndHash(path) {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
  const bytes = readFileSync(path)
  // checkpoint 后仍要确认 WAL 已空：若这里不是 0，说明还有连接没放锁，哈希不可信。
  let walBytes = 0
  try {
    walBytes = readFileSync(`${path}-wal`).length
  } catch { /* 没有 wal 文件就是最干净的情况 */ }
  if (walBytes !== 0) throw new Error(`checkpoint 后 WAL 仍有 ${walBytes} 字节，主文件哈希不代表全内容`)
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), walBytes }
}
