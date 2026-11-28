import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXCLUSIVE_PAIRS } from '../contracts/types.ts'
import { selectForPersonality } from '../lib/adoption/a6-selection.ts'

const [exploration, social, density, attention, expression, time] = EXCLUSIVE_PAIRS
const candidate = (id, title, excerpt = null) => ({ id, title, excerpt })
const leaves = candidate('fixture:leaves', '秋天：银杏叶为什么变黄', '观察叶脉与纹理')
const vendor = candidate('fixture:vendor', '秋天：树下摊主的故事', '采访一位居民')
const context = (tag = attention[0], extra = {}) => ({ dogId: 'fixture:dog',
  tags: [exploration[0], tag, expression[0]], blockedTopics: [], ...extra })

test('same candidates and two unchanged tags: attention changes actual selected identity', () => {
  const candidates = Object.freeze([Object.freeze(leaves), Object.freeze(vendor)])
  const before = JSON.stringify(candidates)
  const objects = selectForPersonality(candidates, context(attention[0]))
  const people = selectForPersonality(candidates, context(attention[1]))
  assert.equal(objects.selectedId, leaves.id)
  assert.equal(people.selectedId, vendor.id)
  assert.equal(people.selectedIndex, 1)
  assert.deepEqual(people.decisions[1].reasons[0], { tag: attention[1], basis: 'text-cue', cues: ['摊主', '居民', '采访'] })
  assert.equal(JSON.stringify(candidates), before)
  assert.deepEqual(selectForPersonality(candidates, context(attention[1])), people)
})

test('time preference follows visible content, without invented publication dates', () => {
  const candidates = [candidate('fixture:now', '街巷的日常，今天看见的事'), candidate('fixture:past', '童年街巷的老照片')]
  const c = tag => context(attention[0], { tags: [tag, attention[0], expression[0]] })
  assert.equal(selectForPersonality(candidates, c(time[0])).selectedIndex, 0)
  assert.equal(selectForPersonality(candidates, c(time[1])).selectedIndex, 1)
})

test('exploration needs own historical source evidence and does not infer geographic distance', () => {
  const candidates = [candidate('fixture:old', '同主题材料甲'), candidate('fixture:new', '同主题材料乙')]
  const c = tag => context(attention[0], { tags: [tag, attention[0], expression[0]],
    history: { dogId: 'fixture:dog', sourceIds: ['fixture:old'] } })
  assert.equal(selectForPersonality(candidates, c(exploration[0])).selectedIndex, 1)
  assert.equal(selectForPersonality(candidates, c(exploration[1])).selectedIndex, 0)
  for (const history of [undefined, { dogId: 'fixture:dog', sourceIds: [] }]) {
    const result = selectForPersonality(candidates, { ...c(exploration[0]), history })
    assert.equal(result.selectedIndex, 0)
    assert.ok(result.decisions.every(d => d.reasons.length === 0))
  }
  assert.throws(() => selectForPersonality(candidates, { ...c(exploration[0]),
    history: { dogId: 'another-dog', sourceIds: ['fixture:old'] } }), /another dog/)
})

test('blocked preference cannot beat allowed candidates, including normalized excerpt matches', () => {
  const result = selectForPersonality([leaves, { ...vendor, excerpt: 'ＡＢＣ' }],
    context(attention[1], { blockedTopics: ['abc'] }))
  assert.equal(result.selectedId, leaves.id)
  assert.equal(result.decisions[1].blocked, true)
  assert.equal(result.decisions[1].score, 0)
  assert.deepEqual(result.decisions[1].reasons, [])
  assert.equal(selectForPersonality([vendor], context(attention[1], { blockedTopics: ['摊主'] })).selectedId, null)
})

test('empty, sole and unknown candidates never fabricate different content', () => {
  assert.equal(selectForPersonality([], context()).selectedId, null)
  assert.equal(selectForPersonality([leaves], context(attention[1])).selectedId, leaves.id)
  const unknown = [candidate('fixture:a', '材料甲'), candidate('fixture:b', '材料乙')]
  for (const tag of attention) assert.equal(selectForPersonality(unknown, context(tag)).selectedIndex, 0)
})

test('expression-only changes do not fake selection differences', () => {
  const candidates = [leaves, vendor]
  for (const pair of [social, density, expression]) {
    const results = pair.map(tag => selectForPersonality(candidates, context(attention[0],
      { tags: [tag, attention[0], exploration[0]] })))
    assert.equal(results[0].selectedId, results[1].selectedId)
  }
})

test('repeated cues do not outweigh another dimension; ties preserve input order', () => {
  const candidates = [candidate('fixture:memory', '旧物与童年'),
    candidate('fixture:many', '叶片叶片叶片纹理纹理')]
  const result = selectForPersonality(candidates, context(attention[0],
    { tags: [attention[0], time[1], expression[0]] }))
  assert.deepEqual(result.decisions.map(d => d.score), [1, 1])
  assert.equal(result.selectedIndex, 0)
})

test('explicit negation and empty excerpts do not create positive attention evidence', () => {
  const result = selectForPersonality([candidate('fixture:no', '不谈人物，不讲采访'), vendor], context(attention[1]))
  assert.equal(result.decisions[0].score, 0)
  assert.equal(result.selectedIndex, 1)
})

test('invalid tags and ambiguous source identities fail instead of selecting silently', () => {
  for (const tags of [[attention[0], attention[1], expression[0]], [attention[0]], ['温柔', exploration[0], expression[0]]]) {
    assert.throws(() => selectForPersonality([leaves], { ...context(), tags }), /Invalid A6/)
  }
  for (const candidates of [[leaves, leaves], [candidate('', '材料')], [candidate('fixture:a', '')]]) {
    assert.throws(() => selectForPersonality(candidates, context()), /Invalid A6/)
  }
})

test('selection returns identity and evidence only, never a live proof, Find or generated fact', () => {
  const result = selectForPersonality([leaves, vendor], context())
  assert.deepEqual(Object.keys(result).sort(), ['decisions', 'selectedId', 'selectedIndex', 'version'])
  assert.ok(!JSON.stringify(result).includes('verifiedSearch'))
  assert.ok(!JSON.stringify(result).includes('sourceMode'))
})
