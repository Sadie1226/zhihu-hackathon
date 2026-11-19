/**
 * gift.ts —— 礼物与捎话的落库层（d4）
 *
 * 和 `meet.ts` 的分工是**按 kind 切的**，不是按「谁写 exchange」切的：
 *   - `meet.ts`：`greeting` / `find`，两条狗碰上时顺手带过去
 *   - 本文件：`gift` / `co_owner_message`，**有投递语义**——今天寄、下次到
 *
 * 为什么必须分开：礼物与捎话会跨越「一趟」，它们的时间语义是
 * `deliver_after_trip_seq = 收件狗当前 seq + 1`，跟相遇那种「当场交换」不是一回事。
 * 混在一个函数里，早晚有人把礼物也写成当场到达。
 *
 * 三个约束（c 11/19 答复第 1 条）：
 *   1. **业务逻辑不依赖存储实现。** 只认 `store.ts` 的 `SocialStore`，
 *      不 import `node:sqlite`。11/21 换 C8 正式接口时，这里一行不改。
 *   2. **不自己决定投递时间**，也不写 `delivered_at` / `replied_at` / `read_at`。
 *   3. 趟次算式与 `meet.ts` 同一个 —— 见 `deliverAfterTripSeqFor()`，全文件只此一处。
 *
 * 跑测试：node --experimental-strip-types lib/social/gift.test.ts
 */

import { deriveExchangeId, nowIso } from './meet.ts'
import { validate } from './rules.ts'
import type { ExchangeKind, NormalizedExchange, RuleCode } from './rules.ts'
import type { SocialStore } from './store.ts'

// ===========================================================================
// 一、错误
// ===========================================================================
//
// 形状与 `meet.ts` 的 `SocialWriteError` 一致（code / path / message），
// 但不共用那个类：今天不动 meet.ts（它已全绿）。11-20 适配器化那天合并成一个。

export type GiftErrorCode =
  | 'KIND_NOT_IN_GIFT'        // 本文件只收 gift / co_owner_message
  | 'BLOCKED_RELATION'        // 这一对被拉黑（双向）
  | 'MISSING_IDEMPOTENCY_KEY' // 没给 id 也没给幂等键
  | 'OWNER_MISMATCH'          // fromOwnerOf 不等于 fromDog
  | 'SEED_OWNER_SPEAKS'       // 让种子狗替主人说话
  | 'STORE_REJECTED'          // 存储层拒了（最常见：狗不存在，FK 报错）
  | 'STORE_INCONSISTENT'      // store 说已存在、却读不回来 —— 自相矛盾，不猜

export class GiftError extends Error {
  readonly code: GiftErrorCode | RuleCode
  readonly path: string

  constructor(code: GiftErrorCode | RuleCode, reason: string, path = '') {
    super(reason)
    this.name = 'GiftError'
    this.code = code
    this.path = path
  }
}

// ===========================================================================
// 二、趟次 —— 全文件只有这一处算式
// ===========================================================================

/**
 * 收件狗当前 seq + 1。
 *
 * **这就是 `meet.ts` 里 `nextDeliverSeq` 的同一个式子**，只是数据来源从
 * `DatabaseSync` 换成了 `SocialStore.currentSeq()`。`gift.ts` 里不许出现第二个版本 ——
 * 一旦两处各算一遍，`gift` 和 `meet` 写出来的 `deliver_after_trip_seq` 就会慢慢漂开。
 *
 * 它是**整数趟次，不是时间戳**。写成 `now + 一小时` 之类，演示时礼物永远显示「在路上」。
 *
 * 「+1」在业务层算，不在 store 里算 —— 这是 c 故意留的边界：
 * Mock 若能自增 seq，它就能让礼物提前到。
 */
export function deliverAfterTripSeqFor(store: SocialStore, toDog: string): number {
  return store.currentSeq(toDog) + 1
}

// ===========================================================================
// 三、待批字段的开关
// ===========================================================================

/**
 * `sourceFindId` / `sourceMode` c 已**批准**，但契约（types.ts / api.md / fixtures）
 * 还没合并。c 原话：「D 今天先按现有字段写业务，不要自行修改 K」。
 *
 * 所以今天的状态是：**参数收，但不写进 payload**。传了的字段会出现在返回值的
 * `heldBack` 里，测试据此断言「收到了、只是没落库」。
 *
 * 打开需要两步，缺一步都会被 `rules.ts` 拒（`UNKNOWN_KEY`），这是刻意的：
 *   1. c 合并契约
 *   2. `rules.ts` 的 `PENDING_KEYS.find` / `.gift` 加上这两个键
 *   3. 再把下面这行改成 true
 */
const INCLUDE_PENDING_KEYS = false

const PENDING_FIELDS = ['sourceFindId', 'sourceMode'] as const

// ===========================================================================
// 四、入参
// ===========================================================================

/** 两种 kind 共用的部分。 */
export interface SendBase {
  store: SocialStore
  /** 寄件狗。捎话时它是「运输工具」，主人原话在 payload 里。 */
  fromDog: string
  /** 收件狗。种子狗也可以收 —— 只有「替主人说话」不行。 */
  toDog: string
  /** 显式 id。给了就以它为准。 */
  id?: string
  /**
   * 幂等键。没有 id 时必须给，且**同一个键写两次库里仍是一条**。
   * 礼物的 key 用「这次礼物本身」的标识（不是时间），否则重试会造出两条。
   */
  idempotencyKey?: string
  /** 不传则取当前时间（秒级 UTC）。时间只用来记 created_at，不参与到达判断。 */
  now?: string
}

export interface GiftInput extends SendBase {
  /** 1–20 字，长度由 `rules.ts` 卡，这里不重复实现。 */
  giftName: string
  /** 0–40 字。不传按 `null` 落 —— 「可空」是值可为 null，键必须存在。 */
  note?: string | null
  /** 礼物图标路径（a 的 P0 第 8 条）。不传按 `null`。 */
  imagePath?: string | null
  /** c 已批、契约未合并 —— 今天收下但不写，见 `INCLUDE_PENDING_KEYS`。 */
  sourceFindId?: string | null
  sourceMode?: 'live' | 'cache' | 'fixture' | null
}

export interface CoOwnerMessageInput extends SendBase {
  /** 主人原话，1–60 字。**只进 payload**，不进 snapshot、不进任何狗读得到的地方。 */
  message: string
  /**
   * 这句话属于哪只狗的主人。**必须等于 `fromDog`**。
   *
   * 它是冗余字段（接了就恒等于 fromDog），但保留：不填时由本函数补齐，
   * 填了不一致就拒 —— 这一条防的是「顺手把主人昵称写进来」。
   */
  fromOwnerOf?: string
  sourceFindId?: string | null
  sourceMode?: 'live' | 'cache' | 'fixture' | null
}

export interface SendResult {
  id: string
  /** false = 命中幂等，库里原本就有这条（第二次调用不应该造第二条）。 */
  inserted: boolean
  /** 收件狗第几次出行到达。整数，不是时间。 */
  deliverAfterTripSeq: number
  exchange: NormalizedExchange
  /** 收下但没写进 payload 的待批字段名。空数组表示这次没传。 */
  heldBack: string[]
}

// ===========================================================================
// 五、gift
// ===========================================================================

export function sendGift(input: GiftInput): SendResult {
  return send('gift', input, {
    kind: 'gift',
    // note / imagePath 都可为 null，但键必须在 —— 键集合严格相等是白名单的判定方式。
    giftName: input.giftName,
    note: input.note ?? null,
    imagePath: input.imagePath ?? null,
  })
}

// ===========================================================================
// 六、co_owner_message
// ===========================================================================

/**
 * 捎话：主人托自己的狗，把一句话带给另一只狗。
 *
 * 两条不能破的：
 *   1. **`message` 只进 payload。** 这是不变量五的唯一实现方式 ——
 *      它不进 snapshot、不参与任何 prompt 拼接、不落进任何「狗能读到」的地方。
 *      `rules.ts` 的白名单已经保证 payload 里只可能有那三个键；
 *      本函数只负责不往别处写。
 *   2. **种子狗不替主人说话。** 种子狗是「示例伙伴」，它背后没有主人。
 *      让 `fromDog` 是种子狗去发 co_owner_message，等于凭空造一个主人回话 ——
 *      这正是五种阻断缺陷里的「伪造真实用户内容」。
 */
export function sendCoOwnerMessage(input: CoOwnerMessageInput): SendResult {
  if (input.fromOwnerOf !== undefined && input.fromOwnerOf !== input.fromDog) {
    throw new GiftError(
      'OWNER_MISMATCH',
      `fromOwnerOf(${input.fromOwnerOf}) 必须等于 fromDog(${input.fromDog}) —— 这里填的是狗 id，不是人名`,
      'fromOwnerOf',
    )
  }
  if (input.store.isSample(input.fromDog)) {
    throw new GiftError(
      'SEED_OWNER_SPEAKS',
      `${input.fromDog} 是种子狗，背后没有主人，不能以它的名义捎话`,
      'fromDog',
    )
  }

  return send('co_owner_message', input, {
    kind: 'co_owner_message',
    message: input.message,
    // 恒等于 fromDog。冗余但保留：读的人一眼知道「这是谁的主人」，不用再回查。
    fromOwnerOf: input.fromDog,
  })
}

// ===========================================================================
// 七、共用写入路径
// ===========================================================================

type SendKind = 'gift' | 'co_owner_message'

/** 入参允许出现哪些键。多一个就拒 —— 理由见 `send()` 里的注释。 */
const BASE_KEYS: readonly string[] = ['store', 'fromDog', 'toDog', 'id', 'idempotencyKey', 'now']

const KIND_KEYS: Record<SendKind, readonly string[]> = {
  gift: ['giftName', 'note', 'imagePath'],
  co_owner_message: ['message', 'fromOwnerOf'],
}

function send(kind: SendKind, base: SendBase, payload: Record<string, unknown>): SendResult {
  const { store, fromDog, toDog } = base

  if (kind !== 'gift' && kind !== 'co_owner_message') {
    // 类型上不可能走到，留着是为了「有人拿 any 调进来」时不静默写错 kind。
    throw new GiftError('KIND_NOT_IN_GIFT', `本文件只处理 gift / co_owner_message，收到 ${String(kind)}`, 'kind')
  }

  /**
   * 入参键白名单。**这条不是洁癖，是实测出来的。**
   *
   * 本函数是从具名参数拼 payload 的，所以「多传一个 chatText」本来会被静默丢掉 ——
   * 看着安全，实际是静默失败：调用方以为自己带上了某个字段，落库时它不见了，
   * 而且没有任何报错。静默丢数据比明确报错更难查。
   *
   * 所以：不认识就拒，与 payload 白名单是同一套态度。
   */
  const allowed = new Set([...BASE_KEYS, ...KIND_KEYS[kind], ...PENDING_FIELDS])
  for (const key of Object.keys(base)) {
    if (!allowed.has(key)) {
      throw new GiftError('UNKNOWN_KEY', `入参不接受 ${key}（${kind} 只允许 ${[...allowed].join(' / ')}）`, key)
    }
  }

  // 拉黑双向排除：relation 一对只存一条（dog_a < dog_b），store 内部已按无序对查。
  if (store.isBlocked(fromDog, toDog)) {
    throw new GiftError('BLOCKED_RELATION', '这一对已被拉黑，不再互寄', 'toDog')
  }

  // 合法性全权交给 rules.ts：自寄、长度、白名单、越权字段都在那儿，本文件不重复实现。
  const verdict = validate({ fromDog, toDog, kind, payload })
  if (!verdict.ok) {
    throw new GiftError(verdict.code, verdict.reason, verdict.path)
  }
  const value = verdict.value

  if (!base.id && !base.idempotencyKey) {
    throw new GiftError(
      'MISSING_IDEMPOTENCY_KEY',
      '没给 id 也没给 idempotencyKey，无法保证重复调用不插两条',
      'id',
    )
  }

  const id = base.id ?? deriveExchangeId(value.fromDog, value.toDog, value.kind, base.idempotencyKey!)
  const createdAt = nowIso(base.now)
  // 发送这一刻算「收件狗当前 seq + 1」。算完就不再看时间。
  const deliverAfterTripSeq = deliverAfterTripSeqFor(store, value.toDog)

  // 待批字段：收下、记录、不落库（见 INCLUDE_PENDING_KEYS）。
  const heldBack = PENDING_FIELDS.filter((k) => {
    const v = (base as Record<string, unknown>)[k]
    return v !== undefined
  })
  if (INCLUDE_PENDING_KEYS && heldBack.length > 0) {
    for (const k of heldBack) {
      value.payload[k] = (base as Record<string, unknown>)[k]
    }
  }

  let inserted: boolean
  try {
    inserted =
      store.insertExchange({
        id,
        fromDog: value.fromDog,
        toDog: value.toDog,
        kind: value.kind as ExchangeKind,
        payload: value.payload,
        deliverAfterTripSeq,
        createdAt,
      }) === 'inserted'
  } catch (err) {
    // 真库最常见的是外键失败（狗不存在）。包一层，调用方不必认识 sqlite 的错误串。
    throw new GiftError('STORE_REJECTED', (err as Error).message, 'store')
  }

  /**
   * 命中幂等时，**返回库里那一行，不是这次的入参**。
   *
   * a 11-19 复核 `meet.ts` 时点的就是这个：同一个幂等键重放，如果回显本次 draft，
   * 调用方拿到的是一句「这次刚编的、库里并没有的」话；界面照它渲染，
   * 用户会看到一条不存在的消息 —— 而且只在重试时出现，最难复现。
   *
   * 所以 `gift` 这边同一件事必须同样处理：`deliverAfterTripSeq` 也取库里的值，
   * 因为「哪一趟到」是第一次调用那一刻定下的，重放不许改写。
   */
  if (!inserted) {
    const stored = store.readExchange(id)
    if (!stored) {
      // 说重复却读不到 —— 存储层自相矛盾。宁可报错，也不回显 draft 造出一条假消息。
      throw new GiftError('STORE_INCONSISTENT', `store 报告 ${id} 已存在，但读不回来`, 'id')
    }
    return {
      id,
      inserted: false,
      deliverAfterTripSeq: stored.deliverAfterTripSeq,
      exchange: {
        fromDog: stored.fromDog,
        toDog: stored.toDog,
        kind: stored.kind,
        payload: stored.payload,
      },
      // 这一次什么都没写，待批字段自然也没落库。
      heldBack: [],
    }
  }

  return { id, inserted, deliverAfterTripSeq, exchange: value, heldBack }
}
