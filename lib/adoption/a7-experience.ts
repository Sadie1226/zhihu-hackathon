import { EXCLUSIVE_PAIRS } from '../../contracts/types.ts'
import { selectForPersonality } from './a6-selection.ts'
import type { SelectionCandidate, SelectionContext } from './a6-selection.ts'
import type { ExperienceHistory } from './a7-types.ts'

export const A7_POLICY_VERSION = 'a7-attention-v1'
export type ExperienceSelection = Readonly<{
  context: SelectionContext
  history: ExperienceHistory
}>

// Small literal observations, not a general subject classifier or evidence of liking.
// Ambiguous narrative/fiction and negated cues abstain; category alone never creates an affinity.
const facets = {
  fermentation: ['发酵', '酵母', '酵种'],
  making: ['陶器', '陶土', '拉坯', '木工', '榫卯', '编织'],
  plants: ['叶脉', '叶片', '植物', '银杏叶', '多肉'],
  animals: ['昆虫', '猫咪', '流浪猫', '流浪动物'],
  landscape: ['日落', '山川', '海岸', '雪景'],
  people: ['摊主', '店主', '采访', '居民', '人生'],
} as const
type Facet = keyof typeof facets

export function attentionFacets(candidate: SelectionCandidate): readonly Facet[] {
  const text = `${candidate.title}\n${candidate.excerpt ?? ''}`.normalize('NFKC')
  if (/小说|童话|虚构|故事|父亲|母亲|爷爷|奶奶/.test(text)) return []
  const found = (Object.entries(facets) as [Facet, readonly string[]][]).filter(([, cues]) => cues.some(cue => {
    const at = text.indexOf(cue)
    return at >= 0 && !/(没有|并非|不是|不含|不谈|不讲)[^，。！？；\n]{0,4}$/.test(text.slice(Math.max(0, at - 8), at))
  })).map(([facet]) => facet)
  // A mixed human/object account is not enough to strengthen either side.
  return found.includes('people') && found.length > 1 ? [] : found
}

/** Deterministic, bounded reranking AFTER source validation, BEFORE issuing proofs.
 * All history comes from a trusted reader. No writes, random growth, changed tags or public scores.
 */
export function selectWithExperience(candidates: readonly SelectionCandidate[], selection: ExperienceSelection,
  limit = 3) {
  const { context, history } = selection
  if (history.dogId !== context.dogId || !Number.isSafeInteger(history.beforeSeq) || history.beforeSeq < 1 ||
      !Number.isSafeInteger(limit) || limit < 1 || !history.fingerprint) throw new Error('Invalid A7 scope')
  const baseline = selectForPersonality(candidates, context)
  const sourceIds = new Set<string>()
  const weights = [1, 0.8, 0.6, 0.4, 0.2, 0.1]
  const support = new Map<Facet, Map<string, { weight: number; id: string }>>()
  const recent = new Set<string>()
  const recentTitles = new Set<string>()
  const titleKey = (title: string) => title.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]/gu, '')
  const recentFacets = new Set<Facet>()
  for (const entry of [...history.entries].sort((a, b) => b.seq - a.seq || a.id.localeCompare(b.id))) {
    const age = history.beforeSeq - entry.seq
    if (!Number.isSafeInteger(entry.seq) || age < 1 || age > weights.length || sourceIds.has(entry.sourceId)) continue
    sourceIds.add(entry.sourceId)
    if (age <= 2) { recent.add(entry.sourceId); recentTitles.add(titleKey(entry.title)) }
    const observed = attentionFacets({ id: entry.sourceId, title: entry.title, excerpt: entry.excerpt })
    for (const facet of observed) {
      const trips = support.get(facet) ?? new Map()
      // Multiple articles/exchanges from one recipient trip do not create extra growth.
      if (!trips.has(entry.tripId)) trips.set(entry.tripId, { weight: weights[age - 1], id: entry.id })
      support.set(facet, trips)
      if (age <= 2) recentFacets.add(facet)
    }
  }
  const [,,, attention] = EXCLUSIVE_PAIRS
  const decisions = baseline.decisions.map(base => {
    const candidate = candidates[base.index]
    const observed = attentionFacets(candidate)
    const aligned = observed.some(facet => context.tags.includes(attention[facet === 'people' ? 1 : 0]))
    const evidence = observed.flatMap(facet => [...support.get(facet)?.values() ?? []])
    const familiarity = Math.min(0.45, evidence.reduce((sum, item) => sum + item.weight * 0.15, 0))
    const repeated = recent.has(candidate.id) || recentTitles.has(titleKey(candidate.title))
    const repetition = observed.some(facet => recentFacets.has(facet)) ? 0.15 : 0
    return { ...base, facets: observed, baselineScore: base.score + (aligned ? 0.25 : 0),
      experienceAdjustment: familiarity - repetition, repeated,
      evidenceIds: [...new Set(evidence.map(item => item.id))],
      score: base.score + (aligned ? 0.25 : 0) + familiarity - repetition - (repeated ? 0.75 : 0) }
  })
  const eligible = decisions.filter(item => !item.blocked)
  const fresh = eligible.filter(item => !item.repeated)
  // Avoid recent identical URLs whenever there are enough alternatives; never invent a source.
  const pool = fresh.length >= Math.min(limit, eligible.length) ? fresh : eligible
  const sorted = [...pool].sort((a, b) => b.score - a.score || a.index - b.index)
  const chosen = sorted.slice(0, limit)
  let explorationId: string | null = null
  if (chosen.length > 1 && sorted.length > 1) {
    const preferred = chosen[0]
    const alternative = [...pool].filter(item => item.id !== preferred.id && !item.repeated &&
      !item.facets.some(facet => preferred.facets.includes(facet)))
      .sort((a, b) => b.baselineScore - a.baselineScore || a.index - b.index)[0]
    if (alternative) {
      explorationId = alternative.id
      if (!chosen.some(item => item.id === alternative.id)) chosen[chosen.length - 1] = alternative
    }
  }
  return { version: A7_POLICY_VERSION, historyFingerprint: history.fingerprint,
    selectedIds: chosen.map(item => item.id), explorationId, decisions }
}
