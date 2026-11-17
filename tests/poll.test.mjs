import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pollTrip, TRIP_POLL_INTERVAL_MS } from '../lib/trips/poll.ts'

// Promise jobs only; no real timers or waiting periods in polling tests.
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve() }
function harness(statuses) {
  const timers = new Map(), seen = [], errors = [], requests = []
  let next = 0
  const options = {
    onTrip: trip => seen.push(trip.status), onError: error => errors.push(error),
    setTimeout: (fn, ms) => { assert.equal(ms, 700); timers.set(++next, fn); return next },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, init) => {
      requests.push({ url, init })
      return { ok: true, json: async () => ({ trip: { id: 'trip/a', status: statuses.shift() } }) }
    },
  }
  async function advance() {
    const entry = timers.entries().next().value
    assert.ok(entry)
    timers.delete(entry[0]); entry[1](); await flush()
  }
  return { options, timers, seen, errors, requests, advance }
}
for (const status of ['done', 'failed', 'timeout']) {
  test(`700ms polling stops at ${status}`, async () => {
    const h = harness(['pending', 'running', status])
    assert.equal(TRIP_POLL_INTERVAL_MS, 700)
    pollTrip('trip/a', h.options); await flush()
    await h.advance(); await h.advance()
    assert.deepEqual(h.seen, ['pending', 'running', status]); assert.equal(h.timers.size, 0)
    assert.equal(h.requests.length, 3); assert.deepEqual(h.errors, [])
    assert.equal(h.requests[0].url, '/api/trips/trip%2Fa')
    assert.equal(h.requests[0].init.cache, 'no-store')
  })
}
test('cancel clears scheduled poll; abort cancels in-flight fetch and ignores late response', async () => {
  const h = harness(['running'])
  const stop = pollTrip('trip/a', h.options); await flush(); stop(); stop()
  assert.equal(h.timers.size, 0); assert.equal(h.requests[0].init.signal.aborted, true)
  let resolveFetch, signal
  const controller = new AbortController()
  const late = harness([])
  pollTrip('trip/a', { ...late.options, signal: controller.signal,
    fetch: (_url, init) => { signal = init.signal; return new Promise(resolve => { resolveFetch = resolve }) } })
  controller.abort()
  assert.equal(signal.aborted, true)
  resolveFetch({ ok: true, json: async () => ({ trip: { id: 'trip/a', status: 'running' } }) })
  await flush()
  assert.deepEqual(late.seen, []); assert.deepEqual(late.errors, []); assert.equal(late.timers.size, 0)
  const aborted = harness([])
  pollTrip('trip/a', { ...aborted.options, signal: controller.signal }); await flush()
  assert.equal(aborted.requests.length, 0)
})
for (const failure of ['http', 'network', 'malformed']) {
  test(`${failure} failure stops polling and reports once`, async () => {
    const h = harness([])
    pollTrip('trip/a', { ...h.options, fetch: async () => {
      if (failure === 'network') throw new Error('offline')
      if (failure === 'http') return { ok: false, status: 404 }
      return { ok: true, json: async () => ({ trip: { id: 'other', status: 'running' } }) }
    } })
    await flush()
    assert.equal(h.errors.length, 1); assert.equal(h.timers.size, 0); assert.deepEqual(h.seen, [])
  })
}
