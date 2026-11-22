/**
 * snapshot.ts —— 「状态快照」的形状与生成（d2b 的 snapshot 部分，11-23 用）
 *
 * 这张表是**白名单，不是黑名单**（`contracts/schema.sql` 第 118 行的原话）：
 * 它存在的唯一目的是让别的狗读到这只狗「是什么样」，所以只允许五样东西。
 * 聊天原文、主人心愿原文、照片原图，一个字都不许进。
 *
 * 这个文件只做形状：**收什么、拒什么、怎么归一化。**
 *
 * 不做什么（别写着写着越界）：
 *   · 不查库 —— 纯函数，好测、换存储不用改；「标签与 dog 表一致」由调用方保证，
 *     种子脚本里两边读的是同一行，运行时也同理
 *   · 不写 `recent_trips` 的文案 —— 那是 d5 的内容（话痨写长、寡言写短），
 *     11-23 和「5 只有真实经历的狗」一起定
 *   · 不算 `waiting_for` —— 它要从 exchange 表推（有没有还没到的礼物、有没有没读的来信），
 *     属生成逻辑，不是形状
 *   · 不做「这段文字像不像主人原话」的语义识别 —— 做不了。真正的防线是
 *     `recent_trips` 只接受**摘要**（≤40 字）且由脚本生成，**不接任何 payload 原文**
 */

import {
  INTEREST_CATEGORIES,
  PERSONALITY_TAGS,
  TAG_DIMENSION,
} from '../../contracts/types.ts'
import type { InterestCategory, PersonalityTag } from '../../contracts/types.ts'

// ===========================================================================
// 一、常量
// ===========================================================================

/** 契约里这张表只有这七列（六个业务字段 + 主键里的 version）。多一个键就拒。 */
export const SNAPSHOT_KEYS: readonly string[] = [
  'dogId',
  'version',
  'personalityTags',
  'interestCategories',
  'recentTrips',
  'waitingFor',
  'createdAt',
] as const

/** 契约写明「最多 3 条」。 */
export const MAX_RECENT_TRIPS = 3

/**
 * `recent_trips` 每条与 `waiting_for` 的字数上限。
 *
 * **契约没有规定数字**，这是 d 暂定的：契约只说「只放摘要（一句话）」，
 * 而 `findExcerpt` 允许到 120 字 —— 摘要若也放到 120，就不是摘要了。
 * 取 40 与 `greeting.line` 同档：一句话，界面上一行放得下。
 * a 若要改，改这两个常量，用例会跟着变。
 */
export const TRIP_SUMMARY_MAX = 40
export const WAITING_FOR_MAX = 40

/** 兴趣类目：`null` 表示「没限制」，不是「什么都没有」。 */
export const MIN_INTERESTS = 2
export const MAX_INTERESTS = 3

// ===========================================================================
// 二、类型
// ===========================================================================

export type SnapshotCode =
  | 'MISSING_FIELD' // 必填键不在
  | 'UNKNOWN_KEY' // 契约外的键（白名单主防线）
  | 'WRONG_TYPE' // 类型不对
  | 'EMPTY_STRING' // 必填字符串是空串或全空白
  | 'TOO_LONG' // 超上限
  | 'TOO_MANY_TRIPS' // recent_trips 超过 3 条
  | 'BAD_TAG_COUNT' // 性格标签不是 3 个
  | 'BAD_TAG' // 标签不在 12 个里
  | 'TAG_SAME_DIMENSION' // 两个标签同维度（即互斥对）
  | 'BAD_INTEREST' // 兴趣不是 null、也不是六类里的 2–3 项
  | 'BAD_VERSION' // version 不是正整数

export interface Snapshot {
  dogId: string
  version: number
  personalityTags: [PersonalityTag, PersonalityTag, PersonalityTag]
  interestCategories: InterestCategory[] | null
  recentTrips: string[]
  waitingFor: string | null
  createdAt: string
}

export type SnapshotVerdict =
  | { ok: true; value: Snapshot }
  | { ok: false; code: SnapshotCode; path: string; reason: string }

// ===========================================================================
// 三、校验
// ===========================================================================

function fail(code: SnapshotCode, path: string, reason: string): SnapshotVerdict {
  return { ok: false, code, path, reason }
}

/** 数法照 types.ts 的 countChars：只去空白，标点算一个字。 */
function countChars(text: string): number {
  return text.replace(/\s/g, '').length
}

const TAG_SET: ReadonlySet<string> = new Set(PERSONALITY_TAGS)
const CATEGORY_SET: ReadonlySet<string> = new Set(INTEREST_CATEGORIES)

/**
 * 校验并归一化一条 snapshot。
 *
 * 判定顺序：键集合 → 类型 → 值。**键集合先判**：多出来的键必须第一个被拒，
 * 否则「塞一段主人聊天原文进 payload」只要换个键名就混过去了。
 */
export function validateSnapshot(raw: unknown): SnapshotVerdict {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('WRONG_TYPE', '/', `snapshot 必须是对象，收到 ${describe(raw)}`)
  }
  const obj = raw as Record<string, unknown>

  for (const k of Object.keys(obj)) {
    if (!SNAPSHOT_KEYS.includes(k)) {
      return fail(
        'UNKNOWN_KEY',
        `/${k}`,
        `契约外的键 ${k}。这张表只允许 ${SNAPSHOT_KEYS.join(' / ')} —— 白名单，多一个都不行`,
      )
    }
  }
  for (const k of SNAPSHOT_KEYS) {
    if (!(k in obj)) return fail('MISSING_FIELD', `/${k}`, `缺必填键 ${k}`)
  }

  // ---- dogId / createdAt：非空字符串 ----
  for (const k of ['dogId', 'createdAt'] as const) {
    const v = obj[k]
    if (typeof v !== 'string') {
      return fail('WRONG_TYPE', `/${k}`, `${k} 必须是字符串，收到 ${describe(v)}`)
    }
    if (v.trim() === '') return fail('EMPTY_STRING', `/${k}`, `${k} 不能是空串`)
  }

  // ---- version：正整数 ----
  const version = obj.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return fail(
      'BAD_VERSION',
      '/version',
      `version 必须是 ≥1 的整数（主键的一部分），收到 ${describe(version)}`,
    )
  }

  // ---- personalityTags：恰好 3 个、都在 12 个里、来自 3 个不同维度 ----
  const tags = obj.personalityTags
  if (!Array.isArray(tags)) {
    return fail('WRONG_TYPE', '/personalityTags', `必须是数组，收到 ${describe(tags)}`)
  }
  if (tags.length !== 3) {
    return fail(
      'BAD_TAG_COUNT',
      '/personalityTags',
      `必须恰好 3 个（schema 的 CHECK 也是 3），收到 ${tags.length}`,
    )
  }
  const tagList: PersonalityTag[] = []
  for (let i = 0; i < tags.length; i += 1) {
    const t = tags[i]
    if (typeof t !== 'string') {
      return fail('WRONG_TYPE', `/personalityTags/${i}`, `必须是字符串，收到 ${describe(t)}`)
    }
    if (!TAG_SET.has(t)) {
      return fail('BAD_TAG', `/personalityTags/${i}`, `${t} 不在 12 个性格标签里`)
    }
    tagList.push(t as PersonalityTag)
  }
  const dims = new Set(tagList.map((t) => TAG_DIMENSION[t]))
  if (dims.size !== 3) {
    // 同维度即互斥对（每个维度只有两极）。分开报错会更细，但结论一样：这一组不成立。
    return fail(
      'TAG_SAME_DIMENSION',
      '/personalityTags',
      `3 个标签必须来自 3 个不同维度，实际只来自 ${dims.size} 个：${tagList.join(' / ')}`,
    )
  }

  // ---- interestCategories：null 或六类里的 2–3 项，不许重复 ----
  const interests = obj.interestCategories
  let interestList: InterestCategory[] | null = null
  if (interests !== null) {
    if (!Array.isArray(interests)) {
      return fail(
        'WRONG_TYPE',
        '/interestCategories',
        `必须是数组或 null，收到 ${describe(interests)}`,
      )
    }
    if (interests.length < MIN_INTERESTS || interests.length > MAX_INTERESTS) {
      return fail(
        'BAD_INTEREST',
        '/interestCategories',
        `非 null 时必须是 ${MIN_INTERESTS}–${MAX_INTERESTS} 项，收到 ${interests.length}。` +
          '没有限制就传 null —— 空数组 [] 不等于 null，schema 也不收',
      )
    }
    const seen = new Set<string>()
    interestList = []
    for (let i = 0; i < interests.length; i += 1) {
      const c = interests[i]
      if (typeof c !== 'string') {
        return fail('WRONG_TYPE', `/interestCategories/${i}`, `必须是字符串，收到 ${describe(c)}`)
      }
      if (!CATEGORY_SET.has(c)) {
        return fail('BAD_INTEREST', `/interestCategories/${i}`, `${c} 不在六类里`)
      }
      if (seen.has(c)) {
        return fail('BAD_INTEREST', `/interestCategories/${i}`, `${c} 重复了`)
      }
      seen.add(c)
      interestList.push(c as InterestCategory)
    }
  }

  // ---- recentTrips：≤3 条，每条非空、≤40 字 ----
  const trips = obj.recentTrips
  if (!Array.isArray(trips)) {
    return fail('WRONG_TYPE', '/recentTrips', `必须是数组，收到 ${describe(trips)}`)
  }
  if (trips.length > MAX_RECENT_TRIPS) {
    return fail(
      'TOO_MANY_TRIPS',
      '/recentTrips',
      `最多 ${MAX_RECENT_TRIPS} 条（schema 的 CHECK 也是 3），收到 ${trips.length}`,
    )
  }
  const tripList: string[] = []
  for (let i = 0; i < trips.length; i += 1) {
    const t = trips[i]
    if (typeof t !== 'string') {
      return fail('WRONG_TYPE', `/recentTrips/${i}`, `必须是字符串，收到 ${describe(t)}`)
    }
    if (t.trim() === '') {
      return fail('EMPTY_STRING', `/recentTrips/${i}`, '摘要不能是空串')
    }
    const n = countChars(t)
    if (n > TRIP_SUMMARY_MAX) {
      return fail(
        'TOO_LONG',
        `/recentTrips/${i}`,
        `摘要 ${n} 字，超过 ${TRIP_SUMMARY_MAX}。这里放一句话，find 原文不许进`,
      )
    }
    tripList.push(t)
  }

  // ---- waitingFor：null 或一句话 ----
  const waiting = obj.waitingFor
  let waitingFor: string | null = null
  if (waiting !== null) {
    if (typeof waiting !== 'string') {
      return fail('WRONG_TYPE', '/waitingFor', `必须是字符串或 null，收到 ${describe(waiting)}`)
    }
    if (waiting.trim() === '') {
      return fail('EMPTY_STRING', '/waitingFor', '要么给一句话，要么给 null；空串两不像')
    }
    const n = countChars(waiting)
    if (n > WAITING_FOR_MAX) {
      return fail('TOO_LONG', '/waitingFor', `${n} 字，超过 ${WAITING_FOR_MAX}`)
    }
    waitingFor = waiting
  }

  return {
    ok: true,
    value: {
      dogId: obj.dogId as string,
      version,
      personalityTags: [tagList[0], tagList[1], tagList[2]],
      interestCategories: interestList,
      recentTrips: tripList,
      waitingFor,
      createdAt: obj.createdAt as string,
    },
  }
}

/** 版本号：这只狗还没有快照就是 1，否则上一版 +1。**只增不减。** */
export function nextVersion(previous: number | null): number {
  return previous === null ? 1 : previous + 1
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `数组(${v.length})`
  return typeof v === 'object' ? '对象' : `${typeof v} ${String(v)}`
}
