import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchForTrip, verifiedSearchInput } from '../lib/trips/search-proof.ts'

const items = [
  { title: '银杏叶与叶脉', excerpt: null, sourceUrl: 'https://www.zhihu.com/question/123/answer/456', sourceMode: 'live', authorityLevel: null, voteUpCount: null },
  { title: '树下摊主故事', excerpt: '采访居民', sourceUrl: 'https://www.zhihu.com/question/123/answer/457', sourceMode: 'live', authorityLevel: null, voteUpCount: null },
]
const provider = values => async () => ({ ok: true, httpStatus: 200, fetchedAt: '2026-11-23T00:00:00Z', items: values })
const context = { tripId: 'fixture-trip', sessionId: 'fixture-session', query: '秋天', category: '自然风景', blockedTopics: [],
  selection: { dogId: 'fixture-dog', tags: ['好奇', '看人', '直给'], blockedTopics: [] } }

test('opt-in A6 picks a validated source and preserves the existing opaque proof boundary', async () => {
  const result = await searchForTrip(context, provider(items))
  assert.equal(result.ok, true)
  const selected = verifiedSearchInput(result.proof, context.sessionId, [])
  assert.equal(selected.sourceUrl, items[1].sourceUrl)
  assert.equal(selected.sourceMode, 'live') // synthetic protocol assertion, not network evidence
  assert.throws(() => verifiedSearchInput({ ...result.proof }, context.sessionId, []), { code: 'CONFLICT' })
  assert.throws(() => verifiedSearchInput(result.proof, 'other-session', []), { code: 'CONFLICT' })
  assert.throws(() => verifiedSearchInput(result.proof, context.sessionId, ['居民']), { code: 'CONFLICT' })
})

test('without opt-in legacy selection stays first; server blocklist overrides selector input', async () => {
  const { selection, ...legacy } = context
  const first = await searchForTrip(legacy, provider(items))
  assert.equal(verifiedSearchInput(first.proof, context.sessionId, []).sourceUrl, items[0].sourceUrl)
  const blocked = await searchForTrip({ ...context, blockedTopics: ['摊主'] }, provider(items))
  assert.equal(verifiedSearchInput(blocked.proof, context.sessionId, []).sourceUrl, items[0].sourceUrl)
  assert.equal(selection.blockedTopics.length, 0)
})

test('selection cannot hide malformed unselected sources or conflicting duplicate metadata', async () => {
  for (const values of [[...items, { ...items[0], sourceUrl: 'http://invalid.example' }],
    [...items, { ...items[1], excerpt: 'conflicting metadata' }]]) {
    const result = await searchForTrip(context, provider(values))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'NETWORK')
    assert.ok(!('proof' in result))
  }
  const deduped = await searchForTrip(context, provider([...items, items[1]]))
  assert.equal(deduped.ok, true)
})

test('all blocked produces no proof or invented candidate', async () => {
  const result = await searchForTrip({ ...context, blockedTopics: ['银杏', '摊主'] }, provider(items))
  assert.equal(result.ok, true)
  assert.equal(result.proof, null)
})
