import { EXCLUSIVE_PAIRS, checkPersonalityTags } from '../../contracts/types.ts'
import type { PersonalityTag } from '../../contracts/types.ts'

export const A6_POLICY_VERSION = 'a6-selection-v1'

/** Server-only input after source/topic validation. id is a stable source identity,
 * not a client-supplied Find ID. This module cannot certify a source or write a Find. */
export type SelectionCandidate = Readonly<{ id: string; title: string; excerpt: string | null }>
export type SelectionContext = Readonly<{
  dogId: string
  tags: readonly PersonalityTag[]
  blockedTopics: readonly string[]
  /** Only this dog's prior trips, loaded by the trusted caller. Absence means unknown. */
  history?: Readonly<{ dogId: string; sourceIds: readonly string[] }>
}>
export type SelectionReason = Readonly<{
  tag: PersonalityTag
  basis: 'text-cue' | 'seen-source' | 'unseen-source'
  cues: readonly string[]
}>
export type SelectionDecision = Readonly<{
  index: number
  id: string
  blocked: boolean
  score: number
  reasons: readonly SelectionReason[]
}>
export type SelectionResult = Readonly<{
  version: typeof A6_POLICY_VERSION
  selectedIndex: number | null
  selectedId: string | null
  decisions: readonly SelectionDecision[]
}>

const [exploration, , , attention, , time] = EXCLUSIVE_PAIRS
// Deliberately narrow lexical evidence, not inferred geography, dates or a full-text classifier.
// Both sides may match. Repetition and the length of a title never add extra weight.
const objectCues = ['银杏叶', '树叶', '叶片', '叶脉', '纹理', '植物', '昆虫', '石头', '器物', '物件']
const peopleCues = ['摊主', '店主', '居民', '路人', '邻居', '人物', '人生', '讲述', '采访']
const presentCues = ['今天', '此刻', '眼前', '现在', '日常']
const memoryCues = ['童年', '儿时', '旧物', '往事', '回忆', '当年', '老照片']

function normalize(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('zh-CN')
}

function matches(text: string, cues: readonly string[]): string[] {
  return cues.filter(cue => {
    let offset = 0
    while (offset < text.length) {
      const at = text.indexOf(cue, offset)
      if (at < 0) return false
      // A small explicit negation guard; ambiguous language remains a documented limitation.
      if (!/(没有|并非|不是|不含|不谈|不讲)[^，。！？；\n]{0,4}$/.test(text.slice(Math.max(0, at - 8), at))) return true
      offset = at + cue.length
    }
    return false
  })
}

/** Pure, deterministic preference over the caller's eligible candidates.
 * Topic, ownership, provenance, caching and persistence remain the C6 caller's responsibility.
 * Scores/reasons are review evidence, never product metrics or owner chat snapshots. */
export function selectForPersonality(
  candidates: readonly SelectionCandidate[], context: SelectionContext,
): SelectionResult {
  if (!context.dogId.trim() || !checkPersonalityTags([...context.tags]).ok) {
    throw new Error('Invalid A6 dog context')
  }
  if (context.history && context.history.dogId !== context.dogId) throw new Error('A6 history belongs to another dog')
  if (context.blockedTopics.some(topic => typeof topic !== 'string') ||
      context.history?.sourceIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Invalid A6 context')
  const ids = new Set<string>()
  for (const candidate of candidates) {
    if (typeof candidate.id !== 'string' || !candidate.id.trim() || ids.has(candidate.id) ||
        typeof candidate.title !== 'string' || !candidate.title.trim() ||
        !(candidate.excerpt === null || typeof candidate.excerpt === 'string')) throw new Error('Invalid A6 candidate')
    ids.add(candidate.id)
  }
  const tags = new Set(context.tags)
  const history = new Set(context.history?.sourceIds ?? [])
  const decisions = candidates.map((candidate, index): SelectionDecision => {
    const blocked = context.blockedTopics.some(topic => topic.trim() &&
      [candidate.title, candidate.excerpt ?? ''].some(text => normalize(text).includes(normalize(topic.trim()))))
    const reasons: SelectionReason[] = []
    if (!blocked) {
      const text = normalize(`${candidate.title}\n${candidate.excerpt ?? ''}`)
      const add = (tag: PersonalityTag, cues: readonly string[]) => {
        if (!tags.has(tag)) return
        const found = matches(text, cues)
        if (found.length) reasons.push({ tag, basis: 'text-cue', cues: found })
      }
      add(attention[0], objectCues)
      add(attention[1], peopleCues)
      add(time[0], presentCues)
      add(time[1], memoryCues)
      // With no previous source identities, neither pole gets an invented familiarity score.
      if (history.size) {
        const seen = history.has(candidate.id)
        const tag = exploration[seen ? 1 : 0]
        if (tags.has(tag)) reasons.push({ tag, basis: seen ? 'seen-source' : 'unseen-source', cues: [] })
      }
    }
    return { index, id: candidate.id, blocked, score: reasons.length, reasons }
  })
  let selected: SelectionDecision | undefined
  for (const decision of decisions) {
    if (!decision.blocked && (!selected || decision.score > selected.score)) selected = decision
  }
  return { version: A6_POLICY_VERSION, selectedIndex: selected?.index ?? null,
    selectedId: selected?.id ?? null, decisions }
}
