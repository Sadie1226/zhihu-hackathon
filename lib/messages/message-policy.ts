// B5 · 归来 Message 的共享文本契约。普通写入与自动归来写入共用，
// 避免两边各自解释人格字数；屏蔽词由 find-scope/search-proof 的共享契约负责。
import { PERSONALITY_TAGS } from '../../contracts/types.ts'
import { TripError } from '../trips/service.ts'

const conflict = (detail = '这条内容不符合要求'): never => { throw new TripError('CONFLICT', detail) }
const knownTags = new Set<string>(PERSONALITY_TAGS)

/** 去首尾空白后拒绝所有控制字符；调用方拿到的是可直接落库的正文。 */
export function normalizeMessageText(value: unknown): string {
  if (typeof value !== 'string') return conflict()
  const text = value.trim()
  if (/[\r\n\t]/.test(text) || [...text].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return conflict()
  }
  return text
}

/** 1–120 字硬上限；话痨 20–35、寡言 8–15。标点算一字，字数为 Unicode code point。 */
export function checkMessageLength(text: string, tags: unknown): void {
  const length = [...text].length
  if (length < 1 || length > 120) return conflict('归来的一句话要在 1 到 120 字之间')
  if (typeof tags !== 'string') return
  let parsed: unknown
  try { parsed = JSON.parse(tags) } catch { return }
  if (!Array.isArray(parsed)) return
  const labels = parsed.filter((tag): tag is string => typeof tag === 'string' && knownTags.has(tag))
  if (labels.includes('话痨') && (length < 20 || length > 35)) {
    return conflict('话痨的归来话要 20 到 35 字')
  }
  if (labels.includes('寡言') && (length < 8 || length > 15)) {
    return conflict('寡言的归来话要 8 到 15 字')
  }
}

/** 普通写入与自动归来共用的正文校验；blockedTopics 为空时不额外收窄。 */
export function validateMessageText(value: unknown, tags: unknown): string {
  const text = normalizeMessageText(value)
  checkMessageLength(text, tags)
  return text
}
