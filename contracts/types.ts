/**
 * 看山出门 · K 契约 · types.ts
 * 出 c，11-16。**全队唯一的类型来源。**
 *
 * 规矩：谁都不许在自己的文件里再写一遍这些中文字符串。
 * 要判断一只狗是什么标签，import PERSONALITY_TAGS，不要写 '好奇'。
 * 拼错一个字的代价是查不出原因的空列表。
 *
 * 数据库侧见 schema.sql；两者形状必须一致，一致性由 scripts/check-contracts.mjs 守。
 */

// ===========================================================================
// 一、枚举 —— 这三个常量是唯一权威来源
// ===========================================================================

/** 12 个性格标签，6 个维度，每维度两极互斥。每只狗恰好 3 个，来自 3 个不同维度。 */
export const PERSONALITY_TAGS = [
  '好奇', '恋家',     // 维度1 探索范围
  '自来熟', '慢热',   // 维度2 对陌生人
  '话痨', '寡言',     // 维度3 说话密度
  '看物', '看人',     // 维度4 关注对象
  '直给', '婉转',     // 维度5 表达方式
  '当下', '怀旧',     // 维度6 时间感
] as const
export type PersonalityTag = typeof PERSONALITY_TAGS[number]

/** 互斥对：同一只狗不能同时拥有同一对里的两个。 */
export const EXCLUSIVE_PAIRS: [PersonalityTag, PersonalityTag][] = [
  ['好奇', '恋家'], ['自来熟', '慢热'], ['话痨', '寡言'],
  ['看物', '看人'], ['直给', '婉转'], ['当下', '怀旧'],
]

/** 标签 → 维度。校验「3 个标签来自 3 个不同维度」时用这张表，别自己再写一遍。 */
export const TAG_DIMENSION: Record<PersonalityTag, string> = {
  好奇: '探索范围', 恋家: '探索范围',
  自来熟: '对陌生人', 慢热: '对陌生人',
  话痨: '说话密度', 寡言: '说话密度',
  看物: '关注对象', 看人: '关注对象',
  直给: '表达方式', 婉转: '表达方式',
  当下: '时间感', 怀旧: '时间感',
}

/** 六个关注类目。同时是 c 的搜索关键词入口。 */
export const INTEREST_CATEGORIES = [
  '自然风景', '城市角落', '手作与食物',
  '人与故事', '动物与植物', '冷知识',
] as const
export type InterestCategory = typeof INTEREST_CATEGORIES[number]

/** 每类的首轮搜索关键词。c 直接拿去做 zhihu_search 的 Query，**不要自己现编**。 */
export const CATEGORY_KEYWORDS: Record<InterestCategory, string[]> = {
  '自然风景':   ['下雪的地方', '秋天的树', '海边日落'],
  '城市角落':   ['老城区', '街边小店', '深夜便利店'],
  '手作与食物': ['家常菜', '手作', '烘焙'],
  '人与故事':   ['普通人', '一个人生活', '老手艺'],
  '动物与植物': ['猫', '多肉', '流浪动物'],
  '冷知识':     ['为什么', '冷知识', '科普'],
}

/** 内容新鲜度。**不是这条请求现拿的，一律不许标 live。**（不变量四） */
export type SourceMode = 'live' | 'cache' | 'fixture'

/** 信箱里寄的是什么。加第五种必须由 c 改 K，不许谁自己塞一个字符串。 */
export type ExchangeKind = 'find' | 'greeting' | 'gift' | 'co_owner_message'

export type TripStatus = 'pending' | 'running' | 'done' | 'failed' | 'timeout'
export type TripTrigger = 'auto' | 'wish' | 'friend'

export type FindKind = 'scene' | 'zhihu' | 'moment'

/** 回应的形态。**没有 'none'** —— 不回应就是没有这条记录，不是一条空的记录。 */
export type ReplyKind = 'text' | 'photo' | 'both'

/** 邀请的三种状态。**没有存进库，全部从别的表推出来**（见 schema.sql 的 v_invitation_state）。 */
export type InvitationState = 'waiting' | 'replied' | 'gone_alone'

/** 事件候选条件；any 表示不限制。 */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter' | 'any'
export type EventWeather = 'any' | 'clear' | 'rain' | 'snow'
export type TimeOfDay = 'any' | 'morning' | 'dusk' | 'night'
export type PlaceTag = 'street' | 'stall' | 'riverside' | 'bookstore'

/** D 维护的 12 字段事件候选；SQL JSON 文本在读取边界解析，enabled 0/1 转 boolean。 */
export interface Event {
  id: string
  code: string
  text: string
  season: Season
  weather: EventWeather
  timeOfDay: TimeOfDay
  /** [] 不限场景；非空时与 availablePlaces 至少有一个交集。 */
  placeTags: PlaceTag[]
  matchTags: InterestCategory[]
  weight: number
  cooldownDays: number
  /** E2c 提供可用素材引用前为 {}，本次不收窄对象内部结构。 */
  assetRefs: Record<string, unknown>
  enabled: boolean
}

// ===========================================================================
// 二、装配单 —— 固定四个键，多一个都不许加
// ===========================================================================
//
// 11-16 改了范围（a 裁定，DECISIONS 同日）：体型、配色、花纹三层删除。
// 理由：刘看山 IP 只有一种体型与一套配色，那是边界不是工期 —— 边界不留位置，
// 因为留了位置总有人想填。删键有 schema 层的强制力（键数不对直接拦），
// 而收窄成单值枚举只能靠 TS，d 直接产 JSON 时保护不住。
//
// 删掉的键：base（体型 tpl-a/b/c）、skin.color（4 色）、skin.pattern（3 花纹）。
// 剩下的键仍然共用同一块画布、同一套锚点 —— 那条约束没变。

export type DogCloth = 'hoodie' | 'jacket' | 'sweater' | 'raincoat' | 'apron' | 'scarf-coat'
export type DogHat = 'beanie' | 'cap' | 'straw' | 'none'
export type DogGlasses = 'round' | 'square' | 'sun' | 'none'
/**
 * 4 种脸，**领养时定下就不再变** —— 是这只狗的身份，不是情绪状态。
 * 11-16 之前这里写的是「对应 4.4 的情绪」，那句随表情不再随状态变而作废。
 */
export type DogFace = 'happy' | 'tired' | 'hopeful' | 'waiting'

/**
 * 装配单。**这是渲染组件唯一接受的 props，也是存库、进快照、传给对方的唯一格式。**
 * 不是一个图片路径，也不是一段提示词 —— 同一组合永远渲染同一结果，一致性 100%。
 *
 * 四个键对应四层精灵部件：衣服 6 + 帽子 4 + 墨镜 4 + 表情 4 = 18 张，
 * 含「不戴」的透明图（`hat`/`glasses` 取 `none` 时仍然叠一张全透明 PNG，不写特判），
 * 组合 6×4×4×4 = 384 种。
 */
export interface Assembly {
  cloth: DogCloth
  hat: DogHat | null
  glasses: DogGlasses | null
  face: DogFace
}

// ===========================================================================
// 三、九类实体 —— 字段与 schema.sql 一一对应
// ===========================================================================

/** ISO-8601 UTC 字符串，形如 2026-11-16T12:00:00Z。全项目时间都是这个形状。 */
export type IsoTime = string

/** 一只狗。写入方：a（身份/名字/标签/装配单）／b（blockedTopics）／d（isSample）。 */
export interface Dog {
  id: string
  /** 1–6 字。null 则用标签生成的候选名。 */
  name: string | null
  /** 匿名 session，不做登录（D-003）。一个人可以有多只狗。 */
  sessionId: string
  /** 恰好 3 个，来自 3 个不同维度，不含互斥对。 */
  personalityTags: [PersonalityTag, PersonalityTag, PersonalityTag]
  /** 2–3 个类目；null = 全都要。 */
  interestCategories: InterestCategory[] | null
  assembly: Assembly
  /** 种子狗为 true。**界面必须标「示例伙伴」**，装成真人养的算阻断缺陷。 */
  isSample: boolean
  /** **b 写，不是 a。** 全局最高优先级过滤器，高于心愿、高于朋友牵挂、高于当天事件。 */
  blockedTopics: string[]
  createdAt: IsoTime
}

/**
 * 状态快照，给别人家的狗读。写入方：d。
 * **这张表是白名单，不是黑名单。** 下面没有的字段，就是不允许出现的。
 */
export interface Snapshot {
  dogId: string
  version: number
  personalityTags: PersonalityTag[]
  interestCategories: InterestCategory[]
  /** 最多 3 条，只放摘要。**不放 find 原文、不放对话。** */
  recentTrips: string[]
  /** 当前在等什么，人话一句，如「等一条围巾的回音」。 */
  waitingFor: string | null
  createdAt: IsoTime
}

/** 心愿（2.2）。写入方：b。c 只读 category 做搜索入口。 */
export interface Wish {
  id: string
  dogId: string
  /** 主人原话，1–200 字。**只存在这里，不进 snapshot。** */
  text: string
  category: InterestCategory
  createdAt: IsoTime
  /** 撤销填这一刻，不物理删除（手账要能翻回去）。 */
  revokedAt: IsoTime | null
}

/** 一次出行（3.1）。写入方：c。 */
export interface Trip {
  id: string
  dogId: string
  /** **这只狗的第几次出行，从 1 开始。** 投递机制的计量单位，时间拨盘拨的是它。 */
  seq: number
  status: TripStatus
  trigger: TripTrigger
  createdAt: IsoTime
  /** 真正出发那一刻。**投递判断只认它。** */
  startedAt: IsoTime | null
  endedAt: IsoTime | null
}

/** 一条发现（3.2 / 3.4）。写入方：c。 */
export interface Find {
  id: string
  tripId: string
  kind: FindKind
  title: string
  excerpt: string | null
  /** kind='zhihu' 时必填，界面上点得开才算 P0 第 4 条成立。 */
  sourceUrl: string | null
  /**
   * **只对 kind='zhihu' 有意义。** scene / moment 必须是 null。
   * 给自家画的东西标 fixture 会让每一程都像假数据；标 live 就是撒谎。
   */
  sourceMode: SourceMode | null
  /** 知乎 AuthorityLevel，1 低—4 超高。原样存，不让 AI 判断谁可信。 */
  authorityLevel: 1 | 2 | 3 | 4 | null
  voteUpCount: number | null
  /**
   * 11-16 新增。这条发现配的图，**存路径不存二进制**。
   * 三种 kind 都可以有；可空，且**空不等于失败** —— 生成失败退回纯文字，界面不留空白框。
   * 一条发现只许一个路径：生成一次就定稿，换设备打开读的是同一张图。
   */
  assetPath: string | null
  createdAt: IsoTime
}

/**
 * 信箱（4.2 / 4.4 / 捎话共用）。**全表唯一需要拆到列的地方。**
 *
 *   d 写 fromDog / toDog / kind / payload / deliverAfterTripSeq / createdAt
 *   c 写 deliveredAt（投递器独占，写一次就不再写）
 *   b 写 repliedAt（回应能力独占）
 *   e 写 readAt
 */
export interface Exchange {
  id: string
  fromDog: string
  toDog: string
  kind: ExchangeKind
  /** 业务内容，四种 kind 各有形状，见 api.md。 */
  payload: ExchangePayload
  /**
   * **不是一个时间戳，是「收件狗第几次出行」。**
   * 发送时算：收件狗当前 seq + 1。
   * 判断到达：收件狗有 startedAt 不为空、seq >= 本值的 trip。
   * **写成 `now > 某个时间戳`，演示时延后礼物永远不会到。**
   */
  deliverAfterTripSeq: number
  createdAt: IsoTime
  deliveredAt: IsoTime | null
  repliedAt: IsoTime | null
  readAt: IsoTime | null
}

/** 四种 kind 各自的 payload。**主人原话只许留在这里，绝不进 snapshot。** */
export type ExchangePayload =
  | { kind: 'find'; findTitle: string; findExcerpt: string | null; sourceUrl: string | null }
  | { kind: 'greeting'; line: string; weather: string | null }
  /**
   * gift —— 礼物（P0 第 8 条）。11-16 新增 `imagePath`：礼物图标走 AI 生成。
   * 三样东西（名字、附言、图）必须在同一步定稿并一起落库 ——
   * 分三条流水线各管一段，会出现名字写「一小卷灰蓝色的毛线」、图画出来是个茶杯。
   * `imagePath` 可空；空时界面退成纯文字，不出现空白框。
   */
  | { kind: 'gift'; giftName: string; note: string | null; imagePath: string | null }
  | { kind: 'co_owner_message'; message: string; fromOwnerOf: string }

/** 归来的一句话（2.3）。写入方：b。**必须和 trip 分表。** */
export interface Message {
  id: string
  tripId: string
  /** 话痨 20–35 字 / 寡言 8–15 字，去掉空白后**标点算一个字**。 */
  text: string
  mentionsFindId: string | null
  createdAt: IsoTime
}

/**
 * 一次邀请（2.4，P0 第 6 条，核心闭环的入口）。写入方：b。
 * **没有 expiresAt，也不许加 —— 邀请永不过期。**
 * 也没有 status，三种状态全部从别的表推出来，所以没有第二个写入方。
 */
export interface Invitation {
  id: string
  dogId: string
  /** **必须有具体动作 + 一个理由 + 一个不做的余地**，缺一条重写。 */
  text: string
  /** 这条邀请接的是它自己看到的哪条发现。有它才能验收「理由必须接它自己的兴趣」。 */
  basedOnFindId: string | null
  createdAt: IsoTime
}

/** 邀请 + 推导出来的状态。查询用 v_invitation_state 视图，别自己算。 */
export interface InvitationView extends Invitation {
  state: InvitationState
  replyId: string | null
  goneAloneTripId: string | null
}

/**
 * 一次回应（2.4）。写入方：b，**唯一实现**，d 来调它。
 * 来源恰好一个：exchangeId 或 invitationId。
 *
 * **两个来源各有唯一索引，重复提交在两条路径上都被数据库拦住。**
 * 只给一条做去重就是漏 —— 这是同一个提交能力的两个入口。
 */
export interface Reply {
  id: string
  exchangeId: string | null
  invitationId: string | null
  /** 上限 200 字。 */
  text: string | null
  /** 照片路径，≤5MB，jpg/png/webp。存路径不存二进制。 */
  photoUrl: string | null
  /** 推导列，不是写入方。**不会有 'none'** —— 空回应插不进库。 */
  kind: ReplyKind
  createdAt: IsoTime
}

/** 邻里关系（4.1 / 4.3）。写入方：d。**关系类事实只有 d 写，别人只读。**（不变量五） */
export interface Relation {
  id: string
  /** 按字典序小的放 dogA，避免同一对关系存成两条。 */
  dogA: string
  dogB: string
  firstMetAt: IsoTime
  lastMetAt: IsoTime
  metCount: number
  /** 拉黑同时作用于狗和主人。拉黑后匹配函数必须双向排除这一对。 */
  isBlocked: boolean
  blockedAt: IsoTime | null
}

/** c3 v2：关系读取中的对方狗公开白名单，不返回完整 Dog。 */
export interface PublicDogSummary {
  id: Dog['id']
  name: Dog['name']
  assembly: Assembly
  isSample: Dog['isSample']
}

/** 只读关系及对方最新快照；没有快照时为 null，不改变 Snapshot 内部空值规则。 */
export interface RelationView {
  relation: Relation
  otherDog: PublicDogSummary
  snapshot: Snapshot | null
}

/** GET /api/dogs/:id/relations；请求狗必须属于服务端当前匿名 session。 */
export interface RelationsResponse {
  relations: RelationView[]
}

/** GET /api/exchanges?from_dog=:id；只返回当前 session 所属发送狗的记录。 */
export interface ExchangesResponse {
  exchanges: Exchange[]
}

// ===========================================================================
// 四、错误码 —— 与 errors.md 一致
// ===========================================================================

/**
 * **不混成一个 500。** 五种情况界面表现完全不同：
 *   NETWORK      如实说断网，四态里的「失败」
 *   RATE_LIMITED 降级到 cache 并标 cache，**不重试**
 *   AUTH         服务端告警，用户侧静默降级
 *   BLOCKED      不显示，也不解释为什么
 *   TIMEOUT      超时收尾成一个正常结束的 trip，不是空状态
 * 没搜到和被屏蔽主题**不是错误**，是空数组，不显示。
 */
export type ContractErrorCode =
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'AUTH'
  | 'BLOCKED'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'CONFLICT'

export interface ContractError {
  code: ContractErrorCode
  /** 给日志看的技术细节。**不许直接显示给用户。** */
  detail: string
  /** 是否可以原样重试。RATE_LIMITED 和 BLOCKED 永远是 false。 */
  retriable: boolean
}

// ===========================================================================
// 五、校验函数 —— 这几个是给 b 和 a 直接用的，别各自实现
// ===========================================================================

/**
 * 性格标签合不合规矩。a 在领养页生成标签时调它；
 * fixtures 和小队自测也调它，保证大家数出来的是同一个答案。
 */
export function checkPersonalityTags(tags: string[]): { ok: true } | { ok: false; reason: string } {
  if (tags.length !== 3) return { ok: false, reason: `必须恰好 3 个标签，现在 ${tags.length} 个` }
  const unknown = tags.filter((t) => !(PERSONALITY_TAGS as readonly string[]).includes(t))
  if (unknown.length) return { ok: false, reason: `不在 12 个标签里：${unknown.join('、')}` }
  const dims = new Set(tags.map((t) => TAG_DIMENSION[t as PersonalityTag]))
  if (dims.size !== 3) return { ok: false, reason: `3 个标签必须来自 3 个不同维度，现在只占 ${dims.size} 个` }
  return { ok: true }
}

/**
 * 字数区间。**只去掉空格和换行，标点算一个字。**
 * 这是全队唯一的数法 —— 不按汉字数、不按词数、英文不按单词数。
 */
export const LEN_RANGE: Record<string, [number, number]> = {
  '话痨': [20, 35],
  '寡言': [8, 15],
}

export function countChars(text: string): number {
  return text.replace(/\s/g, '').length
}

export function checkLength(text: string, tags: string[]): { ok: true } | { ok: false; reason: string } {
  const n = countChars(text)
  for (const tag of tags) {
    const range = LEN_RANGE[tag]
    if (!range) continue
    const [min, max] = range
    if (n < min) return { ok: false, reason: `太短了，${tag}要 ${min}–${max} 字，现在 ${n}` }
    if (n > max) return { ok: false, reason: `太长了，${tag}要 ${min}–${max} 字，现在 ${n}` }
  }
  return { ok: true }
}

/**
 * 投递判断 —— **全项目唯一正确的写法。**
 * c 的投递器用它；d 想知道「我的礼物到了没」也用它，别自己写 `now > x`。
 *
 * 语义：收件狗只要有任意一次出行满足「已出发 且 seq >= deliverAfterTripSeq」，就算到达。
 * 不涉及时钟。演示时拨一次出行就到。
 */
export function isDeliverable(
  deliverAfterTripSeq: number,
  recipientTrips: Pick<Trip, 'seq' | 'startedAt'>[],
): boolean {
  return recipientTrips.some((t) => t.startedAt !== null && t.seq >= deliverAfterTripSeq)
}

/** 待回应邀请的上限。第 4 条不再生成邀请，改「它自己去了」；旧的移进手账，不删。 */
export const MAX_WAITING_INVITATIONS = 3

/** 一天出行两次（早晚各一，间隔 ≥6 小时）。演示用时间拨盘加速，不靠真实时钟。 */
export const TRIPS_PER_DAY_MAX = 2
export const TRIP_MIN_GAP_HOURS = 6
