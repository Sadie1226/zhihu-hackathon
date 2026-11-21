/**
 * 看山出门 · d · 社交写入的存储边界（store.ts）
 *
 * 出 d，2026-11-19。依据 c 11/19 答复第 1 条：
 *   「业务逻辑必须独立于存储……11/21 接入 C8 正式持久化接口，只替换存储适配器，
 *     不重写相遇和礼物逻辑。Mock 验收与真实信箱验收分开记录。」
 *
 * 所以 meet.ts / gift.ts 只认这个接口，不直接 import `node:sqlite`。
 * 换存储 = 换一个实现，业务代码一行不改。
 *
 * **这个接口刻意不含三样东西**（c 明确禁止 Mock 越权）：
 *   1. 没有 setDelivered —— 投递时间归 c 的投递器，Mock 更不许直接标「已到」
 *   2. 没有 now() —— 时间由调用方传，Adapter 不自己造一个「当前时间」再决定到达
 *   3. 没有 nextTripSeq 自增 —— 只给 currentSeq 读数，「+1」在业务层算，
 *      这样 Mock 和真库算出来的 deliver_after_trip_seq 必然一致
 */

import type { ExchangeKind } from './rules.ts'

// ===========================================================================
// 一、行形状（camelCase。DB 的 snake_case 由适配器负责转）
// ===========================================================================

/** 一条待写入的 exchange。deliverAfterTripSeq 已经算好，store 只管落。 */
export interface ExchangeRow {
  id: string
  fromDog: string
  toDog: string
  kind: ExchangeKind
  payload: Record<string, unknown>
  /** 收件狗第几次出行到达。业务层算，不由 store 决定。 */
  deliverAfterTripSeq: number
  createdAt: string
}

/** 一对狗的关系。dogA < dogB 由业务层保证，store 不排序。 */
export interface RelationRow {
  id: string
  dogA: string
  dogB: string
  firstMetAt: string
  lastMetAt: string
  metCount: number
  isBlocked: 0 | 1
  blockedAt: string | null
}

/** upsertRelation 的返回值：让调用方知道这是第几次见。 */
export interface RelationUpsertResult {
  relation: RelationRow
  /** true 表示这一次是首次相遇（刚插入），false 表示累加。 */
  firstTime: boolean
}

/** 一趟出行的最小读视图。相遇校验只需要这三样。 */
export interface TripRow {
  id: string
  dogId: string
  /** `pending` / `running` / `done` / `failed` / `timeout`，原样返回，由业务层判断。 */
  status: string
  seq: number
}

/**
 * 一条发现的**可信来源**视图。K v4 的 `sourceFindId` / `sourceMode` 只能由它派生。
 *
 * 注意 `dogId` 不是 `find` 表的列 —— `find` 只挂 `trip_id`，归属要
 * `JOIN trip ON t.id = f.trip_id` 才拿得到。api.md K v4 那节给的就是这句 JOIN，
 * 适配器必须照它实现，**不能由调用方传 dogId 进来**，否则「来源属于寄件狗」就成了
 * 一句由客户端自证的废话。
 */
export interface FindSource {
  id: string
  /** 来源 Find 所属的狗（经 trip 反查）。 */
  dogId: string
  /** `find.source_mode`：`live` / `cache` / `fixture`，scene/moment 必为 null。 */
  sourceMode: SourceMode | null
}

export type SourceMode = 'live' | 'cache' | 'fixture'

export interface SocialStore {
  /** 写一条 exchange。同 id 再来返回 'duplicate'，不覆盖、不报错 —— 幂等。 */
  insertExchange(row: ExchangeRow): 'inserted' | 'duplicate'

  /**
   * 相遇一次：首次插入 metCount=1，之后 lastMetAt 更新、metCount+1。
   * firstMetAt 一旦写入永不改。
   */
  upsertRelation(input: {
    dogA: string
    dogB: string
    at: string
  }): RelationUpsertResult

  /** 双向判断，调用方传任意顺序都行。 */
  isBlocked(a: string, b: string): boolean

  /** 收件狗当前第几次出行。只读，不自增。 */
  currentSeq(dogId: string): number

  /**
   * 读：这只狗是不是种子狗（`dog.is_sample = 1`）。
   *
   * 这条不在 c 给的四方法里，是 d 加的第五个 —— 加它的原因只有一个：
   * **「种子狗不伪造主人回话」这条红线，在写入侧唯一能拦的位置就是这里。**
   * 不查 `is_sample`，`gift.ts` 就没法拒绝「用种子狗的身份说一句主人的话」。
   *
   * 它只读、不写任何状态，不会让 Mock 越权（越权指的是自己决定投递时间/标已到）。
   * 如果 c 反对，替代方案是让上游调用方先自查 —— 但那等于把红线交给每个调用点。
   */
  isSample(dogId: string): boolean

  /**
   * 读：按 id 取一条已落库的 exchange。没有则 null。
   *
   * 为什么非要有（a 11-19 复核 `meet.ts` 时点的同一件事）：
   * `insertExchange` 返回 `'duplicate'` 时，**这次调用传进来的 draft 并不是库里的那条**。
   * 若把 draft 当「已送达的那句话」返回给渲染层，用户会看到一条不存在的消息。
   * 所以重放必须回查持久化事实，而不是回显本次入参。
   */
  readExchange(id: string): ExchangeRow | null

  // =========================================================================
  // 下面四个是 11-20 适配器化时补的，`meet.ts` 要用
  // =========================================================================
  //
  // 为什么这几个躲不掉：`meet()` 要在写之前挡三种情况（狗不存在、出行不存在/不归属/
  // 状态不对、这一对被拉黑），还要在重放时读回关系。这些全是**读**，而且读的粒度
  // 没法用上面六个方法表达 —— 不补，meet.ts 就只能继续 import `node:sqlite`，
  // 那 c 的「11/21 只替换存储适配器」就是一句空话。
  //
  // 补的前提是它们**都不写状态**，所以 Mock 不会因此获得「自己决定投递时间」的能力。

  /** 读一对关系（顺序无关）。没有则 null。 */
  readRelation(dogA: string, dogB: string): RelationRow | null

  /** 这只狗存不存在。相遇前的前置校验用。 */
  hasDog(dogId: string): boolean

  /** 按 id 读一趟出行。不存在返回 null。 */
  getTrip(tripId: string): TripRow | null

  /**
   * 按 id 读一条发现的来源（含归属与 `source_mode`）。不存在返回 null。
   *
   * **这是 K v4 唯一允许的来源入口。** c 的 api.md 写死了两句：
   *   「sourceMode 必须从查询结果取，客户端/模型不得自行指定」
   *   「查不到或 dogId 不等于 fromDog 则拒绝」
   * 所以 `gift.ts` / `meet.ts` 不许从入参拿 `dogId` 或 `sourceMode` 拼一个有模有样的
   * source 去自证清白 —— 只认这里读出来的。
   *
   * 只读，不写状态，Mock 不会因此获得投递权。
   */
  getFindSource(findId: string): FindSource | null

  /**
   * 把一段写操作包进一个事务。抛错则整体回滚。
   *
   * 为什么这条必须由 store 提供：`meet()` 的语义是「关系 + 交换要么都成、要么都不成」。
   * 如果事务由调用方在业务层开，那业务层就得拿到 db 句柄 —— 又回到直连数据库。
   *
   * 内存实现的回滚方式是快照恢复，语义等价；**Mock 仍然不能自己决定「什么时候提交」**，
   * 因为 `transaction` 只接受一个回调，不暴露 commit/rollback 句柄。
   */
  transaction<T>(fn: () => T): T
}

// ===========================================================================
// 二、确定性 id
// ===========================================================================
//
// relation 的主键做成「两只狗 id 排序后拼起来」：
//   · 同一对狗永远同一个 id → upsert 天然幂等，不靠先查后写
//   · 不排序会造出 (a,b) 和 (b,a) 两条，schema 的 CHECK (dog_a < dog_b) 也会拦

export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

export function relationId(a: string, b: string): string {
  const [lo, hi] = pairKey(a, b)
  return `rel_${lo}__${hi}`
}

// ===========================================================================
// 三、事务回调必须是同步的
// ===========================================================================
//
// `transaction(fn)` 的语义是「fn 跑完，一次 COMMIT」。这个语义只在 fn 同步时成立：
// fn 若是 async，会在第一个 await 处就交出控制权并返回一个 Promise —— 调用方看到的
// 是「fn 已经完成」，COMMIT / ROLLBACK 于是发生在真正的写之前，事务形同虚设，
// 而且失败的那一刻看不出来，只有数据对不上时才暴露。
//
// A 11-21 的接入条件里写了「不要在回调中 await 网络调用」，但口头约束在联调时拦不住人。
// 这条把它变成一句会立刻炸的检查：异步回调交给 transaction，直接抛 ASYNC_TRANSACTION。

export class AsyncTransactionError extends Error {
  readonly code = 'ASYNC_TRANSACTION'

  constructor() {
    super(
      'transaction 的回调必须是同步的：返回了 Promise / thenable。' +
        '异步步骤（HTTP、读写文件、任何 await）要放在事务之外：' +
        '先取事实，再进事务只做写。',
    )
    this.name = 'AsyncTransactionError'
  }
}

/**
 * 事务回调的返回值必须是同步的。两套实现都过这一关，语义才不会分叉。
 *
 * 判据是「有没有 then」，不是 `instanceof Promise`：跨 realm 的 Promise、
 * 手写的 thenable 都不该漏过去。
 */
export function assertSyncResult<T>(value: T): T {
  const maybe = value as { then?: unknown } | null
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof maybe?.then === 'function'
  ) {
    // 这个 Promise 还会继续跑完。事务已经判失败，它之后的成败都改不了结论；
    // 不挂 catch 的话它会变成 unhandledRejection，把上面这条真正该看的错误埋掉。
    try {
      void Promise.resolve(value as unknown as PromiseLike<unknown>).catch(() => {})
    } catch {
      /* 挂不上 catch 的 thenable，就算了 —— 不能因为它再抛一次把报错换成别的 */
    }
    throw new AsyncTransactionError()
  }
  return value
}

// ===========================================================================
// 四、内存实现（测试与 Mock 阶段用）
// ===========================================================================
//
// 只用来跑通逻辑和验收，**不代表真实信箱**。c 答复要求「Mock 验收与真实信箱验收
// 分开记录」，所以这个类的每条测试都标注 mock，真实库测试放在 store.sqlite.test.ts。

export interface MemoryStoreOptions {
  /** 预置的 blocked 对（升序对）。 */
  blocked?: Array<[string, string]>
  /** 预置的每只狗当前 seq。 */
  seqs?: Record<string, number>
  /** 预置的种子狗 id（`is_sample = 1`）。 */
  samples?: string[]
  /**
   * 预置「库里有哪些狗」。不传则 `hasDog` 一律返回 true ——
   * Mock 关注的是业务逻辑，不是「狗有没有被领养」。
   */
  dogs?: string[]
  /** 预置的出行。相遇校验要用（存在 / 归属 / 状态）。 */
  trips?: Array<{ id: string; dogId: string; seq: number; status: string }>
  /**
   * 预置的发现来源。K v4 的来源校验要用。
   *
   * 内存版里 `dogId` 是**给 Mock 省一次 JOIN** 的，真库里它由 `find⋈trip` 算出。
   * 两者语义必须一致：都是「这条 find 属于哪只狗」，不是调用方声明的。
   */
  finds?: Array<{ id: string; dogId: string; sourceMode: SourceMode | null }>
}

export interface MemoryStore extends SocialStore {
  readonly exchanges: ExchangeRow[]
  readonly relations: Map<string, RelationRow>
}

export function createMemoryStore(opts: MemoryStoreOptions = {}): MemoryStore {
  const exchanges: ExchangeRow[] = []
  const relations = new Map<string, RelationRow>()
  const blocked = new Set((opts.blocked ?? []).map(([a, b]) => relationId(a, b)))
  const seqs = { ...(opts.seqs ?? {}) }
  const samples = new Set(opts.samples ?? [])
  const dogs = opts.dogs ? new Set(opts.dogs) : null
  const trips = new Map((opts.trips ?? []).map((t) => [t.id, { ...t }]))
  const finds = new Map((opts.finds ?? []).map((f) => [f.id, { ...f }]))

  /** 事务回滚用的快照。只存会被写坏的两张「表」。 */
  const snapshot = () => ({
    exchanges: exchanges.map((e) => ({ ...e, payload: { ...e.payload } })),
    relations: new Map([...relations].map(([k, v]) => [k, { ...v }] as const)),
  })
  const restore = (s: ReturnType<typeof snapshot>) => {
    exchanges.length = 0
    exchanges.push(...s.exchanges)
    relations.clear()
    for (const [k, v] of s.relations) relations.set(k, v)
  }

  return {
    exchanges,
    relations,

    insertExchange(row) {
      if (exchanges.some((e) => e.id === row.id)) return 'duplicate'
      // 复制一份，防止调用方后续改对象污染「已落库」的数据
      exchanges.push({ ...row, payload: { ...row.payload } })
      return 'inserted'
    },

    upsertRelation({ dogA, dogB, at }) {
      const [lo, hi] = pairKey(dogA, dogB)
      const id = relationId(lo, hi)
      const hit = relations.get(id)
      if (hit) {
        const next: RelationRow = { ...hit, lastMetAt: at, metCount: hit.metCount + 1 }
        relations.set(id, next)
        return { relation: next, firstTime: false }
      }
      const row: RelationRow = {
        id,
        dogA: lo,
        dogB: hi,
        firstMetAt: at,
        lastMetAt: at,
        metCount: 1,
        isBlocked: 0,
        blockedAt: null,
      }
      relations.set(id, row)
      return { relation: row, firstTime: true }
    },

    isBlocked(a, b) {
      return blocked.has(relationId(a, b))
    },

    currentSeq(dogId) {
      return seqs[dogId] ?? 0
    },

    isSample(dogId) {
      return samples.has(dogId)
    },

    readExchange(id) {
      const hit = exchanges.find((e) => e.id === id)
      // 同样复制一份：调用方改返回值不能污染「已落库」的数据。
      return hit ? { ...hit, payload: { ...hit.payload } } : null
    },

    readRelation(a, b) {
      const hit = relations.get(relationId(a, b))
      return hit ? { ...hit } : null
    },

    hasDog(dogId) {
      // 没配 dogs 时一律放行：这个 Mock 验的是写入逻辑，不是领养流程。
      return dogs === null || dogs.has(dogId)
    },

    getTrip(tripId) {
      const hit = trips.get(tripId)
      return hit ? { ...hit } : null
    },

    getFindSource(findId) {
      const hit = finds.get(findId)
      return hit ? { ...hit } : null
    },

    transaction(fn) {
      const snap = snapshot()
      try {
        return assertSyncResult(fn())
      } catch (err) {
        restore(snap)
        throw err
      }
    },
  }
}
