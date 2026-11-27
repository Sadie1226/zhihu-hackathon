import test from 'node:test'
import assert from 'node:assert/strict'
import { createReadFailureFixture } from '../components/e7/journal-read-failure-fixture.ts'
import { isNewIncoming } from '../components/e7/journal-model.ts'
function row(id = 'unread') {
  return { id, fromDog: 'peer', toDog: 'dog', kind: 'greeting', payload: { kind: 'greeting', line: '雨停了', weather: '晴' }, deliveredAt: '2026-11-27T01:00:00Z', readAt: null, repliedAt: null }
}
test('failed save leaves unread state intact; retry writes once; reread keeps first timestamp', async () => {
  const item = row()
  const read = createReadFailureFixture([item], 0)
  const signal = new AbortController().signal
  await assert.rejects(read(item.id, signal), /第一次失败/)
  assert.equal(item.readAt, null)
  assert.equal(isNewIncoming({ direction: 'in', exchange: item }), true)
  const saved = await read(item.id, signal)
  assert(saved.exchange.readAt)
  assert.notEqual(saved.exchange, item)
  assert.equal(isNewIncoming({ direction: 'in', exchange: saved.exchange }), false)
  assert.equal((await read(item.id, signal)).exchange.readAt, saved.exchange.readAt)
})
test('failure budget is per letter; another unread letter stays unread', async () => {
  const first = row('first'), second = row('second')
  const read = createReadFailureFixture([first, second], 0)
  const signal = new AbortController().signal
  await assert.rejects(read('first', signal))
  await read('first', signal)
  await assert.rejects(read('second', signal), /第一次失败/)
  assert.equal(second.readAt, null)
})
test('aborted initial and retry requests never mark read or consume a fresh failure', async () => {
  const item = row()
  const read = createReadFailureFixture([item], 40)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(read(item.id, aborted.signal))
  const active = new AbortController()
  await assert.rejects(read(item.id, active.signal), /第一次失败/)
  const pending = read(item.id, active.signal)
  await Promise.resolve() // 进入重试等待后再取消，覆盖挂起期间的取消。
  active.abort()
  await assert.rejects(pending)
  assert.equal(item.readAt, null)
})
test('sealed and missing letters cannot be marked read, including retries', async () => {
  const item = { ...row(), deliveredAt: null }
  const read = createReadFailureFixture([item], 0)
  for (const id of [item.id, item.id, 'missing']) await assert.rejects(read(id, new AbortController().signal), /还没到/)
  assert.equal(item.readAt, null)
})
