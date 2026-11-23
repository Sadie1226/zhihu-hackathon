import type { SelectionCandidate } from './a6-selection.ts'

/** Safe handoff for B's future provider. Exact citation only; lexical quote coverage
 * cannot establish truth of a free paraphrase. No fake firsthand trip narrative. */
export function groundedShare(candidate: SelectionCandidate, generated: unknown): {
  text: string; acceptedModelText: boolean; fallback: 'citation-only' | null
} {
  const title = candidate.title.replace(/\s*-\s*知乎\s*$/, '').trim()
  if (!title || [...title].some(char => char.charCodeAt(0) < 32 || '《》'.includes(char))) throw new Error('Unsupported citation title')
  const text = `我读到《${title}》。`
  if ([...text].length > 120) throw new Error('Citation exceeds Message limit')
  const acceptedModelText = generated === text
  return { text, acceptedModelText, fallback: acceptedModelText ? null : 'citation-only' }
}
