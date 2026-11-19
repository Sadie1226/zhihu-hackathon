/**
 * meet.ts —— 结识与交换的落库层（d4）
 *
 * 分工：`rules.ts` 只判断「这条草稿合法吗」，纯函数、不碰库；
 *       本文件负责「合法之后怎么写进去」——顺序、幂等、事务、算出送达趟次。
 *
 * 三个核心函数：
 *   nextDeliverSeq  收件狗当前 seq + 1（契约写死，c8 到了也还是这个式子）
 *   recordExchange  校验 → 算趟次 → 幂等插入
 *   upsertRelation  按字典序归对 → 首次写 first_met_at → 之后只 bump met_count
 *
 * 两条必须守住的：
 *   1. **`dog_a < dog_b`**。不排序，schema 的 CHECK 当场报错。
 *   2. **`first_met_at` 只写一次**。第二次相遇只动 `last_met_at` 和 `met_count`。
 *
 * 11-19 晚按 a 的复核（`team/2026-11-19/a/1119-a-给D-请求-相遇幂等与旅途校验-v1.md`）
 * 改了三处，都是「可复现、不靠猜」的：
 *   3. **相遇必须带 exchange**。纯记关系没有幂等锚点，重试就虚增报价 → `NO_EXCHANGE_IN_MEET`。
 *   4. **tripId 必须验证**。存在 / 属于发起狗 / 状态 `running`，三条都在事务之前拒。
 *   5. **重放返回库里的事实**。`recordExchange` 命中幂等时回查那一行，不再返回本次 draft。
 *
 * 跑测试：node --experimental-strip-types lib/social/meet.test.ts
 */

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { validate } from './rules.ts'
import type { ExchangeDraft, ExchangeKind, NormalizedExchange, RuleCode } from './rules.ts'

// ===========================================================================
// 一、错误
// ===========================================================================

/**
 * meet 这一层自己会拒的几种情况。
 * 校验失败时直接透传 `rules.ts` 的 `RuleCode`，不在这里另造一套。
 */
export type MeetErrorCode =
  | 'SELF_MEET'               // 自己遇自己
  | 'BLOCKED_RELATION'        // 这一对被拉黑（双向）
  | 'DOG_NOT_FOUND'           // id 不存在
  | 'KIND_NOT_IN_MEET'        // 相遇只能带 greeting / find
  | 'MISSING_IDEMPOTENCY_KEY' // 没给 id 也没给幂等键，无法保证不重复写
  // ↓ 11-19 晚补：a 复核 d4-meet 提出的两条可复现问题
  | 'NO_EXCHANGE_IN_MEET'     // 既没有 outgoing 也没有 incoming —— 纯记关系不可幂等，直接拒
  | 'TRIP_NOT_FOUND'          // tripId 在 trip 表里不存在
  | 'TRIP_NOT_OWNED'          // 这趟出行不是发起狗的
  | 'TRIP_NOT_OPEN'           // 出行状态不允许相遇（只有 running 可以）

export class SocialWriteError extends Error {
  readonly code: MeetErrorCode | RuleCode
  readonly path: string

  constructor(code: MeetErrorCode | RuleCode, reason: string, path = '') {
    super(reason)
    this.name = 'SocialWriteError'
    this.code = code
    this.path = path
  }
}

// ===========================================================================
// 二、小工具
// ===========================================================================

/**
 * 能发生相遇的出行状态。只有 `running`。
 *
 * `pending` 是还没出门，`done` / `failed` / `timeout` 是已经结束。
 * 相遇一定发生在路上，所以这条是单值而不是集合 —— 哪天要放开，
 * 改这一处，`meet()` 的报错文案会跟着变。
 */
export const MEETABLE_TRIP_STATUS = 'running'

/** 契约要求 `2026-11-16T12:00:00Z` 这种秒级 UTC，`toISOString()` 多三位毫秒，去掉。 */
export function nowIso(now?: string | Date): string {
  if (typeof now === 'string') return now
  const d = now ?? new Date()
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function shortHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)
}

/**
 * 字典序归对。
 *
 * 用 `<` 而不是 `localeCompare`：SQLite 的 TEXT 默认 BINARY 排序按 UTF-8 字节比，
 * JS 的 `<` 按 UTF-16 码元比 —— 对纯 ASCII 的狗 id 完全一致。
 * **狗 id 一律是 ASCII**（`dog_seed_07` / `dog_owner`），这条前提写在这儿，
 * 哪天有人给狗用中文 id，这个函数和 schema 的 CHECK 会同时失效。
 */
export function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

// ===========================================================================
// 三、deliver_after_trip_seq
// ===========================================================================

/**
 * 收件狗当前 seq + 1。
 *
 * 「当前 seq」= 这只狗已有的最大 seq（`trip` 里 `UNIQUE(dog_id, seq)`，从 1 只增不减）。
 * 没有任何出行记录时为 0，所以结果是 1 —— 它的第一次出行就能收到。
 *
 * **不许写成 `now > 某个时间戳`。** 契约写死：这是个整数趟次，不是时间。
 */
export function nextDeliverSeq(db: DatabaseSync, dogId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM trip WHERE dog_id = ?')
    .get(dogId) as { s: number } | undefined
  return Number(row?.s ?? 0) + 1
}

// ===========================================================================
// 四、recordExchange
// ===========================================================================

export interface RecordOptions {
  /** 显式 id。给了就以它为准。 */
  id?: string
  /**
   * 幂等键。没有 id 时用它派生确定性 id：同一组 (from, to, kind, key) 永远同一个 id，
   * 写第二次撞主键 → `inserted: false`，库里仍是一条。
   *
   * 相遇场景的 key 是 `tripId:out` / `tripId:in`；礼物场景是礼物本身的一次性标识。
   */
  idempotencyKey?: string
  /** 不传则取当前时间（秒级 UTC）。 */
  createdAt?: string
  /** 不传则按收件狗当前 seq + 1 算。c8 到位后会由 c 传值，式子不变。 */
  deliverAfterTripSeq?: number
}

export interface RecordResult {
  id: string
  /** false = 命中幂等，库里原本就有这条。 */
  inserted: boolean
  deliverAfterTripSeq: number
  /**
   * 这条 exchange 的**持久化事实**。
   *
   * `inserted: false` 时这里是**从库里读回来的那一行**，不是本次调用传进来的 draft。
   * 之前的实现直接返回 draft，导致同一个幂等键重放时，调用方拿到的是自己刚编的内容
   * （库里存的是第一次的）—— 如果拿它当「已送达的那句话」渲染，用户会看到一条不存在的消息。
   * a 在 11-19 复核里点到了这一点。
   */
  exchange: NormalizedExchange
}

/**
 * 幂等 id 的派生规则。**`recordExchange` 和 `meet` 的「这条写过没」判断必须用同一个函数**，
 * 否则一个用哈希一个用别的写法，就会出现「以为没写过、其实写过」。
 */
export function deriveExchangeId(
  fromDog: string,
  toDog: string,
  kind: ExchangeKind,
  idempotencyKey: string,
): string {
  return `ex_${shortHash(fromDog, toDog, kind, idempotencyKey)}`
}

/**
 * 写一条 exchange。合法性由 `rules.ts` 全权判断，本函数不重复实现白名单。
 */
export function recordExchange(
  db: DatabaseSync,
  draft: ExchangeDraft,
  opts: RecordOptions = {},
): RecordResult {
  const verdict = validate(draft)
  if (!verdict.ok) {
    throw new SocialWriteError(verdict.code, verdict.reason, verdict.path)
  }
  const value = verdict.value

  if (!opts.id && !opts.idempotencyKey) {
    throw new SocialWriteError(
      'MISSING_IDEMPOTENCY_KEY',
      '没给 id 也没给 idempotencyKey，无法保证重复调用不插两条',
      'id',
    )
  }

  const id =
    opts.id ??
    deriveExchangeId(value.fromDog, value.toDog, value.kind, opts.idempotencyKey!)
  const createdAt = nowIso(opts.createdAt)
  const deliverAfterTripSeq = opts.deliverAfterTripSeq ?? nextDeliverSeq(db, value.toDog)

  // ON CONFLICT DO NOTHING：第二次写同一条 = 静默跳过，不报错、不产生第二条。
  const res = db
    .prepare(
      `INSERT INTO exchange
         (id, from_dog, to_dog, kind, payload,
          deliver_after_trip_seq, created_at, delivered_at, replied_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      id,
      value.fromDog,
      value.toDog,
      value.kind,
      JSON.stringify(value.payload),
      deliverAfterTripSeq,
      createdAt,
    )

  if (Number(res.changes) === 1) {
    return { id, inserted: true, deliverAfterTripSeq, exchange: value }
  }

  // 命中幂等：库里已经有一条同 id 的记录。**返回它，不返回本次的 draft。**
  // 走到这里一定读得到（DO NOTHING 只在主键冲突时发生），读不到才是真异常。
  const existing = db
    .prepare(
      `SELECT from_dog, to_dog, kind, payload, deliver_after_trip_seq
         FROM exchange WHERE id = ?`,
    )
    .get(id) as
    | {
        from_dog: string
        to_dog: string
        kind: ExchangeKind
        payload: string
        deliver_after_trip_seq: number
      }
    | undefined

  if (!existing) {
    // 理论上不可达：DO NOTHING 只在主键冲突时返回 changes=0，冲突就意味着有行。
    // 真走到这里说明存储层状态不对，宁可炸掉也不返回一个编出来的 payload。
    throw new Error(`幂等命中但读不回记录 ${id} —— 存储层状态异常`)
  }

  return {
    id,
    inserted: false,
    deliverAfterTripSeq: Number(existing.deliver_after_trip_seq),
    exchange: {
      fromDog: existing.from_dog,
      toDog: existing.to_dog,
      kind: existing.kind,
      payload: JSON.parse(existing.payload) as Record<string, unknown>,
    },
  }
}

// ===========================================================================
// 五、upsertRelation
// ===========================================================================

export interface RelationResult {
  id: string
  dogA: string
  dogB: string
  metCount: number
  firstMetAt: string
  lastMetAt: string
  /** true = 第一次相遇；false = 老关系，只 bump 了次数。 */
  created: boolean
}

/**
 * 记一次相遇。
 *
 * 三件事一次做完，且只有这三件事：
 *   1. 首次插入才写 `first_met_at`
 *   2. `last_met_at` 每次都更新
 *   3. `met_count` 每次 +1
 *
 * `is_blocked` / `blocked_at` 一个字都不碰 —— 那是「选择不见」，不该被一次相遇解除。
 */
export function upsertRelation(
  db: DatabaseSync,
  dogIdA: string,
  dogIdB: string,
  at: string,
  opts: { id?: string } = {},
): RelationResult {
  if (dogIdA === dogIdB) {
    throw new SocialWriteError('SELF_MEET', '一只狗不能和自己建立关系', 'dogB')
  }

  const [dogA, dogB] = orderPair(dogIdA, dogIdB)
  const id = opts.id ?? `rel_${shortHash(dogA, dogB)}`
  const when = nowIso(at)

  const row = db
    .prepare(
      `INSERT INTO relation (id, dog_a, dog_b, first_met_at, last_met_at, met_count, is_blocked, blocked_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, NULL)
       ON CONFLICT(dog_a, dog_b) DO UPDATE
         SET met_count   = relation.met_count + 1,
             last_met_at = excluded.last_met_at
       RETURNING id, dog_a, dog_b, first_met_at, last_met_at, met_count`,
    )
    .get(id, dogA, dogB, when, when) as {
    id: string
    dog_a: string
    dog_b: string
    first_met_at: string
    last_met_at: string
    met_count: number
  }

  return {
    id: row.id,
    dogA: row.dog_a,
    dogB: row.dog_b,
    metCount: Number(row.met_count),
    firstMetAt: row.first_met_at,
    lastMetAt: row.last_met_at,
    created: Number(row.met_count) === 1,
  }
}

/** 读一对关系（顺序无关）。没有则返回 null。 */
export function readRelation(db: DatabaseSync, dogIdA: string, dogIdB: string): RelationResult | null {
  const [dogA, dogB] = orderPair(dogIdA, dogIdB)
  const row = db
    .prepare(
      `SELECT id, dog_a, dog_b, first_met_at, last_met_at, met_count
         FROM relation WHERE dog_a = ? AND dog_b = ?`,
    )
    .get(dogA, dogB) as
    | {
        id: string
        dog_a: string
        dog_b: string
        first_met_at: string
        last_met_at: string
        met_count: number
      }
    | undefined

  if (!row) return null
  return {
    id: row.id,
    dogA: row.dog_a,
    dogB: row.dog_b,
    metCount: Number(row.met_count),
    firstMetAt: row.first_met_at,
    lastMetAt: row.last_met_at,
    created: false,
  }
}

// ===========================================================================
// 六、能不能换 —— 留给 c 的空位
// ===========================================================================
export interface GateContext {
  db: DatabaseSync
  selfDogId: string
  otherDogId: string
}

export type GateVerdict = { ok: true } | { ok: false; code: string; reason: string }

/**
 * 交换前置校验的钩子。默认放行。
 *
 * 这里将来要塞的全是 **c 还没定的规则**，现在一条都不写死：
 *   - 兴趣为 null 的狗，快照能不能生成（`snapshot.interest_categories` 是 NOT NULL 且 2–3 项，
 *     而 `dog.interest_categories` 可以为 NULL —— 硬矛盾，等 c 定转换规则）
 *   - owner 归属（a 要求「匹配排除同 owner」，但 `dog` 表目前没有 owner 列，只有 session_id）
 *
 * 填规则时只加判断，**不动 `meet()` 的签名**。
 */
export type ExchangeGate = (ctx: GateContext) => GateVerdict

// ===========================================================================
// 七、meet —— 一次相遇，一个事务
// ===========================================================================

export interface MeetPayloadInput {
  kind: 'greeting' | 'find'
  /** 不含 kind 也行 —— rules.ts 的 normalize 会把外层 kind 补进去。 */
  payload: Record<string, unknown>
}

export interface MeetInput {
  db: DatabaseSync
  /** 我的狗（这次相遇的发起方） */
  dogId: string
  /** 对面那只 */
  otherDogId: string
  /** 我的这次出行。既做幂等键的来源，也解释「为什么现在遇到」。 */
  tripId: string
  /** 我的狗留给对方的东西。不给则只记关系。 */
  outgoing?: MeetPayloadInput
  /** 对方带给我的东西。不给则只记关系。 */
  incoming?: MeetPayloadInput
  /** 相遇时刻，默认现在。 */
  now?: string
  /** 交换前置校验钩子，见 `ExchangeGate`。 */
  gate?: ExchangeGate
}

export interface MeetResult {
  relation: RelationResult
  exchanges: RecordResult[]
  /**
   * true = 这次是重放（同一次出行已经写过），关系没有被二次 bump。
   *
   * 为什么要判重放：exchange 靠幂等 id 天然去重，但 `relation` 表**没有任何
   * 「哪次出行见的」字段**，磕不出幂等键。所以重放必须在 meet 这一层拦下来，
   * 否则网络重试一次，`met_count` 就凭空 +1，熟悉度越走越假。
   */
  replayed: boolean
}

/**
 * 两只狗碰到一起：记关系 + 写交换，**全部在一个事务里**。
 *
 * 为什么必须一个事务：关系写进去了、exchange 被 `rules.ts` 拒了，库里就留下一对
 * 「见过面但什么都没换」的关系 —— 下一轮匹配会把它当老关系，越走越偏。
 *
 * 相遇只允许 `greeting` / `find`。`gift` 和 `co_owner_message` 有投递语义，归 `gift.ts`。
 * 这条不是洁癖：种子狗不伪造主人回话，而 `co_owner_message` 正是捎话的入口。
 *
 * 顺序是：**先拒，后写**。自己遇自己、没带 exchange、tripId 不存在/不归属/状态不对、
 * 狗不存在、被拉黑、gate 不放行 —— 全部在 `BEGIN IMMEDIATE` 之前抛，库一个字节都没动。
 * 只有真需要原子性的「关系 + 交换」才进事务。
 */
export function meet(input: MeetInput): MeetResult {
  const { db, dogId, otherDogId, tripId } = input
  const when = nowIso(input.now)

  if (dogId === otherDogId) {
    throw new SocialWriteError('SELF_MEET', '一只狗不能和自己相遇', 'otherDogId')
  }
  if (input.outgoing && input.outgoing.kind !== 'greeting' && input.outgoing.kind !== 'find') {
    throw new SocialWriteError(
      'KIND_NOT_IN_MEET',
      `相遇只能带 greeting / find，收到 ${String(input.outgoing.kind)}`,
      'outgoing.kind',
    )
  }
  if (input.incoming && input.incoming.kind !== 'greeting' && input.incoming.kind !== 'find') {
    throw new SocialWriteError(
      'KIND_NOT_IN_MEET',
      `相遇只能带 greeting / find，收到 ${String(input.incoming.kind)}`,
      'incoming.kind',
    )
  }

  // 顺序说明：先确认「东西存不存在」，再判断「这次调用说了什么」。
  // 狗 id 写错时，报 DOG_NOT_FOUND 比报 NO_EXCHANGE_IN_MEET 有用得多 ——
  // 调用方拿着后一条会去翻 payload，其实问题是 id 拼错了。
  const known = db
    .prepare('SELECT id FROM dog WHERE id IN (?, ?)')
    .all(dogId, otherDogId) as Array<{ id: string }>
  const knownIds = new Set(known.map((r) => r.id))
  const missing = [dogId, otherDogId].filter((id) => !knownIds.has(id))
  if (missing.length > 0) {
    throw new SocialWriteError('DOG_NOT_FOUND', `狗不存在：${missing.join(', ')}`, 'dogId')
  }

  // ---- 这趟出行必须真实存在、属于发起狗、而且正在走 ----
  //
  // 之前只把 tripId 当字符串拼进幂等键，随便传 `does_not_exist` 也能写进关系，
  // 还能凭空把 tripId 属于别的狗的情况当成有效相遇。三种都拒，且都在事务之前拒 ——
  // 拒绝时不留下任何关系或交换。
  const trip = db
    .prepare('SELECT id, dog_id, status FROM trip WHERE id = ?')
    .get(tripId) as { id: string; dog_id: string; status: string } | undefined
  if (!trip) {
    throw new SocialWriteError('TRIP_NOT_FOUND', `出行不存在：${tripId}`, 'tripId')
  }
  if (trip.dog_id !== dogId) {
    throw new SocialWriteError(
      'TRIP_NOT_OWNED',
      `出行 ${tripId} 属于 ${trip.dog_id}，不是 ${dogId}`,
      'tripId',
    )
  }
  // 只认 running：pending 还没出门、done/failed/timeout 已经结束。
  // 相遇只发生在路上，收件狗那趟出行是另一条记录，与这里无关。
  if (trip.status !== MEETABLE_TRIP_STATUS) {
    throw new SocialWriteError(
      'TRIP_NOT_OPEN',
      `出行 ${tripId} 状态为 ${trip.status}，只有 ${MEETABLE_TRIP_STATUS} 能相遇`,
      'tripId',
    )
  }

  // ---- 要么带东西，要么别调用 ----
  //
  // 重放判定靠「派生一个 exchange id，看库里有没有」，probeId 就是那个锚点。
  // 两个方向都不给 = 没有锚点 = 同一 tripId 调第二次会把 met_count 再 +1。
  // `relation` 表没有「哪次出行见的」字段，磕不出幂等键 —— 所以这条路径**根本不该存在**。
  //
  // 11-19 晚：a 复核发现纯关系路径重试就把报价虚增一次。选择「明确拒绝」而不是
  // 「补一条存储约束」—— 后者要改 c 的 schema，走契约流程，今天走不完。
  if (!input.outgoing && !input.incoming) {
    throw new SocialWriteError(
      'NO_EXCHANGE_IN_MEET',
      '相遇至少带一条 outgoing 或 incoming；只记关系的调用无法幂等，不支持',
      'outgoing',
    )
  }

  // 拉黑双向排除：关系表一对只存一条（dog_a < dog_b），查一次等于查两个方向。
  const [lo, hi] = orderPair(dogId, otherDogId)
  const blocked = db
    .prepare('SELECT is_blocked FROM relation WHERE dog_a = ? AND dog_b = ?')
    .get(lo, hi) as { is_blocked: number } | undefined
  if (blocked && Number(blocked.is_blocked) === 1) {
    throw new SocialWriteError('BLOCKED_RELATION', '这一对已被拉黑，不再相遇', 'relation')
  }

  if (input.gate) {
    const g = input.gate({ db, selfDogId: dogId, otherDogId })
    if (!g.ok) throw new SocialWriteError(g.code as MeetErrorCode, g.reason, 'gate')
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    // ---- 重放判定：同一次出行已经写过交换，就只读不写 ----
    const probeId = input.outgoing
      ? deriveExchangeId(dogId, otherDogId, input.outgoing.kind, `${tripId}:out`)
      : input.incoming
        ? deriveExchangeId(otherDogId, dogId, input.incoming.kind, `${tripId}:in`)
        : null

    if (probeId) {
      const seen = db.prepare('SELECT id FROM exchange WHERE id = ?').get(probeId)
      if (seen) {
        const existing = readRelation(db, dogId, otherDogId)
        // 交换在、关系读不回来 —— 同一个事务写的，正常不可能。
        // 以前这里会编一个 metCount:0 的关系返回，等于把假事实交给调用方；宁可炸。
        if (!existing) {
          throw new Error(`重放探测命中 ${probeId}，但读不回关系 ${dogId} × ${otherDogId}`)
        }
        db.exec('COMMIT')
        // 重放：`exchanges` 留空，不返回本次调用传的 payload。
        // 需要内容就按 deriveExchangeId 自己查，库里的才是事实（见 recordExchange 的注释）。
        return { relation: existing, exchanges: [], replayed: true }
      }
    }

    const relation = upsertRelation(db, dogId, otherDogId, when)
    const exchanges: RecordResult[] = []

    if (input.outgoing) {
      exchanges.push(
        recordExchange(
          db,
          { fromDog: dogId, toDog: otherDogId, kind: input.outgoing.kind, payload: input.outgoing.payload },
          { idempotencyKey: `${tripId}:out`, createdAt: when },
        ),
      )
    }
    if (input.incoming) {
      exchanges.push(
        recordExchange(
          db,
          { fromDog: otherDogId, toDog: dogId, kind: input.incoming.kind, payload: input.incoming.payload },
          { idempotencyKey: `${tripId}:in`, createdAt: when },
        ),
      )
    }

    db.exec('COMMIT')
    return { relation, exchanges, replayed: false }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// ===========================================================================
// 八、TODO —— 等 c 答复的两处，别在别处临时绕
// ===========================================================================

/**
 * TODO(等契约合并) `find.payload.sourceFindId` + `sourceMode`
 *
 * 11-19 晚 c 已正式批准：`sourceFindId` 进 `find`、`gift` 两种 payload，同时同步
 * `sourceMode`（非知乎发现允许 null）；`fromDog` 是发送狗、`sourceFindId` 是关联的旅途发现，
 * 两者不能混淆。
 *
 * 但 c 同时说「**D 今天先按现有字段写业务，不要自行修改 K**」——契约增补由 c 改
 * `types.ts` / `api.md` / `fixtures`，合并之后 d 才动 `rules.ts` 的白名单。
 *
 * 所以本文件现在仍然：**不硬编码、也不偷偷塞键**。带 `sourceFindId` 的 payload 会被
 * `rules.ts` 的 `UNKNOWN_KEY` 拒 —— 这是对的。c 的增补合并后，只需把
 * `rules.ts` 的 `PENDING_KEYS.find` 挪到 `PAYLOAD_KEYS.find`，这里一个字都不用改。
 */

/**
 * TODO(等 c) owner 归属
 *
 * a 的 `1119-a5-给D-请求` 第 1 条要求「匹配排除同 owner，不能只看 session」。
 * 但 `dog` 表现在只有 `session_id`，没有 owner 列，c3 的稳定归属也没定稿。
 * 11-19 晚 c 的答复是「继续等公共身份口径，不猜字段」。
 * 定了之后加进 `ExchangeGate` 的判断里。
 */
