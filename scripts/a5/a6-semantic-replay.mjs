import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { reviewSemantics } from '../../lib/adoption/a6-semantics.ts'
import { selectForPersonality } from '../../lib/adoption/a6-selection.ts'
import { groundedShare } from '../../lib/adoption/a6-grounded-share.ts'

// Explicit cached real summaries and model responses. No network, identity or source proof.
export async function replaySemanticHoldout() {
  const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/a6/semantic-holdout.json'), 'utf8'))
  const candidates = fixture.records.map(entry => entry.candidate)
  const review = await reviewSemantics(candidates, async () => ({ items:
    fixture.records.map((entry, index) => ({ ...entry.recordedModel, index })) }))
  const counts = { total: candidates.length, directional: 0, agreesWithVisibleReview: 0, mixed: 0, unknown: 0 }
  for (const [index, decision] of review.decisions.entries()) {
    if (decision.focus === 'mixed') counts.mixed++
    else if (decision.focus === 'unknown') counts.unknown++
    else {
      counts.directional++
      if (decision.focus === fixture.records[index].expectedFocus) counts.agreesWithVisibleReview++
    }
  }
  const choices = ['看物', '看人'].map(tag => {
    const selection = selectForPersonality(candidates, { dogId: 'semantic-holdout-dog',
      tags: ['好奇', tag, '直给'], blockedTopics: [], semanticReview: review })
    const candidate = candidates[selection.selectedIndex]
    return { tag, selectedId: selection.selectedId, title: candidate.title,
      reasons: selection.decisions[selection.selectedIndex].reasons,
      safeShare: groundedShare(candidate, null).text }
  })
  assert.equal(counts.directional, 6)
  assert.equal(counts.agreesWithVisibleReview, 6)
  assert.notEqual(choices[0].selectedId, choices[1].selectedId)
  assert.equal(fixture.records.find(e => e.candidate.id === choices[0].selectedId).expectedFocus, 'object')
  assert.equal(fixture.records.find(e => e.candidate.id === choices[1].selectedId).expectedFocus, 'people')
  return { mode: 'offline-cache-replay', model: fixture.model, counts, choices,
    limits: ['Small targeted sample; assistant visible-summary labels, not independent human ground truth',
      'Evidence-window replay is reduced; full original response and live checks stay in local evidence',
      'No live search, automatic C6, OAuth, model call or browser in this replay'] }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/a6-semantic-replay.mjs')) {
  const report = await replaySemanticHoldout()
  const root = resolve('.local/a6-semantics')
  mkdirSync(root, { recursive: true })
  writeFileSync(resolve(root, 'holdout-replay.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
