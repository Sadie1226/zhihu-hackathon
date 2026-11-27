import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewSemantics, semanticFor, explicitFiction } from '../lib/adoption/a6-semantics.ts'
import { selectForPersonality } from '../lib/adoption/a6-selection.ts'

const item = (id, title, excerpt = null) => ({ id, title, excerpt })
const story = item('fixture:story', '银杏树下的故事', '公园里两位老人交换夹在书中的银杏叶，回忆年轻时的往事。')
const leaf = item('fixture:leaf', '银杏叶的颜色', '叶绿素分解后，叶片的黄色显现。')
const dog = tag => ({ dogId: 'fixture:dog', tags: ['好奇', tag, '直给'], blockedTopics: [] })
const response = (index, focus, quote, rest = {}) => ({ index, focus, focusQuote: quote,
  time: 'unknown', timeQuote: '', nature: 'unknown', natureQuote: '', ...rest })

test('main semantic subject overrides incidental words; mixed has no false preference', async () => {
  const candidates = [story, leaf]
  const review = await reviewSemantics(candidates, async () => ({ items: [
    response(0, 'people', '两位老人交换夹在书中的银杏叶'), response(1, 'object', '叶绿素分解后，叶片的黄色显现。'),
  ] }))
  assert.equal(selectForPersonality(candidates, { ...dog('看人'), semanticReview: review }).selectedId, story.id)
  assert.equal(selectForPersonality(candidates, { ...dog('看物'), semanticReview: review }).selectedId, leaf.id)
  const mixed = await reviewSemantics([story], async () => ({ items: [response(0, 'mixed', '两位老人交换夹在书中的银杏叶')] }))
  assert.equal(selectForPersonality([story], { ...dog('看物'), semanticReview: mixed }).decisions[0].score, 0)
})

test('transport failure, invalid JSON shape, missing and duplicate items all abstain', async () => {
  for (const provider of [async () => { throw new Error('private transport detail') },
    async () => null, async () => [], async () => ({ items: [] }),
    async () => ({ items: [response(0, 'people', story.excerpt), response(0, 'object', story.excerpt)] })]) {
    const review = await reviewSemantics([story], provider)
    assert.equal(review.decisions[0].focus, 'unknown')
    assert.equal(selectForPersonality([story], { ...dog('看物'), semanticReview: review }).decisions[0].score, 0)
  }
})

test('invented, tiny, invalid-enum and cross-source evidence cannot gain semantic weight', async () => {
  for (const row of [response(0, 'people', '这是不存在的引文'), response(0, 'people', '老人'),
    response(0, 'new-label', story.excerpt), response(0, 'people', leaf.excerpt)]) {
    const review = await reviewSemantics([story], async () => ({ items: [row] }))
    assert.equal(review.decisions[0].focus, 'unknown')
  }
})

test('stale content, clones and cross-source identities cannot reuse review capabilities', async () => {
  const review = await reviewSemantics([story], async () => ({ items: [response(0, 'people', story.excerpt)] }))
  assert.equal(semanticFor({ ...review }, story), undefined)
  assert.equal(semanticFor(review, { ...story, excerpt: '改变了内容' }), undefined)
  assert.equal(semanticFor(review, { ...story, id: 'other-source' }), undefined)
  assert.ok(Object.isFrozen(review.decisions[0]))
})

test('an event date is not nostalgia; explicit recollection is accepted', async () => {
  const visit = item('fixture:visit', '今天走访手工坊', '2月4日，调研团走进工坊。童年回忆里的旧物。')
  const run = quote => reviewSemantics([visit], async () => ({ items: [
    response(0, 'unknown', '', { time: 'memory', timeQuote: quote }),
  ] }))
  assert.equal((await run('2月4日，')).decisions[0].time, 'unknown')
  assert.equal((await run('童年回忆里的旧物')).decisions[0].time, 'memory')
})

test('explicit fiction overrides an erroneous model knowledge classification', async () => {
  const fiction = item('fixture:fiction', '童话：植物的聊天', '森林里，树和花开始交谈。')
  const review = await reviewSemantics([fiction], async () => ({ items: [response(0, 'object', fiction.excerpt,
    { nature: 'knowledge', natureQuote: fiction.excerpt })] }))
  assert.equal(review.decisions[0].nature, 'fiction')
  assert.equal(selectForPersonality([fiction], { ...dog('看物'), semanticReview: review }).decisions[0].nature, 'fiction')
  assert.equal(explicitFiction(item('fixture:account', '这不是小说，是一份非虚构访谈', '我读过一本小说，但这是访谈。')), false)
})

test('keyword-only fallback does not infer object from a narrative about leaves', () => {
  const decision = selectForPersonality([story], dog('看物')).decisions[0]
  assert.equal(decision.score, 0)
  const review = { version: 'a6-semantics-v1', decisions: [] }
  assert.equal(selectForPersonality([leaf], { ...dog('看物'), semanticReview: review }).decisions[0].score, 0)
})

test('semantic ranking cannot bypass blocked topics', async () => {
  const review = await reviewSemantics([story, leaf], async () => ({ items: [response(0, 'people', story.excerpt)] }))
  assert.equal(selectForPersonality([story, leaf], { ...dog('看人'), blockedTopics: ['老人'], semanticReview: review }).selectedId, leaf.id)
})

