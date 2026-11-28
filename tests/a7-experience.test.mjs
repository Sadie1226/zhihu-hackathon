import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectWithExperience } from '../lib/adoption/a7-experience.ts'

const candidate = (id, title) => ({ id, title, excerpt: null })
const context = { dogId: 'dog-a', tags: ['好奇', '看物', '直给'], blockedTopics: [] }
const history = entries => ({ dogId: 'dog-a', beforeSeq: 4, entries, fingerprint: 'verified-test-history' })
const trip = (seq, sourceId = 'old-' + seq) => ({ id: 'e-' + seq, tripId: 'trip-' + seq, seq,
  sourceId, title: '酵母发酵实验', excerpt: null, category: '手作与食物', kind: 'trip' })
const choose = (items, entries = [], overrides = {}) => selectWithExperience(items,
  { context: { ...context, ...overrides }, history: history(entries) })

test('same dog and same candidates: three verified distinct experiences change actual membership, retaining exploration', () => {
  const items = [candidate('a', '植物叶片观察'), candidate('b', '陶器拉坯工具'),
    candidate('c', '山川日落记录'), candidate('d', '酵母发酵过程'), candidate('e', '店主采访')]
  const initial = choose(items)
  const learned = choose(items, [trip(1), trip(2), trip(3)])
  assert.equal(initial.selectedIds.includes('d'), false)
  assert.ok(learned.selectedIds.includes('d'))
  // A small learned tilt cannot overturn the stronger existing personality evidence for a.
  assert.equal(learned.selectedIds[0], 'a')
  assert.notDeepEqual(learned.selectedIds, initial.selectedIds)
  assert.ok(learned.explorationId)
  assert.ok(learned.decisions.every(row => row.experienceAdjustment <= 0.45))
  assert.deepEqual(context.tags, ['好奇', '看物', '直给'])
})

test('same source repeated is not three pieces of growth; same trip has at most one contribution', () => {
  const items = [candidate('a', '植物观察'), candidate('b', '酵母发酵')]
  const duplicated = choose(items, [trip(3, 'same'), trip(2, 'same'), trip(1, 'same')])
  const single = choose(items, [trip(3, 'same')])
  assert.deepEqual(duplicated.decisions, single.decisions)
  const oneTrip = [trip(3, 'x'), { ...trip(3, 'y'), id: 'y' }]
  assert.equal(choose(items, oneTrip).decisions[1].evidenceIds.length, 1)
})

test('recent identical sources yield to alternatives; repeated facet cannot occupy all slots when another exists', () => {
  const items = [candidate('old-3', '酵母发酵'), candidate('new1', '酵种实验'), candidate('new2', '发酵温度'),
    candidate('new3', '酵母培养'), candidate('new4', '店主采访')]
  const result = choose(items, [trip(1), trip(2), trip(3)])
  assert.ok(!result.selectedIds.includes('old-3'))
  assert.ok(result.selectedIds.includes('new4'))
})

test('unknown mixed fiction and search category alone create no learned affinity', () => {
  const items = [candidate('a', '植物观察'), candidate('b', '酵母发酵')]
  for (const title of ['普通文章', '店主与酵母发酵', '酵母发酵童话', '不是发酵实验']) {
    const result = choose(items, [{ ...trip(3), title }])
    assert.deepEqual(result.decisions.map(row => row.experienceAdjustment), [0, 0])
  }
})

test('blocked material cannot win, invalid scope is rejected, ordering deterministic and history window fades', () => {
  const items = [candidate('a', '植物观察'), candidate('b', '酵母发酵')]
  const entries = [trip(1), trip(2), trip(3)]
  assert.deepEqual(choose(items, entries), choose(items, entries.slice().reverse()))
  assert.deepEqual(choose(items, entries, { blockedTopics: ['发酵'] }).selectedIds, ['a'])
  assert.throws(() => selectWithExperience(items, { context, history: { ...history(entries), dogId: 'other' } }))
  const expired = { ...history(entries), beforeSeq: 10 }
  assert.deepEqual(selectWithExperience(items, { context, history: expired }).decisions.map(row => row.experienceAdjustment), [0, 0])
  assert.equal(choose([], entries).selectedIds.length, 0)
})

test('no random growth: expression-only tags do not invent a learned preference', () => {
  const items = [candidate('a', '普通文章甲'), candidate('b', '普通文章乙')]
  assert.deepEqual(choose(items).selectedIds, choose(items, [], { tags: ['好奇', '看物', '婉转'] }).selectedIds)
})

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)
const multifacet = '酵母发酵与陶器植物观察'
const contribution = (entries, beforeSeq = 4) => selectWithExperience([candidate('new-source', multifacet + '新材料')],
  { context, history: { ...history(entries), beforeSeq } }).decisions[0]

test('one historical source spanning three facets contributes only one decayed unit', () => {
  const entry = { ...trip(3, 'verified-source'), title: multifacet }
  const result = contribution([entry])
  assert.equal(result.repeated, false)
  assert.deepEqual(result.evidenceIds, [entry.id])
  close(result.experienceAdjustment, 0.15 - 0.15)
  const stale = contribution([{ ...entry, seq: 1 }])
  close(stale.experienceAdjustment, 0.6 * 0.15)
  assert.deepEqual(stale.evidenceIds, [entry.id])
})

test('independent sources spanning facets contribute their actual units and evidence IDs', () => {
  const entries = [
    { ...trip(1, 'fermentation-source'), title: '酵母发酵实验' },
    { ...trip(2, 'making-source'), title: '陶器拉坯工具' },
    { ...trip(3, 'plants-source'), title: '植物叶片观察' },
  ]
  const result = contribution(entries)
  close(result.experienceAdjustment, (0.6 + 0.8 + 1) * 0.15 - 0.15)
  assert.deepEqual(new Set(result.evidenceIds), new Set(entries.map(entry => entry.id)))
})

test('different sources in one trip contribute once per direction, with cross-direction units retained', () => {
  const entries = [
    { ...trip(3, 'a'), title: '酵母发酵', id: 'a' },
    { ...trip(3, 'b'), title: '发酵温度', id: 'b' },
    { ...trip(3, 'c'), title: '陶器拉坯', id: 'c' },
  ]
  const result = contribution(entries)
  close(result.experienceAdjustment, 2 * 0.15 - 0.15)
  assert.deepEqual(result.evidenceIds, ['a', 'c'])
})

test('multi-facet duplicated sources never add units across trips, input order or recipient kind', () => {
  const entry = { ...trip(3, 'same-source'), title: multifacet }
  const duplicates = [entry, { ...entry, seq: 2, tripId: 'other-trip', id: 'exchange-copy', kind: 'exchange' }]
  assert.deepEqual(contribution(duplicates), contribution([entry]))
  assert.deepEqual(contribution(duplicates.slice().reverse()), contribution([entry]))
})

test('independent multi-facet evidence respects the total cap and each ID counts once', () => {
  const entries = Array.from({ length: 6 }, (_, index) => ({
    ...trip(index + 1), title: multifacet,
  }))
  const result = contribution(entries, 7)
  close(result.experienceAdjustment, 0.45 - 0.15)
  assert.equal(result.evidenceIds.length, 6)
  assert.equal(new Set(result.evidenceIds).size, 6)
})
