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
