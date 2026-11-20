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
import { resolveProvenance } from './provenance.ts'
import { validate } from './rules.ts'
import type { ExchangeKind, NormalizedExchange, RuleCode } from './rules.ts'
import type { SocialStore, SourceMode } from './store.ts'

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
// 三、来源字段（K v4 已入 main，11-20 激活）
// ===========================================================================

/**
 * 11-19 这里是个 `INCLUDE_PENDING_KEYS = false` 的开关：参数收下、不写进 payload。
 * K v4 已合入 main，**开关删掉了** —— 留着它等于留一个「能不能绕开来源校验」的旋钮。
 *
 * 现在来源不是「附带字段」，而是**必须走一次库查询**才能组装出来的东西：
 *
 *   1. `sourceFindId` 非 null → `store.getFindSource()` 查归属与 `source_mode`
 *   2. 查不到 / 归属不是寄件狗 → 拒
 *   3. `sourceMode` **取库里的值**，不信入参
 *   4. 拼进 payload 之后，再交给 `rules.ts` 做完整校验
 *
 * 顺序不能换。c 的原话：「不能仅将开关改 true，否则新增字段绕过原 validate」。
 */
const PROVENANCE_KEYS = ['sourceFindId', 'sourceMode'] as const

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
  /**
   * 来源发现（K v4）。**必须是寄件狗自己 trip 里的 find.id**，由 store 查证；
   * 不传或传 null 表示「这件礼物没有对应发现」，payload 里两键都写 null。
   */
  sourceFindId?: string | null
  /**
   * 调用方**声称**的来源档位。可以不给（推荐），给了就只用来做一致性核对：
   * 与库里的 `find.source_mode` 不符就拒。**落库的永远是库里的值**，不是这个。
   */
  sourceMode?: SourceMode | null
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
  // 这里**故意没有** sourceFindId / sourceMode。
  // K v4：「greeting/捎话不能借此夹带来源、私人内容或额外身份信息」。
  // 传进来会在入参白名单那步被拒（不是静默忽略）。
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

/**
 * 来源核查本体在 `provenance.ts` —— 因为 `meet.ts` 的 find 分支也要用同一份。
 * 这里只做一件事：把结果转成人能读的 `GiftError`。
 */
function provenanceOrThrow(
  store: SocialStore,
  fromDog: string,
  sourceFindId: string | null | undefined,
  claimedMode: SourceMode | null | undefined,
): { sourceFindId: string | null; sourceMode: SourceMode | null } {
  const r = resolveProvenance(store, fromDog, sourceFindId, claimedMode)
  if (!r.ok) throw new GiftError(r.code, r.reason, r.path)
  return { sourceFindId: r.sourceFindId, sourceMode: r.sourceMode }
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
   *
   * K v4 之后多一句：**来源两键只对 gift 放行。** 捎话传进来会在这里被拒，
   * 而不是被悄悄丢掉再落一条干净的 co_owner_message —— 后者看着没事，
   * 实际是「调用方以为自己给捎话挂上了出处」。
   */
  const provenanceKeys = kind === 'gift' ? PROVENANCE_KEYS : []
  const allowed = new Set([...BASE_KEYS, ...KIND_KEYS[kind], ...provenanceKeys])
  for (const key of Object.keys(base)) {
    if (!allowed.has(key)) {
      throw new GiftError(
        'UNKNOWN_KEY',
        kind === 'co_owner_message' && (PROVENANCE_KEYS as readonly string[]).includes(key)
          ? `捎话不接受 ${key} —— 来源字段只属于 find / gift（K v4）`
          : `入参不接受 ${key}（${kind} 只允许 ${[...allowed].join(' / ')}）`,
        key,
      )
    }
  }

  // 拉黑双向排除：relation 一对只存一条（dog_a < dog_b），store 内部已按无序对查。
  if (store.isBlocked(fromDog, toDog)) {
    throw new GiftError('BLOCKED_RELATION', '这一对已被拉黑，不再互寄', 'toDog')
  }

  // ---- 来源：先查库，后拼 payload，最后才校验 ----
  //
  // 次序是 c 指定的，理由很硬：如果先 validate 再追加来源字段，那两个键就绕过了
  // 白名单和形状校验（11-19 的 heldBack 就是这么干的：收下、校验、再补进去）。
  // 现在改成**先拿到真实来源 → 拼成完整 payload → 整体过一次 validate**。
  if (kind === 'gift') {
    // `base` 是具名参数的联合类型，来源两键只存在于 GiftInput 上；
    // 走 gift 分支时它一定是 GiftInput，取一次 Record 视图比逐个判 undefined 清楚。
    const raw = base as unknown as Record<string, unknown>
    const provenance = provenanceOrThrow(
      store,
      fromDog,
      raw.sourceFindId as string | null | undefined,
      raw.sourceMode as SourceMode | null | undefined,
    )
    payload.sourceFindId = provenance.sourceFindId
    payload.sourceMode = provenance.sourceMode
  }

  // 合法性全权交给 rules.ts：自寄、长度、白名单、越权字段、来源形状都在那儿，
  // 本文件不重复实现。注意这里校验的 payload **已经含来源两键**。
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

  /**
   * `heldBack` 保留但恒为空数组。
   *
   * K v4 之前它记录「收下但没落库的待批字段」；现在来源已经真落库，没有东西可挂。
   * 但字段本身**不删** —— a/e 可能已经在读它判断「哪些字段没生效」，
   * 删掉会让他们的类型或渲染分支静默走空。恒 `[]` 表示「这次没有任何字段被扣下」。
   */
  const heldBack: string[] = []

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
