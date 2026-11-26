// 目标位置：lib/replies/material.ts
// b8「回应成为下次材料」B 侧确定性业务逻辑（纯函数，不连库、不调 AI、不落库）。
// 设计依据：team/2026-11-23/b/1123-b-回应进入下次材料-调用链设计与回交-v1.md §2/§4。
// 边界：C 尚未在 wish 表加 source='reply' 与 origin_reply_id，本模块只产出
// 「目标态 wish 草稿」与溯源/幂等语义；真正写库由 material-store.ts 在
// schema 前置满足后才执行，前置不满足时明确 blocked，绝不降级写 owner/collection。

import { CATEGORY_KEYWORDS, INTEREST_CATEGORIES } from '../../contracts/types.ts'
import type { InterestCategory, Reply } from '../../contracts/types.ts'

/** 目标态来源。当前 main 的 CHECK 只允许 owner/collection，需 C 扩枚举后才可写。 */
export const REPLY_WISH_SOURCE = 'reply' as const

/** 一次回应转出的可搜索材料。 */
export interface ReplyMaterial {
  /** 可直接当 C6 discover query 的搜索意图，1–200 字。 */
  text: string
  category: InterestCategory
  /** 溯源锚点：原回应 id。 */
  fromReplyId: string
}

/** 目标态 wish 草稿；字段对齐契约 Wish + 待 C 新增的 originReplyId。 */
export interface ReplyWishDraft {
  id: string
  dogId: string
  text: string
  category: InterestCategory
  createdAt: string
  revokedAt: null
  source: typeof REPLY_WISH_SOURCE
  sourceUrl: null
  originReplyId: string
}

/** 与 C 的 blockedBy / B 的 blocked-topics 完全同口径：NFKC + zh-CN 小写 + 子串。 */
export function materialKey(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('zh-CN')
}

const FILLER_ONLY =
  /^(?:嗯+|啊+|哦+|好+|好的+|收到|谢谢|感谢|哈哈+|嘿嘿+|行|ok|okay|是的|对|对的|知道了|没问题的?)[，。！？!～~、\s.]*$/iu
/** 句首称谓：只在后面还有正文时剥掉，避免把「好吧」这类语气词误当称谓。 */
const LEADING_ADDRESS = /^(?:它|你|亲|亲爱的|狗子|小朋友|宝|宝贝)[，,]\s*/u
/** 句首意图引导词：剥掉后仍保留实义内容。 */
const LEADING_INTENT = /^(?:好想|真想|我想|我想看|我想去|想看|想去|想要|想|希望|能不能|可以帮我|帮我|给我看看|给我)\s*/u
/** 句尾语气：只剥末尾一个，避免改动内部内容。 */
const TRAILING_TONE = /[，。！？!～~、\s.啊呢吧呀哦嘛]+$/u

/**
 * 从回应中确定性提取可搜索意图。规则：
 * - 纯照片回应（无文字）→ 不生成；纯情绪/称谓/寒暄 → 不生成；
 * - 剥称谓与意图引导词、去句尾语气后，必须命中某个兴趣类目的关键词才生成，
 *   归类失败不生成（不调 AI 猜、不凭空造搜索来源）；
 * - 只 trim 与词法规整，不做 Unicode 归一化合并；长度上限 200 字；
 * - 有照片但文字含可搜索意图时仍可生成（照片不进搜索词）。
 */
export function extractReplyMaterial(
  reply: Pick<Reply, 'text' | 'photoUrl' | 'id'>,
): ReplyMaterial | null {
  if (typeof reply.text !== 'string') return null
  const raw = reply.text.trim()
  if (raw.length === 0 || FILLER_ONLY.test(raw)) return null

  let intent = raw.replace(LEADING_ADDRESS, '').replace(LEADING_INTENT, '').replace(TRAILING_TONE, '')
  intent = intent.trim()
  if (intent.length === 0 || FILLER_ONLY.test(intent)) return null

  // 类目判定与 C 的 CATEGORY_KEYWORDS 同源，按 INTEREST_CATEGORIES 顺序取首个命中，结果稳定。
  const key = materialKey(intent)
  const category = INTEREST_CATEGORIES.find((candidate) =>
    CATEGORY_KEYWORDS[candidate].some((word) => key.includes(materialKey(word))),
  )
  if (!category) return null
  if ([...intent].length > 200) intent = [...intent].slice(0, 200).join('')
  if (intent.trim().length === 0) return null
  return { text: intent, category, fromReplyId: reply.id }
}

/** 屏蔽优先：命中主人已屏蔽主题时，这条回应材料不进入下次出行。 */
export function isMaterialBlocked(material: ReplyMaterial, blockedTopics: string[]): boolean {
  const key = materialKey(material.text)
  return blockedTopics.some((topic) => {
    const topicKey = materialKey(topic.trim())
    return topicKey.length > 0 && key.includes(topicKey)
  })
}

/**
 * 幂等键直接用 reply.id 派生 form：一次回应最多一条材料，重复写入撞主键。
 * 这样不需要在 wish 文本/来源里塞任何标记，不污染搜索词与 provenance。
 */
export function replyWishId(replyId: string): string {
  return `wish_reply_${replyId}`
}

/** 构造目标态 wish 草稿；originReplyId 与 source='reply' 要等 C 落地后才可写。 */
export function buildReplyWishDraft(
  material: ReplyMaterial,
  dogId: string,
  now: () => Date = () => new Date(),
): ReplyWishDraft {
  return {
    id: replyWishId(material.fromReplyId),
    dogId,
    text: material.text,
    category: material.category,
    createdAt: now().toISOString(),
    revokedAt: null,
    source: REPLY_WISH_SOURCE,
    sourceUrl: null,
    originReplyId: material.fromReplyId,
  }
}
