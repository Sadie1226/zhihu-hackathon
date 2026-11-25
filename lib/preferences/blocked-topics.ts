// 目标位置：lib/preferences/blocked-topics.ts
// B7「表达偏好与边界」的业务边界：屏蔽主题的规范化与判定，纯函数、无 IO。
// 契约事实（contracts/api.md 第五节 / errors.md 禁区二）：
//   - blocked_topics 是 dog 表的列，写入方是 b；C/D/E 只读取过滤，不写。
//   - 屏蔽高于一切：屏蔽 > 心愿 > 朋友牵挂 > 当天事件；命中即不进结果集、不解释。
//   - 过滤语义见 lib/trips/search-proof.ts 的 blockedBy：NFKC + toLocaleLowerCase('zh-CN')
//     后做子串包含。本模块复用同一口径，保证「写入时存什么」与「过滤时怎么判」一致。
// 这里只做规范化与判定；不新建表、不加字段（禁区三），不写数据库（交给路由）。
import type { ContractErrorCode } from '../../contracts/types.ts'

/** 一次最多保存的屏蔽主题条数。防御性上限，不是新契约字段。 */
export const MAX_BLOCKED_TOPICS = 30
/** 单条主题的 NFKC 后最大字符数。 */
export const MAX_TOPIC_LENGTH = 24

export type NormalizeResult =
  | { ok: true; topics: string[] }
  | { ok: false; code: Extract<ContractErrorCode, 'CONFLICT'>; detail: string }

const conflict = (detail: string): NormalizeResult => ({ ok: false, code: 'CONFLICT', detail })

/** 与 C 的 blockedBy 完全同形：NFKC + zh-CN 小写。不要在 B 侧另定一套匹配口径。 */
export function normalizeTopicKey(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('zh-CN')
}

/**
 * 规范化主人提交的主题数组。
 * - 只接受字符串数组；非字符串项整批拒绝，不静默丢弃（避免「我以为屏蔽了其实没生效」）。
 * - 每项 trim 后 NFKC 化；空串拒绝（空串会让 blockedBy 的 `topic.trim()` 判空，形同未屏蔽）。
 * - 超长/超量拒绝，给出可就地修改的提示，不丢已输入内容。
 * - 按 NFKC+小写 key 去重，保留首次出现的 NFKC 原文；顺序稳定，便于界面回显。
 */
export function normalizeBlockedTopics(input: unknown): NormalizeResult {
  if (!Array.isArray(input)) return conflict('屏蔽主题需要是一组词')
  if (input.length > MAX_BLOCKED_TOPICS) {
    return conflict(`最多保存 ${MAX_BLOCKED_TOPICS} 个主题，先删掉一些再试`)
  }
  const seen = new Set<string>()
  const topics: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') return conflict('主题只能是文字')
    const topic = raw.normalize('NFKC').trim()
    if (topic.length === 0) return conflict('主题不能是空的')
    if (topic.length > MAX_TOPIC_LENGTH) {
      return conflict(`每个主题最多 ${MAX_TOPIC_LENGTH} 个字`)
    }
    const key = normalizeTopicKey(topic)
    if (seen.has(key)) continue
    seen.add(key)
    topics.push(topic)
  }
  return { ok: true, topics }
}

/**
 * 屏蔽优先于心愿的判定：给定屏蔽词与若干候选文本，命中其一即应整条不进结果集。
 * 与 lib/trips/search-proof.ts 的 blockedBy 同口径，供 B 侧自检「屏蔽>心愿」用；
 * 真实过滤仍在 C（出行）、D（交换）、E（展示）三处，B 不重复实现过滤。
 */
export function isBlocked(blockedTopics: string[], ...texts: string[]): boolean {
  return blockedTopics.some((topic) => {
    const key = normalizeTopicKey(topic.trim())
    return key.length > 0 && texts.some((text) => normalizeTopicKey(text).includes(key))
  })
}
