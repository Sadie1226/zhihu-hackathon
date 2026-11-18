/**
 * 看山出门 · d · 交换校验规则（rules.ts）
 *
 * 出 d，2026-11-17。规格见 team/2026-11-16/d/1116-d1b-校验规则清单-v1.md。
 *
 * 这个文件只做一件事：**判断一条 exchange 草稿的形状合不合契约。**
 *
 * 不做什么（别写着写着越界）：
 *   · 不查数据库 —— 纯函数，好测、能并行、换存储不用改
 *   · 不算 deliver_after_trip_seq —— api.md 第七节：c 查收件狗当前 seq 再加一
 *   · 不判断内容好不好、像不像狗说的话 —— 那是 a 和 b 的活
 *   · 不做「主人聊天原文」的语义识别 —— 做不了，靠结构堵
 *   · 不写 deliveredAt / repliedAt / readAt —— 列级拆分，越权
 *
 * 核心设计：**白名单靠「键集合严格相等」实现，不靠关键词匹配。**
 * payload 只允许契约里那几个键，多一个键就拒。这样「塞一段主人聊天原文进去」
 * 就没有地方放 —— 比写一堆正则去猜「这句话像不像聊天记录」可靠得多。
 */

// ===========================================================================
// 一、类型与常量
// ===========================================================================

/** 四种 kind。加第五种必须由 c 改 K（types.ts 的 ExchangeKind）。 */
export type ExchangeKind = 'find' | 'greeting' | 'gift' | 'co_owner_message'

export const EXCHANGE_KINDS: readonly ExchangeKind[] = [
  'find',
  'greeting',
  'gift',
  'co_owner_message',
] as const

/** 拒绝理由。接口层拿它去映射文案，本层不返回 HTTP 错误码。 */
export type RuleCode =
  | 'MISSING_FIELD'   // 必填键不在
  | 'UNKNOWN_KEY'     // 契约外的键（白名单主防线）
  | 'WRONG_TYPE'      // 类型不对
  | 'EMPTY_STRING'    // 必填字符串是空串或全空白
  | 'TOO_LONG'        // 超上限
  | 'TOO_SHORT'       // 低于下限
  | 'BAD_KIND'        // kind 不在四值里，或 payload.kind 与外层不一致
  | 'SELF_EXCHANGE'   // 狗给自己寄东西
  | 'FORBIDDEN_KEY'   // 命中内容层黑名单，或越权写别人的列
  | 'BLOCKED_TOPIC'   // 命中 blockedTopics

/** 进校验器的形状。只有四个键 —— 故意用 unknown，进来先验形状。 */
export interface ExchangeDraft {
  fromDog: string
  toDog: string
  kind: ExchangeKind
  payload: unknown
}

/** 出校验器的形状。payload 已经收窄成契约允许的键。 */
export interface NormalizedExchange {
  fromDog: string
  toDog: string
  kind: ExchangeKind
  payload: Record<string, unknown>
  /** 允许透传，但不进 payload 校验。 */
  createdAt?: string
}

export type Verdict =
  | { ok: true; value: NormalizedExchange }
  | { ok: false; code: RuleCode; path: string; reason: string }

/**
 * payload 白名单。**这份表的键集合就是唯一准入名单，多一个键就拒。**
 *
 * 注意 gift 的 `imagePath`：11-16 晚 a 在 b60fe24 加的（P0 第 8 条，礼物图标走 AI 生成）。
 * 它是必填键、值可 null —— 「可空」不等于「可以没有这个键」。
 */
const PAYLOAD_KEYS: Record<ExchangeKind, readonly string[]> = {
  find: ['kind', 'findTitle', 'findExcerpt', 'sourceUrl'],
  greeting: ['kind', 'line', 'weather'],
  gift: ['kind', 'giftName', 'note', 'imagePath'],
  co_owner_message: ['kind', 'message', 'fromOwnerOf'],
}

/**
 * 已申请但 c 未批的字段，**批了之后在这里加，别在别处加**（d0b B1）。
 * 现在是空的，所以带了这些键的 payload 会被 UNKNOWN_KEY 拒 —— 这是对的，
 * 没批就不能自己加（禁区三）。
 *
 *   find: sourceMode（不变量四要的降级标注）、sourceFindId（出处）
 *   gift: sourceFindId
 */
const PENDING_KEYS: Record<ExchangeKind, readonly string[]> = {
  find: [],
  greeting: [],
  gift: [],
  co_owner_message: [],
}

/**
 * 必填字段的长度区间。**计数用 countChars：只去空白，标点算一个字。**
 * 数字是 d 暂定的（契约没有规定 payload 长度），依据见 d1b 第十一节。
 * 第二个值是 null 表示只卡下限，不卡上限。
 */
const LEN_RANGE: Record<string, [number, number | null]> = {
  findTitle: [1, 30],
  findExcerpt: [0, 120],
  line: [1, 40],
  weather: [1, 4],
  giftName: [1, 20],
  note: [0, 40],
  message: [1, 60],
}

/** 草稿层允许的键。其余一律拒 —— id / 三个状态时间都归别人。 */
const DRAFT_KEYS: readonly string[] = ['fromDog', 'toDog', 'kind', 'payload', 'createdAt']

/**
 * 越权字段：d 不许传。camelCase 和 snake_case 都拦，上游可能给任一种。
 * 逐条对 api.md 的列级拆分：
 *   deliver_after_trip_seq → c 算；delivered_at → c 独占；replied_at → b 独占；read_at → e 独占
 *   id / created_at → 写入层生成
 */
const OVERREACH_KEYS = new Set([
  'deliverAfterTripSeq',
  'deliveredAt',
  'repliedAt',
  'readAt',
  'id',
])

/**
 * 内容层黑名单键名（大小写与下划线不敏感，**精确匹配不是包含匹配**）。
 *
 * 为什么要精确匹配：`imagePath` 是契约允许的键，若用「包含 image」来判，
 * 会把礼物图标误杀。这里只拦整键名。
 */
const FORBIDDEN_KEYS = new Set([
  // 主人聊天原文的**派生形态**（摘要、日志、对话记录）。
  // 注意这里没有 'chattext'，而且故意不能有：
  // 「payload 里塞一段主人聊天原文（键名 chatText）」必须被报成 UNKNOWN_KEY，
  // 不是 FORBIDDEN_KEY。前者说明白名单结构生效了，后者说明在靠关键词猜 —— 猜是会漏的。
  // 见 d1b 第九节反例 16，那是这份规格的验收标准。
  'chatsummary',
  'chatlog',
  'conversation',
  'dialogue',
  // 照片 / 图像原图（imagePath 是路径白名单键，不在此列）
  'photourl',
  'photo',
  'image',
  'imageurl',
  'avatar',
  // 身份信息
  'address',
  'city',
  'location',
  'hometown',
  'ownername',
  'realname',
  'username',
  'nickname',
  // 心愿原文
  'wishtext',
  'wish',
  // 屏蔽词本身不该跟着内容走
  'blockedtopics',
  // 调试字段：会把模型输出原样带过去，里面可能有任何东西
  'llmraw',
  'raw',
  'debug',
  'trace',
])

// ===========================================================================
// 二、小工具
// ===========================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** snake_case → camelCase。`find_title` → `findTitle`，`kind` 不变。 */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** 黑名单比对用的归一化：小写 + 去下划线。 */
function normalizeKeyForBlocklist(key: string): string {
  return key.toLowerCase().replace(/_/g, '')
}

/** 数法照 types.ts 的 countChars：只去空白，标点算一个字。 */
export function countChars(text: string): number {
  return text.replace(/\s/g, '').length
}

function fail(code: RuleCode, path: string, reason: string): Verdict {
  return { ok: false, code, path, reason }
}

// ===========================================================================
// 三、normalize —— 只做形状转换，不做校验
// ===========================================================================
//
// 和 validate 分开的原因：normalize 的偏差是「可以容忍的输入形态差异」，
// validate 的拒绝是「真的不合规」。混在一起，以后 c 改了 fixture，分不清是哪一层在报警。
//
// 做四件事：
//   1. snake_case → camelCase（fixture 和 DB 行是 snake_case，见 d0b B2）
//   2. 0/1 → false/true（DB 用整数，类型用布尔）
//   3. 外层 kind 补进 payload（若 payload.kind 缺失）
//   4. 不认识的键**保留**，交给 validate 去拒 —— normalize 不替校验做决定

export function normalize(raw: unknown): ExchangeDraft {
  const src = isPlainObject(raw) ? raw : {}
  const out: Record<string, unknown> = {}

  for (const [k, v] of Object.entries(src)) {
    out[snakeToCamel(k)] = v
  }

  // payload 内部的键也转一遍 —— DB 里存的是我们写的 camelCase，但上游可能给 snake_case
  if (isPlainObject(out.payload)) {
    const p: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(out.payload)) {
      p[snakeToCamel(k)] = v
    }
    // 外层 kind 补进 payload：fixtures/exchange.json 曾经缺这个键（c3 已修，
    // 但 normalize 保留这层兼容，防止别处的旧数据/旧 fixture 又冒出来）
    if (typeof out.kind === 'string' && p.kind === undefined) {
      p.kind = out.kind
    }
    out.payload = p
  }

  // 0/1 → 布尔。这几个键出现在草稿里本来就会被越权检查拦，
  // 但转对了才能给出「越权」这个准确理由，而不是「类型不对」。
  for (const key of ['isSample', 'isBlocked']) {
    const v = out[key]
    if (v === 0 || v === 1) out[key] = v === 1
  }

  return out as unknown as ExchangeDraft
}

// ===========================================================================
// 四、validate —— 只认一种形状，不合规就拒
// ===========================================================================
//
// 顺序不是随便排的：便宜的检查在前，需要外部数据的在后。撞到第一条就返回。
//
// 与 d1b 第二节的一处偏差，写在明处：
//   d1b 把「黑名单扫描」排在第 7 步（键集合之后），但那样 chatSummary 会先被
//   键集合严格相等拦成 UNKNOWN_KEY，永远轮不到 FORBIDDEN_KEY。
//   两份反例要的恰恰是区分开（chatText → UNKNOWN_KEY，chatSummary → FORBIDDEN_KEY），
//   所以黑名单扫描提前到键集合检查之前。

export interface ValidateOptions {
  /** 不传就跳过这一层（函数保持纯，测试可以不带）。 */
  blockedTopics?: string[]
}

export function validate(raw: unknown, opts: ValidateOptions = {}): Verdict {
  const draft = normalize(raw)

  // ---- 1. 顶层键集合：先挡越权字段 ----
  if (!isPlainObject(draft)) {
    return fail('WRONG_TYPE', '', '草稿必须是对象')
  }
  for (const key of Object.keys(draft)) {
    if (OVERREACH_KEYS.has(key)) {
      return fail('FORBIDDEN_KEY', `/${key}`, `${key} 不该由 d 传（写入方不是 d）`)
    }
    if (!DRAFT_KEYS.includes(key)) {
      return fail('UNKNOWN_KEY', `/${key}`, `草稿层不接受 ${key}`)
    }
  }

  // ---- 2. 四个键齐全 + 类型 ----
  for (const key of ['fromDog', 'toDog', 'kind', 'payload']) {
    if (!(key in draft)) {
      return fail('MISSING_FIELD', `/${key}`, `缺 ${key}`)
    }
  }
  for (const key of ['fromDog', 'toDog', 'kind']) {
    if (typeof (draft as Record<string, unknown>)[key] !== 'string') {
      return fail('WRONG_TYPE', `/${key}`, `${key} 必须是字符串`)
    }
  }

  // ---- 3. kind 必须在四值里 ----
  if (!EXCHANGE_KINDS.includes(draft.kind)) {
    return fail('BAD_KIND', '/kind', `kind 只能是 ${EXCHANGE_KINDS.join(' / ')}，收到 ${String(draft.kind)}`)
  }

  // ---- 4. 不能寄给自己 ----
  if (draft.fromDog === draft.toDog) {
    return fail('SELF_EXCHANGE', '/toDog', '狗不能给自己寄东西')
  }

  // ---- 5. payload 必须是纯对象 ----
  if (!isPlainObject(draft.payload)) {
    return fail('WRONG_TYPE', '/payload', 'payload 必须是对象（非 null、非数组）')
  }
  const payload = draft.payload

  // ---- 6. payload.kind 与外层 kind 必须一致 ----
  // normalize 只解决「缺」；两边都有但不一样，说明上游已经错了，必须拒，不能挑一个当真。
  if (payload.kind !== draft.kind) {
    return fail(
      'BAD_KIND',
      '/payload/kind',
      `payload.kind(${String(payload.kind)}) 与外层 kind(${draft.kind}) 不一致`,
    )
  }

  // ---- 7a. 内容层黑名单（键名，不看值）----
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_KEYS.has(normalizeKeyForBlocklist(key))) {
      return fail('FORBIDDEN_KEY', `/payload/${key}`, `${key} 属于禁止进 payload 的字段`)
    }
  }

  // ---- 7b. 键集合严格相等：多一个拒，少一个也拒 ----
  const allowed = PAYLOAD_KEYS[draft.kind]
  const pending = PENDING_KEYS[draft.kind]
  const whitelist = new Set([...allowed, ...pending])
  for (const key of Object.keys(payload)) {
    if (!whitelist.has(key)) {
      return fail('UNKNOWN_KEY', `/payload/${key}`, `payload 不接受 ${key}（${draft.kind} 只允许 ${allowed.join(' / ')}）`)
    }
  }
  for (const key of allowed) {
    if (!(key in payload)) {
      return fail('MISSING_FIELD', `/payload/${key}`, `${draft.kind} 必须有 ${key}（值可以是 null，但键要在）`)
    }
  }

  // ---- 7c. 逐字段 ----
  const fieldError = validateFields(draft.kind, payload)
  if (fieldError) return fieldError

  // ---- 8. blockedTopics 命中（可选）----
  const blocked = opts.blockedTopics
  if (blocked && blocked.length > 0) {
    const haystack = collectStrings(payload).join('\n').toLowerCase()
    for (const topic of blocked) {
      const needle = topic.trim().toLowerCase()
      if (needle && haystack.includes(needle)) {
        // 不解释命中哪个词给用户看 —— errors.md 的 BLOCKED 语义：不显示、不解释为什么
        return fail('BLOCKED_TOPIC', '/payload', '命中屏蔽主题')
      }
    }
  }

  return {
    ok: true,
    value: {
      fromDog: draft.fromDog,
      toDog: draft.toDog,
      kind: draft.kind,
      payload: { ...payload },
      ...(typeof (draft as Record<string, unknown>).createdAt === 'string'
        ? { createdAt: (draft as Record<string, unknown>).createdAt as string }
        : {}),
    },
  }
}

/** 把 payload 里所有字符串值摊平，给 blockedTopics 做包含匹配。 */
function collectStrings(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.flatMap(collectStrings)
  if (isPlainObject(v)) return Object.values(v).flatMap(collectStrings)
  return []
}

// ===========================================================================
// 五、逐字段校验（四种 kind 各自的表）
// ===========================================================================
//
// 「可空」不等于「可以没有这个键」：键必须在，值可以 null。这是契约里最容易误解的一处。
// 所以下面每个可空字段都要先判 `in`，再判是不是 null。

function validateFields(kind: ExchangeKind, p: Record<string, unknown>): Verdict | null {
  switch (kind) {
    case 'find':
      return validateFind(p)
    case 'greeting':
      return validateGreeting(p)
    case 'gift':
      return validateGift(p)
    case 'co_owner_message':
      return validateCoOwnerMessage(p)
  }
}

/** 必填字符串：非 null、非空、不超长。 */
function checkRequiredString(
  p: Record<string, unknown>,
  key: string,
): Verdict | null {
  const v = p[key]
  if (typeof v !== 'string') {
    return fail('WRONG_TYPE', `/payload/${key}`, `${key} 必须是字符串`)
  }
  if (countChars(v) === 0) {
    return fail('EMPTY_STRING', `/payload/${key}`, `${key} 不能是空白`)
  }
  return checkLength(key, v)
}

/** 可空字符串：null 直接过；是字符串才查长度。 */
function checkNullableString(
  p: Record<string, unknown>,
  key: string,
): Verdict | null {
  const v = p[key]
  if (v === null) return null
  if (typeof v !== 'string') {
    return fail('WRONG_TYPE', `/payload/${key}`, `${key} 必须是字符串或 null`)
  }
  return checkLength(key, v)
}

function checkLength(key: string, v: string): Verdict | null {
  const range = LEN_RANGE[key]
  if (!range) return null
  const [min, max] = range
  const n = countChars(v)
  if (n < min) {
    return fail('TOO_SHORT', `/payload/${key}`, `${key} 至少要 ${min} 字，现在 ${n}`)
  }
  if (max !== null && n > max) {
    return fail('TOO_LONG', `/payload/${key}`, `${key} 最多 ${max} 字，现在 ${n}`)
  }
  return null
}

// ---- find ----
function validateFind(p: Record<string, unknown>): Verdict | null {
  return (
    checkRequiredString(p, 'findTitle') ??
    checkNullableString(p, 'findExcerpt') ??
    checkSourceUrl(p) ??
    // sourceMode 未批，若有人传了会在键集合那步被 UNKNOWN_KEY 拒。
    // c 批下来后：把 'sourceMode' 加进 PENDING_KEYS.find，并在这里补
    //   「sourceUrl 非 null 时 sourceMode 必须非 null」
    //   「sourceMode === 'live' 时 sourceUrl 不能为 null」
    null
  )
}

function checkSourceUrl(p: Record<string, unknown>): Verdict | null {
  const v = p.sourceUrl
  if (v === null) return null
  if (typeof v !== 'string') {
    return fail('WRONG_TYPE', '/payload/sourceUrl', 'sourceUrl 必须是字符串或 null')
  }
  // 有链接就必须点得开 —— 界面上点不开的「知乎内容」等于没有出处
  if (!v.startsWith('https://www.zhihu.com/')) {
    return fail('WRONG_TYPE', '/payload/sourceUrl', 'sourceUrl 必须以 https://www.zhihu.com/ 开头')
  }
  return null
}

// ---- greeting ----
function validateGreeting(p: Record<string, unknown>): Verdict | null {
  // 没有 sourceMode —— 问候是狗自己生成的话，不属于「知乎内容是否新鲜」那一套
  return checkRequiredString(p, 'line') ?? checkNullableString(p, 'weather')
}

// ---- gift ----
function validateGift(p: Record<string, unknown>): Verdict | null {
  const err =
    checkRequiredString(p, 'giftName') ??
    // note: null 必须合法（d1 第八节验收第 5 条）。直给的狗不写解释，
    // 界面不许因为 note 空就补一句「它好像还想说什么」。
    checkNullableString(p, 'note') ??
    checkNullableString(p, 'imagePath')
  if (err) return err

  // imagePath 是路径不是二进制，存的是 /assets/gen/xxx.webp 这种
  const img = p.imagePath
  if (typeof img === 'string' && img.trim() !== '' && !img.startsWith('/')) {
    return fail('WRONG_TYPE', '/payload/imagePath', 'imagePath 必须是 / 开头的站内路径')
  }
  return null
}

// ---- co_owner_message ----
function validateCoOwnerMessage(p: Record<string, unknown>): Verdict | null {
  const err = checkRequiredString(p, 'message')
  if (err) return err

  const v = p.fromOwnerOf
  if (typeof v !== 'string') {
    return fail('WRONG_TYPE', '/payload/fromOwnerOf', 'fromOwnerOf 必须是字符串')
  }
  if (countChars(v) === 0) {
    return fail('EMPTY_STRING', '/payload/fromOwnerOf', 'fromOwnerOf 不能是空白')
  }
  // 填的是狗 id，不是人的名字。对面看到的是「豆子的主人说」，不是「某某说」——
  // 这样一个人永远不知道对面那个人是谁（不变量一）。
  // 自动判定只能做到「看起来像 id」：含中文一律拒。名字一定是中文，狗 id 一定不是。
  // 这个办法很土，但它拦得住最容易犯的那个错。
  if (/[\u4e00-\u9fa5]/.test(v)) {
    return fail(
      'WRONG_TYPE',
      '/payload/fromOwnerOf',
      'fromOwnerOf 必须是狗 id，不能是人名（含中文一律拒）',
    )
  }
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(v)) {
    return fail(
      'WRONG_TYPE',
      '/payload/fromOwnerOf',
      'fromOwnerOf 只能是 2–64 位的字母、数字、下划线或连字符',
    )
  }
  return null
}

// ===========================================================================
// 六、给调用方的一句话
// ===========================================================================
//
// 先 normalize 把输入形态的差异吃掉，再 validate 只认一种形状。
// 校验失败给的是结构化的 code + path，不是 HTTP 错误码 —— errors.md 那七个码里
// 没有「参数格式错」，接口层自己映射（多数情况映射成 CONFLICT + detail）。
