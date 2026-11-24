import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDraftSave } from '../lib/adoption/draft-save.ts'

function setup(write) {
  const timers = new Map()
  const writes = []
  let id = 0
  const save = createDraftSave(write ?? ((scope, value) => writes.push({ scope, value })), {
    schedule(run) { timers.set(++id, run); return id },
    cancel(timer) { timers.delete(timer) },
  })
  const runTimers = () => {
    for (const [key, run] of [...timers]) {
      timers.delete(key)
      run()
    }
  }
  return { save, writes, timers, runTimers }
}

test('rapid slider input does no synchronous writes, then stores the latest value once', () => {
  const { save, writes, timers, runTimers } = setup()
  save.setScope('owner-a')
  for (let value = 0; value <= 100; value += 5) save.save({ value }, true)
  assert.deepEqual(writes, [])
  assert.equal(timers.size, 1)
  runTimers()
  assert.deepEqual(writes, [{ scope: 'owner-a', value: { value: 100 } }])
})

test('release, cancel, blur or leaving the page can flush the latest input without a second write', () => {
  const { save, writes, runTimers } = setup()
  save.setScope('owner-a')
  save.save({ value: 30 }, true)
  save.save({ value: 75 }, true)
  save.flush()
  save.flush()
  runTimers()
  assert.deepEqual(writes, [{ scope: 'owner-a', value: { value: 75 } }])
})

test('ordinary immediate save supersedes pending slider data and preserves a new creation request ID', () => {
  const { save, writes, runTimers } = setup()
  save.setScope('owner-a')
  save.save({ value: 75, requestId: null }, true)
  save.save({ value: 75, requestId: 'creation-intent-1' })
  runTimers()
  assert.deepEqual(writes, [{ scope: 'owner-a', value: { value: 75, requestId: 'creation-intent-1' } }])
})

test('changing or clearing identity discards pending old-owner input', () => {
  const { save, writes, runTimers } = setup()
  save.setScope('owner-a')
  save.save({ privateDraft: 'a' }, true)
  save.setScope('owner-b')
  runTimers()
  save.flush()
  assert.deepEqual(writes, [])
  save.save({ privateDraft: 'b' }, true)
  save.setScope(null)
  runTimers()
  save.save({ privateDraft: 'anonymous' })
  assert.deepEqual(writes, [])
  save.setScope('owner-b')
  save.save({ privateDraft: 'fresh b' }, true)
  save.flush()
  assert.deepEqual(writes, [{ scope: 'owner-b', value: { privateDraft: 'fresh b' } }])
})

test('same identity retains pending work; explicit clear cancels it', () => {
  const { save, writes, runTimers } = setup()
  save.setScope('owner-a')
  save.save({ value: 10 }, true)
  save.setScope('owner-a')
  runTimers()
  assert.equal(writes.length, 1)
  save.save({ value: 90 }, true)
  save.clear()
  runTimers()
  assert.equal(writes.length, 1)
})

test('unavailable storage does not throw or prevent a later successful save', () => {
  const writes = []
  let unavailable = true
  const { save, runTimers } = setup((scope, value) => {
    if (unavailable) throw new Error('QuotaExceededError')
    writes.push({ scope, value })
  })
  save.setScope('owner-a')
  save.save({ value: 25 }, true)
  assert.doesNotThrow(runTimers)
  assert.doesNotThrow(() => save.save({ value: 50 }))
  unavailable = false
  save.save({ value: 100 }, true)
  save.flush()
  assert.deepEqual(writes, [{ scope: 'owner-a', value: { value: 100 } }])
})
