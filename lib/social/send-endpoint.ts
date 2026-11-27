/**
 * send-endpoint.ts —— `POST /api/exchanges` 的 HTTP 薄壳（d6，11-24）
 *
 * 为什么这层此前是空的：`gift.ts`（11-21）已经把「寄什么、第几趟到、幂等、来源、
 * 种子狗禁言」全写完了，缺的只是把它接到 HTTP 上。契约 `contracts/api.md` §7 早就
 * 写了这个端点（`POST /api/exchanges 入：{ fromDog, toDog, kind, payload }`），
 * 但 c 落地的只有 GET/PATCH 三个读接口。d6 的验收是「礼物在路上、下一次出行到达、
 * 到了在等回应」—— 没有这个入口，前三步一步都演示不了。
 *
 * **这一层只做三件事，业务判断一律不在这里：**
 *   1. 请求形状：鉴权、来源校验、JSON、四个字段、幂等键
 *   2. 归属：fromDog 必须属于当前 session（否则任何人都能冒名寄）
 *   3. 错误映射：把 `GiftError` 翻译成契约里的 `{ code, detail, retriable }`
 *
 * 长度、白名单、越权字段、来源形状、自寄、拉黑、种子狗禁言 —— 全在
 * `rules.ts` / `gift.ts` 里，这里**一行都不重复**。重复实现的下一站就是两边慢慢漂开。
 *
 * 归属说明：路径 `app/api/exchanges/route.ts` 是 c 的信箱文件，这里只往它上面挂了
 * 一个 `POST` 转调（三行）。若 c 要自己实现，删掉那个 POST 即可，本文件不受影响。
 */

import type { DatabaseSync } from 'node:sqlite'
import type { Exchange } from '../../contracts/types.ts'
import { assertOwnedDog, OwnershipError, resolveAuthContext } from '../auth/session.ts'
import { validMailboxId } from '../mailbox/service.ts'
import { GiftError, sendCoOwnerMessage, sendGift } from './gift.ts'
import type { CoOwnerMessageInput, GiftInput } from './gift.ts'
import { createSqliteStore } from './sqlite-store.ts'

const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }

type ErrorCode = 'CONFLICT' | 'NOT_FOUND'

class SendError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'SendError'
    this.code = code
  }
}

const conflict = (detail: string): never => {
  throw new SendError('CONFLICT', detail)
}

function fail(code: ErrorCode, detail: string): Response {
  return Response.json(
    { code, detail, retriable: false },
    { status: code === 'NOT_FOUND' ? 404 : 409, headers },
  )
}

const columns = `e.id, e.from_dog AS fromDog, e.to_dog AS toDog, e.kind, e.payload,
  e.deliver_after_trip_seq AS deliverAfterTripSeq, e.created_at AS createdAt,
  e.delivered_at AS deliveredAt, e.replied_at AS repliedAt, e.read_at AS readAt`

/**
 * 写完立刻按**库里的那一行**回显，不是回显本次入参。
 *
 * 与 `gift.ts` 命中幂等时的处理是同一条理由：重放请求若回显 draft，
 * 调用方会拿到一条「这次编的、库里并没有的」内容。这里连 `deliveredAt` 也必须是库里的 null，
 * 否则界面会在寄出的瞬间显示「已到达」。
 */
function readExchange(db: DatabaseSync, id: string): Exchange {
  const row = db.prepare(`SELECT ${columns} FROM exchange e WHERE e.id = ?`).get(id)
  if (!row) throw new Error('exchange written but not readable')
  return { ...row, payload: JSON.parse(String(row.payload)) } as unknown as Exchange
}

/**
 * 寄出一件东西：`gift` 或 `co_owner_message`。
 *
 * **为什么不收 `find` / `greeting`**：这两种是两条狗碰上时**当场**产生的，必须有
 * trip 上下文（哪一趟、遇到谁）。放它们进来等于开一个「不用出门也能造一次相遇」的
 * 后门，直接破「一切都不是即时」这条不变量。它们由 `meet.ts` 在相遇里写。
 */
export async function handleExchangeSend(
  request: Request,
  getDatabase: () => DatabaseSync,
): Promise<Response> {
  try {
    const db = getDatabase()
    const auth = resolveAuthContext(request, db)
    // 没有有效 session 时与「记录不存在」同一个回答：不给未登录的人探出狗 id 是否有效。
    if (!auth) throw new SendError('NOT_FOUND', '这条记录不在这里')

    const url = new URL(request.url)
    if (url.search) conflict('寄出请求不接受查询参数')

    const host = request.headers.get('host')
    const expectedOrigin = host ? `${url.protocol}//${host}` : url.origin
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.has('origin') && request.headers.get('origin') !== expectedOrigin)
    ) {
      conflict('请求来源不匹配')
    }
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      conflict('请求需要 JSON 内容')
    }

    /**
     * 幂等键**必须由客户端给**，服务端不替它生成。
     *
     * 替它生成（随机 id）的后果是：用户在地铁里点了一次、超时后又点一次，
     * 库里就多出一份一模一样的礼物 —— 而「重复投递」正是 d6 的阻断缺陷。
     * 反过来用「内容哈希」当键也不行：同一份礼物真的想送第二次时，会被判成重试而静默丢掉。
     * 所以只能显式要一个「这次提交」的标识，重试复用同一个值。
     */
    const idempotencyKey = request.headers.get('idempotency-key')
    if (
      idempotencyKey === null ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > 128 ||
      !/^[\x21-\x7e]+$/.test(idempotencyKey)
    ) {
      conflict('需要 Idempotency-Key 请求头（1–128 个可见 ASCII 字符）；重试请复用同一个值')
    }

    const value: unknown = await request.json().catch(() => conflict('JSON 内容格式不正确'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) conflict('请求需要 JSON 对象')
    const body = value as Record<string, unknown>

    const fields = ['fromDog', 'toDog', 'kind', 'payload'] as const
    if (
      Object.keys(body).length !== fields.length ||
      Object.keys(body).some((key) => !(fields as readonly string[]).includes(key))
    ) {
      conflict('请求体只接受 fromDog / toDog / kind / payload 四个字段')
    }

    // 用三元 + never 落空：`if (x) conflict()` 之后 TS 不一定会窄化，三元表达式这里更稳，
    // 且「不合法就抛」这句话只写一次，不会出现「校验了但忘了提前返回」。
    const fromDog = typeof body.fromDog === 'string' ? body.fromDog : conflict('fromDog 应为一个非空狗 ID')
    if (!validMailboxId(fromDog)) conflict('fromDog 应为一个非空狗 ID')
    const toDog = typeof body.toDog === 'string' ? body.toDog : conflict('toDog 应为一个非空狗 ID')
    if (!validMailboxId(toDog)) conflict('toDog 应为一个非空狗 ID')
    const kind = body.kind
    if (kind !== 'gift' && kind !== 'co_owner_message') {
      conflict('这个入口只寄 gift 与 co_owner_message；find / greeting 必须由相遇写入口产生')
    }
    const payload = body.payload
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) conflict('payload 需要 JSON 对象')
    const payloadFields = payload as Record<string, unknown>

    /**
     * payload 里不许出现能改写写入参数的同名键。
     *
     * 下面把 payload 展开进入参，再覆盖 `store / fromDog / toDog / idempotencyKey`。
     * 若 payload 自己也带 `fromDog`，展开后会被静默覆盖 —— 调用方以为寄给了谁、
     * 实际寄给了另一个人，且没有任何报错。静默覆盖比明确拒绝难查得多。
     */
    const reserved = new Set(['store', 'fromDog', 'toDog', 'id', 'idempotencyKey', 'now'])
    for (const key of Object.keys(payloadFields)) {
      if (reserved.has(key)) conflict(`payload 不接受 ${key}`)
    }

    /**
     * `payload.kind` 必须与顶层 `kind` 一致。
     *
     * 两处都写 kind 是契约的既有形状（顶层给路由分派，payload 里那份跟着 JSON 走）。
     * 不一致就不往下走：`rules.ts` 也会拒，但报的是「payload 形状不对」，
     * 而真正的原因在顶层 —— 让人一眼看明白比较好。
     */
    const payloadKind = payloadFields.kind
    if (payloadKind !== kind) conflict('payload.kind 必须与顶层的 kind 一致')

    const store = createSqliteStore(db)
    // `kind` 由 `sendGift` / `sendCoOwnerMessage` 自己写进 payload，不作为入参再传一遍
    // （传了会被 gift.ts 的入参白名单拒 —— 它只接受内容字段）。
    const rest = Object.fromEntries(Object.entries(payloadFields).filter(([key]) => key !== 'kind'))
    const input = { ...rest, store, fromDog, toDog, idempotencyKey }

    /**
     * 归属校验与写入同一个事务。
     *
     * 两件事分开做的窗口里，狗可能被删除或换主：校验通过、写入失败（外键），
     * 或者更糟 —— 校验的是旧的 owner、写的是新的狗。c 11/19 对 C8 的要求就是
     * 「一次事务里验证寄件狗权限、再调 sendGift」，这里是同一句。
     *
     * 注意 `sendGift` 自己也开事务，`createSqliteStore` 用 SAVEPOINT 支持嵌套。
     */
    const result = store.transaction(() => {
      // Reading the request body yields; validate the same live session before writing.
      const currentAuth = resolveAuthContext(request, db)
      if (!currentAuth || currentAuth.tokenHash !== auth.tokenHash ||
        currentAuth.ownerId !== auth.ownerId || currentAuth.namespace !== auth.namespace) {
        throw new SendError('NOT_FOUND', '这条记录不在这里')
      }
      assertOwnedDog(db, fromDog, currentAuth)
      return kind === 'gift'
        ? sendGift(input as unknown as GiftInput)
        : sendCoOwnerMessage(input as unknown as CoOwnerMessageInput)
    })

    return Response.json({ exchange: readExchange(db, result.id) }, { headers })
  } catch (error) {
    if (error instanceof SendError) return fail(error.code, error.message)
    // 别人的狗一律按「不存在」处理：不给「存在但无权」这种可探测的差别。
    if (error instanceof OwnershipError) return fail('NOT_FOUND', '这条记录不在这里')
    if (error instanceof GiftError) {
      /**
       * `STORE_REJECTED` 的 message 是底层 sqlite 的报错串（表名、约束名、路径）。
       * 它在服务端日志里有价值，给客户端没有 —— 换成一句人话。
       * 其余业务错误（超长、种子狗说话、拉黑）原样返回，因为这些要让人看懂才知道怎么改。
       */
      return fail(
        'CONFLICT',
        error.code === 'STORE_REJECTED' ? '这件东西暂时寄不出去，可以再试一次' : error.message,
      )
    }
    return Response.json(
      { code: 'NETWORK', detail: '这次没连上，可以再试一次', retriable: true },
      { status: 503, headers },
    )
  }
}
