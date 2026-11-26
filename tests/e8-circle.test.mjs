import test from 'node:test'
import assert from 'node:assert/strict'
import { visiblePosts, circleSource, circleTime } from '../components/e8/circle-model.ts'
const dog = { actor: 'dog', id: 'dog_1', name: '青椒', isSample: true }
const post = (overrides = {}) => ({ id: 'p1', author: dog, text: '河边散步。', createdAt: '2026-11-25T08:00:00Z', sourceMode: 'fixture', interactions: [], ...overrides })
test('only dog-authored records and dog interactions reach the view', () => {
  const rows = visiblePosts([post({ author: { ...dog, actor: 'owner' } }), post({ interactions: [
    { dog: { ...dog, actor: 'owner' }, kind: 'comment', text: 'PRIVATE_OWNER_TEXT' },
    { dog, kind: 'like' }, { dog, kind: 'comment', text: '一起去看看。' },
  ] })])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].interactions.length, 2)
  assert(!JSON.stringify(rows).includes('PRIVATE_OWNER_TEXT'))
})
test('blocked topics filter before render, including comments, without exposing reasons', () => {
  const rows = visiblePosts([post({ id: 'blocked', text: '想去雪山。' }), post({ interactions: [{ dog, kind: 'comment', text: '雪山好看' }] })], ['雪山'])
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].interactions, [])
  assert(!JSON.stringify(rows).includes('雪山'))
})
test('invalid time and untrusted source mode are rejected, not converted to online content', () => {
  assert.deepEqual(visiblePosts([post({ createdAt: 'bad' }), post({ sourceMode: 'invented' })]), [])
  assert.equal(circleSource(null), '来源信息未提供')
  assert.equal(circleSource('fixture'), '示例动态')
  assert.equal(circleSource('cache'), '先前保存的动态')
})
test('feed sorts newest first, deduplicates ids and never forwards extra payload fields', () => {
  const rows = visiblePosts([post({ privateChat: 'SECRET' }), post(), post({ id: 'p2', createdAt: '2026-11-26T08:00:00Z' })])
  assert.deepEqual(rows.map(row => row.id), ['p2', 'p1'])
  assert(!JSON.stringify(rows).includes('SECRET'))
  assert(circleTime(rows[0].createdAt).includes('16:00'))
})
