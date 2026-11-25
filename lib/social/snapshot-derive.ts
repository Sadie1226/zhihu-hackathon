/**
 * snapshot-derive.ts —— 从真实 trip / trip_event / exchange 派生 snapshot 内容（**只读**）
 *
 * 这份文件是 11-23 晚 A 复核后拆出来的：原来派生规则写在 `scripts/d5-derive-snapshot.mjs`
 * 里，那个脚本同时干三件事（读库、拼摘要、拼 SQL），结果**报告和可执行 SQL 混在一屏**，
 * 而且 `--sql` 写死 `version = 1` + `ON CONFLICT DO UPDATE` —— 重跑一次就把已经固定的旧版本改掉了。
 *
 * 现在的分工：
 *   · **本文件**：只读派生。只有 SELECT，没有任何写语句；不开事务（事务由调用方给）。
 *   · **C**：在出发的受控事务里调这里，分配新 version、插入、绑定本趟。版本只增不改。
 *   · **A**：只看 evidence，不需要读 SQL。
 *   命令行脚本只负责把结果打印/落盘，不再承担业务规则。
 *
 * 三条口径（A 11-23 晚确认，逐条都有用例）：
 *
 *   1. **`waiting_for` 是寄件方的视角。**
 *      甲寄给乙，乙已收到未回应 → **甲**在等；乙回应之后，甲**下一次**新快照才结束等待，
 *      本趟已固定的记录不变。所以查 `from_dog = 自己`，不是 `to_dog`。
 *      （11-23 首版写成 `to_dog`，方向反了：那会让收件狗声称「我在等回音」，而它没寄过东西。）
 *
 *   2. **经历和挂念是两件独立的事。**
 *      没有 trip 只说明 `recent_trips = []`，**不推出** `waiting_for = null`：
 *      一只还没出门过的狗，也可能刚寄出礼物在等回音。两项分别派生，不互相兜底。
 *
 *   3. **3 是趟次数，不是条数。**
 *      只看最近 3 趟 `done` / `timeout`；最近三趟都没事件就是 `[]`，不往前捞。
 *      `failed` 不算「回来过」（那是系统故障，主人看到的是重试），也不改变出发次数/间隔规则。
 *
 * 一条**做不到**的事，写在最前面免得被当成已解决：
 *   `event.text` 是可变列。本文件读到的永远是「此刻」的文本，不是「那趟出发时」的文本。
 *   所以 evidence 里带 `textSource` / `textMutable` / `historyFixed` 三个标注。
 *   旧版本的冻结靠 snapshot 主键 `(dog_id, version)` + 只插入不改写，
 *   不靠「重新派生一次得到同样的话」—— 那件事在文案被改过之后就不成立了。
 *
 * 11-24 A 复核指出：**已存版本不覆盖 ≠ 历史固定**。同一旧 trip 在文案改过之后，
 * 进「下一次新快照」时仍会跟着变。这不是标注能盖住的，要改成读「发生当时固定下来的
 * 那份文本」。那份事实由 C 维护（契约 / 迁移 / 写入都在 C 侧），D 只改读取。
 *
 * 所以这里留了一个**注入式接缝** `OccurrenceFactReader`：D 不猜 C 的表结构、不猜列名、
 * 不碰 `trip_event`。C 交契约之后，把读取实现成一个函数传进来即可，本文件其余部分不动。
 * 没传就退回读模板，并如实标 `historyFixed: false`（诊断态，不挂正式生成链）。
 *
 * **11-24 G2 接口基线 READY（`582376e`）之后，接缝已经接上了**：
 * C 的 `v_trip_event_history` + A 补齐的 `lib/trips/occurrence-facts.ts`（唯一 adapter）。
 * D 直接 import，不另写一份 SQL 副本 —— 两份 SQL 迟早在「取哪条最早」上分叉。
 * 同一轮把 `earliestEvent` 的 JOIN 拆掉：它原来读模板的 code/text、按字符串排时间，
 * 正是 A 说的「摘要固定但来源证据跟着模板变」。
 */

import type { DatabaseSync } from 'node:sqlite'
import type { InterestCategory, PersonalityTag } from '../../contracts/types.ts'
import { validateSnapshot } from './snapshot.ts'
import type { Snapshot } from './snapshot.ts'

// ===========================================================================
// 一、口径常量（改这里等于改规则，用例会跟着红）
// ===========================================================================

/** 算「回来过」的终点状态。`failed` 故意不在内。 */
export const COUNTED_TRIP_STATUS = ['done', 'timeout'] as const
export type CountedTripStatus = (typeof COUNTED_TRIP_STATUS)[number]

/** 会留下「我在等回音」的交换种类。`find` / `greeting` 不需要回应，不产生等待。 */
export const WAITING_KINDS = ['gift', 'co_owner_message'] as const
export type WaitingKind = (typeof WAITING_KINDS)[number]

/**
 * 「在等什么」的**受控模板**。
 *
 * 为什么是模板而不是拼内容：`giftName` / `message` 是主人起的名字和原话，
 * 属于「主人原话不进 snapshot」的地界。快照只说类别，不说等的是什么。
 */
export const WAITING_TEMPLATE: Record<WaitingKind, string> = {
  gift: '等一份礼物的回音',
  co_owner_message: '等一句回话',
}

/** 最近看几趟。与 `snapshot.recent_trips` 的条数上限一致（契约：最多 3 条）。 */
export const TRIPS_LOOKBACK = 3

// ===========================================================================
// 二、形状
// ===========================================================================

/** 派生结果里「进快照」的那四项。version / createdAt 不在这里 —— 那是写入时刻的事。 */
export interface SnapshotBody {
  personalityTags: [PersonalityTag, PersonalityTag, PersonalityTag]
  interestCategories: InterestCategory[] | null
  recentTrips: string[]
  waitingFor: string | null
}

export interface TripEvidence {
  tripId: string
  seq: number
  status: CountedTripStatus
  startedAt: string
  endedAt: string
  /** 这趟落了几条 trip_event；取的是最早那条 */
  eventCount: number
  /**
   * 这趟最早发生的那条事件。
   *
   * **这里一度是个错位**：id / happenedAt 取自 `trip_event`（发生当时），
   * code / text 却 JOIN 当前 `event` 表（此刻的模板）。于是摘要固定住了、来源证据还在跟着改文案变 ——
   * A 11-24 点出来的正是这一处。现在 code / text 只从两个地方来：
   *   · 正式态：`text` 取冻结事实；`code` 为 **null**（现有 adapter 只透传文本，不拿今天的 code 冒充当时的）
   *   · 诊断态（未接读取器）：两者都取当前模板，`textSource` 会标 `template_current`
   */
  event: { id: string; code: string | null; happenedAt: string; text: string | null } | null
  /** 真正进 recent_trips 的那一句；没有事件或历史不可验证就是 null */
  summary: string | null
  /**
   * 这句摘要从哪儿读来的。
   *   `occurrence`        —— 发生当时固定下来的那份（**唯一可以进正式快照的来源**）
   *   `template_current`  —— 事件模板的**此刻**文本，会随改文案而变（诊断态）
   *   `unverifiable`     —— 有事件但固定事实缺失，摘要留空
   *   `none`             —— 这趟没有事件
   */
  textSource: 'occurrence' | 'template_current' | 'unverifiable' | 'none'
  /** 固定事实的来源标识（事件版本 id / 记录 id，具体形状由 C 定）。模板态恒为 null。 */
  factSourceId: string | null
  /** 这趟有没有 Find。只给 id / kind / source_mode —— 标题与摘要不进证据。 */
  finds: { id: string; kind: string; sourceMode: string | null }[]
}

export interface WaitingEvidence {
  exchangeId: string
  kind: WaitingKind
  createdAt: string
  deliveredAt: string
  template: string
}

export interface SnapshotEvidence {
  dogId: string
  tripsConsidered: number
  /** 被排除的 failed 趟数。列出来是为了「看到它、并明确没算」。 */
  failedTripsIgnored: number
  trips: TripEvidence[]
  waiting: WaitingEvidence | null
  /** 除选中那条外，还有几条已到达未回应。不进快照，只让人知道「不止一条」。 */
  otherPendingWaiting: number
  /** 摘要文本取自哪一列、是不是可变。见文件头最后两段。 */
  textSource: 'occurrence' | 'event.text' | 'unverifiable'
  textMutable: boolean
  /**
   * 每个有事件的旅途是否都取得了发生时固定事实。
   *
   * 没有事件时也算固定。有事件但事实缺失，即使摘要留空也必须为false。
   * A 11-24 的口径：`textMutable: true` 只是诚实标注，`historyFixed: false` 才决定
   * 这份派生能不能算正式结果。
   */
  historyFixed: boolean
  findCoverage: { tripsWithFind: number; tripsWithoutFind: number }
}

export interface DeriveResult {
  body: SnapshotBody
  evidence: SnapshotEvidence
}

/**
 * 「发生当时固定下来的公开事实」。
 *
 * 这是 D 侧唯一需要 C 提供的东西，**不是**一张表的完整形状：
 * 给一趟旅途，告诉我当时那句话、以及它的来源标识。存哪儿、叫什么列、怎么迁，
 * 都由 C 的契约决定，D 不猜也不碰 `trip_event`。
 */
export interface OccurrenceFact {
  /** 当时进快照的公开文本（不是主人原话，是事件里那句公开叙述） */
  text: string
  /** 来源标识：事件版本 id / 记录 id / code+版本号，形状由 C 定，D 只透传进证据 */
  sourceId: string
  /** 固定时刻（写下这条事实的时间） */
  capturedAt: string
}

/**
 * 读取器：给 (db, tripId, dogId)，返回这趟事件发生时固定的那份事实；没有就返回 null。
 *
 * 为什么用「注入函数」而不是直接写 SQL：
 *   · C 的 schema 还没定。写死一个 JOIN 等于替 C 定表结构，契约一改就返工；
 *   · 更重要的是**没有实现时不能悄悄退回读模板** —— 退回了会被当成已固定。
 *     所以这里没有默认实现：不传就是「没有固定事实」，并如实标 `historyFixed: false`。
 *
 * `null` 的两种含义要分清，调用方按 `capturedAt`/`sourceId` 区分：
 *   · 这趟本来就没事件 → 根本不会调用本函数；
 *   · 有事件但当时没固定下文本（存量记录）→ 返回 null，快照里**不许**用今天的文本顶替。
 */
export type OccurrenceFactReader = (
  db: DatabaseSync,
  tripId: string,
  dogId: string,
) => OccurrenceFact | null

export interface DeriveOptions {
  /** C 交契约后传进来。不传 = 模板态（诊断，不挂正式生成链）。 */
  occurrenceFacts?: OccurrenceFactReader
}

// ===========================================================================
// 三、读（全部是 SELECT，一条写语句都没有）
// ===========================================================================

const parseTags = (raw: string): [PersonalityTag, PersonalityTag, PersonalityTag] => {
  const arr = JSON.parse(raw) as unknown
  if (!Array.isArray(arr) || arr.length !== 3) {
    // 不当场补一个凑数：这是种子数据坏了，不是派生能修的事。
    throw new Error(`dog.personality_tags 不是 3 项：${raw}`)
  }
  return arr as [PersonalityTag, PersonalityTag, PersonalityTag]
}

const recentTrips = (db: DatabaseSync, dogId: string) =>
  db
    .prepare(
      `SELECT id, seq, status, started_at, ended_at
         FROM trip
        WHERE dog_id = ? AND status IN (${COUNTED_TRIP_STATUS.map(() => '?').join(',')})
        ORDER BY seq DESC
        LIMIT ?`,
    )
    .all(dogId, ...COUNTED_TRIP_STATUS, TRIPS_LOOKBACK) as {
    id: string
    seq: number
    status: CountedTripStatus
    started_at: string
    ended_at: string
  }[]

const countFailed = (db: DatabaseSync, dogId: string): number => {
  const row = db.prepare(`SELECT count(*) AS n FROM trip WHERE dog_id = ? AND status = 'failed'`).get(dogId) as {
    n: number
  }
  return Number(row.n)
}

/**
 * 这一趟里最早发生的那条事件 —— **只读 `trip_event`，不 JOIN `event`**。
 *
 * 两处修正（A 11-24）：
 *   · 不再 JOIN 模板。JOIN 一次就等于把「此刻的 code / text」掺进证据，摘要固定了也没用。
 *   · 排序从 `te.happened_at ASC`（字符串）改成 `julianday(...)`，与 C 的 adapter 一致 ——
 *     `2026-11-24T03:00:00Z` 和 `2026-11-24 03:00:00` 混着存时，字符串序会把后者排到前面，
 *     于是 D 取「最早」和 C 取「最早」不是同一条。
 *
 * `timeout` 趟也可能有事件（走到一半超时，但已经看见了东西）——
 * **不能一概当「没摘要」**：有就照给，没有才是空。
 */
const earliestOccurrence = (db: DatabaseSync, tripId: string, dogId: string) =>
  (db
    .prepare(
      `SELECT event_id, happened_at
         FROM trip_event
        WHERE trip_id = ? AND dog_id = ?
        ORDER BY julianday(happened_at), event_id
        LIMIT 1`,
    )
    .get(tripId, dogId) ?? null) as { event_id: string; happened_at: string } | null

/**
 * 当前模板的 code / text。**只有诊断态才读它** —— 这两列会随改文案而变。
 * 读它的唯一理由是：没有固定事实时，还得让人看见「这条事件本身长什么样」。
 */
const currentTemplate = (db: DatabaseSync, eventId: string) =>
  (db.prepare(`SELECT code, text FROM event WHERE id = ?`).get(eventId) ?? null) as {
    code: string
    text: string
  } | null

const countEvents = (db: DatabaseSync, tripId: string, dogId: string): number => {
  const row = db
    .prepare(`SELECT count(*) AS n FROM trip_event WHERE trip_id = ? AND dog_id = ?`)
    .get(tripId, dogId) as { n: number }
  return Number(row.n)
}

/** 这趟的 Find。没有就是空数组 —— 不许拿 event 链充当 Find 链。 */
const findsOf = (db: DatabaseSync, tripId: string) =>
  db
    .prepare(`SELECT id, kind, source_mode FROM find WHERE trip_id = ? ORDER BY julianday(created_at), id`)
    .all(tripId) as { id: string; kind: string; source_mode: string | null }[]

/**
 * 已到达、还没被回应的最早一条礼物或捎话 —— **寄件方视角**（`from_dog = 自己`）。
 *
 * 多个都在等时取最早到达的那条：等得最久的那件事，最像「它还记着」。
 * 其余几条不丢，记在 `otherPendingWaiting` 里，只作证据、不进快照。
 *
 * 排序用 `julianday()` 而不是字符串比较：库里 `...T05:00:00Z` 与 `... 05:00:00` 混存时，
 * 字符串序会把「更晚」排到前面，于是「等得最久」取错人。
 */
const pendingWaiting = (db: DatabaseSync, dogId: string) =>
  db
    .prepare(
      `SELECT id, kind, created_at, delivered_at
         FROM exchange
        WHERE from_dog = ?
          AND delivered_at IS NOT NULL
          AND replied_at IS NULL
          AND kind IN (${WAITING_KINDS.map(() => '?').join(',')})
        ORDER BY julianday(delivered_at), id`,
    )
    .all(dogId, ...WAITING_KINDS) as {
    id: string
    kind: WaitingKind
    created_at: string
    delivered_at: string
  }[]

// ===========================================================================
// 四、派生
// ===========================================================================

/**
 * 派生一只狗的 snapshot 内容 + 证据。
 *
 * 只读：调用方给 db（可以是 C 事务里的那个连接），本函数不 BEGIN / 不 COMMIT / 不写。
 *
 * `opts.occurrenceFacts` 不传时，摘要来自**此刻的事件模板**，证据里 `historyFixed: false`。
 * 那种结果只能当诊断，不能当成「这趟当时发生了什么」的正式记录。
 */
export function deriveSnapshot(db: DatabaseSync, dogId: string, opts: DeriveOptions = {}): DeriveResult {
  const dog = db
    .prepare(`SELECT id, personality_tags, interest_categories FROM dog WHERE id = ?`)
    .get(dogId) as { id: string; personality_tags: string; interest_categories: string | null } | undefined
  if (!dog) throw new Error(`没有这只狗：${dogId}`)

  const trips = recentTrips(db, dogId)

  const tripEvidence: TripEvidence[] = []
  const summaries: string[] = []
  let withFind = 0
  let missingFacts = 0
  const hasFactReader = opts.occurrenceFacts !== undefined

  for (const t of trips) {
    const occ = earliestOccurrence(db, t.id, dogId)
    const finds = findsOf(db, t.id)
    if (finds.length > 0) withFind += 1

    // 有事件才需要「当时那句话」。没事件的趟不调读取器 —— 那是「没发生」，不是「丢了」。
    const fact = occ ? (opts.occurrenceFacts?.(db, t.id, dogId) ?? null) : null
    // 模板只在**诊断态**读。接了读取器还去读模板，等于给了第二条「看起来正常」的路径。
    const template = !hasFactReader && occ ? currentTemplate(db, occ.event_id) : null
    // 显式null表示历史不可验证，不能拿今天的模板补过去。
    // 未接读取器的旧调用仍可诊断，但不能通过正式转换入口。
    const summary = fact ? fact.text : !occ ? null : hasFactReader ? null : (template?.text ?? null)
    if (occ && !fact) missingFacts += 1

    // 摘要就是那句话本身。不改写、不拼接、不套话：
    // 一旦在这里加一句「它看见了」，那就不再是「发生了什么」，而是 d 替它叙述。
    if (summary !== null) summaries.push(summary)

    tripEvidence.push({
      tripId: t.id,
      seq: t.seq,
      status: t.status,
      startedAt: t.started_at,
      endedAt: t.ended_at,
      eventCount: countEvents(db, t.id, dogId),
      event: occ
        ? {
            id: occ.event_id,
            happenedAt: occ.happened_at,
            // 正式态 code 为 null：adapter 只透传文本，不拿今天的 code 冒充当时的
            code: template?.code ?? null,
            text: fact ? fact.text : (template?.text ?? null),
          }
        : null,
      summary,
      textSource: fact ? 'occurrence' : !occ ? 'none' : hasFactReader ? 'unverifiable' : 'template_current',
      factSourceId: fact ? fact.sourceId : null,
      finds: finds.map((f) => ({ id: f.id, kind: f.kind, sourceMode: f.source_mode })),
    })
  }

  const waits = pendingWaiting(db, dogId)
  const pick = waits[0] ?? null

  const body: SnapshotBody = {
    personalityTags: parseTags(dog.personality_tags),
    interestCategories:
      dog.interest_categories === null ? null : (JSON.parse(dog.interest_categories) as InterestCategory[]),
    recentTrips: summaries,
    waitingFor: pick ? WAITING_TEMPLATE[pick.kind] : null,
  }

  const evidence: SnapshotEvidence = {
    dogId,
    tripsConsidered: trips.length,
    failedTripsIgnored: countFailed(db, dogId),
    trips: tripEvidence,
    waiting: pick
      ? {
          exchangeId: pick.id,
          kind: pick.kind,
          createdAt: pick.created_at,
          deliveredAt: pick.delivered_at,
          template: WAITING_TEMPLATE[pick.kind],
        }
      : null,
    otherPendingWaiting: Math.max(0, waits.length - 1),
    textSource: missingFacts > 0 ? hasFactReader ? 'unverifiable' : 'event.text' : 'occurrence',
    textMutable: missingFacts > 0 && !hasFactReader,
    historyFixed: missingFacts === 0,
    findCoverage: { tripsWithFind: withFind, tripsWithoutFind: tripEvidence.length - withFind },
  }

  return { body, evidence }
}

/** 一次读完所有种子狗。同一份证据、同一个读视角。 */
export function deriveAllSnapshots(db: DatabaseSync, opts: DeriveOptions = {}): DeriveResult[] {
  const dogs = db.prepare(`SELECT id FROM dog WHERE is_sample = 1 ORDER BY id`).all() as { id: string }[]
  return dogs.map((d) => deriveSnapshot(db, d.id, opts))
}

// ===========================================================================
// 五、落库前的那一关：交给统一的 validateSnapshot
// ===========================================================================

/**
 * 把派生内容和版本号拼成一条 snapshot，并用 `lib/social/snapshot.ts` 的
 * `validateSnapshot` 验一遍。
 *
 * **为什么必须调它**：脚本首版在这里复制了「≤40 字」这个常量自己比大小。
 * 那样一来，`snapshot.ts` 的白名单、标签维度互斥、兴趣 2–3 项这些判断全被绕过了 ——
 * 复制常量看起来等价，实际只复制了它记得住的那一条。
 *
 * 不过就抛错，不降级、不截断。本函数只验形状；正式出发必须使用下方toFixedSnapshot，
 * 不能把本函数当成历史固定校验。
 */
export function toSnapshot(
  body: SnapshotBody,
  meta: { dogId: string; version: number; createdAt: string },
): Snapshot {
  // 用展开而不是逐键抄：万一有人往 body 里加了契约外的字段（比如塞一段主人原话），
  // 逐键抄会把它**悄悄丢掉**，然后一切看起来正常；展开才能让 validateSnapshot 的
  // 键白名单把它挡下来。丢字段和拒字段，后者才是我们要的。
  const verdict = validateSnapshot({
    ...body,
    dogId: meta.dogId,
    version: meta.version,
    createdAt: meta.createdAt,
  })
  if (!verdict.ok) {
    throw new Error(
      `派生结果没通过 validateSnapshot：${verdict.code} @ ${verdict.path} —— ${verdict.reason}`,
    )
  }
  return verdict.value
}

/**
 * 正式出发绑定使用此入口，必须保留完整派生证据。
 * toSnapshot仅检查形状，保留给旧调用和诊断；不能独自证明历史固定。
 * 调用方在同一写事务内调用本函数后再分配/保存/绑定并投递，失败整体回滚。
 */
export function toFixedSnapshot(
  result: DeriveResult,
  meta: { dogId: string; version: number; createdAt: string },
): Snapshot {
  if (result.evidence.historyFixed !== true) {
    throw new Error('HISTORY_UNVERIFIABLE: 事件发生时的固定事实缺失，不能生成正式快照')
  }
  if (result.evidence.dogId !== meta.dogId) {
    throw new Error('SNAPSHOT_DOG_MISMATCH: 派生证据与快照归属不一致')
  }
  return toSnapshot(result.body, meta)
}

/**
 * 只验形状、不落库时用（报告里逐只过一遍）。
 *
 * version 用 1 占位：真实版本由 C 的分配器给，这里只借 `validateSnapshot` 验其余六项
 * 与键集合。**不要拿这个函数的返回值去写库**；正式出发走toFixedSnapshot(result, meta)。
 */
export function assertSnapshotShape(body: SnapshotBody, meta: { dogId: string; createdAt: string }): void {
  toSnapshot(body, { dogId: meta.dogId, version: 1, createdAt: meta.createdAt })
}
