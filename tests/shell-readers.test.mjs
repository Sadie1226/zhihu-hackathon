import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFinds, readMessage, orderFinds, internalReturnTo } from '../components/app-shell/content-reader.ts'

test('return links remain in the known app routes and reject external/control targets', () => {
  for (const value of ['https://example.test', '//example.test', '/mailbox\\evil', '/trip\n', '/unknown'])
    assert.equal(internalReturnTo(value), '/home')
  assert.equal(internalReturnTo('/journal?record=123#entry'), '/journal?record=123#entry')
})

test('representative find is shown once without changing the remaining source order', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'c' }]
  assert.deepEqual(orderFinds(rows, 'c').map(row => row.id), ['c', 'a', 'b'])
  assert.deepEqual(orderFinds(rows, 'missing').map(row => row.id), ['a', 'b', 'c'])
  assert.deepEqual(rows.map(row => row.id), ['a', 'b', 'a', 'c'])
})

test('find reader is an abortable private GET, preserves fixture and rejects another trip', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const controller = new AbortController()
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/trips/trip%2F1/finds')
    assert.equal(options.method, 'GET')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.signal, controller.signal)
    return Response.json({ finds: [{ id: 'a', tripId: 'trip/1', sourceMode: 'fixture' }] })
  }
  assert.equal((await readFinds('trip/1', controller.signal))[0].sourceMode, 'fixture')
  globalThis.fetch = async () => Response.json({ finds: [{ tripId: 'other' }] })
  await assert.rejects(readFinds('trip/1', controller.signal))
  for (const status of [404, 503]) {
    globalThis.fetch = async () => new Response('{}', { status })
    await assert.rejects(readFinds('trip/1', controller.signal), error => error.status === status)
  }
})

test('message reader preserves true null, keeps failures separate, and rejects a foreign-trip DTO', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const controller = new AbortController()
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/trips/trip%2F1/message')
    assert.equal(options.method, 'GET')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.signal, controller.signal)
    return Response.json({ message: null })
  }
  assert.equal(await readMessage('trip/1', controller.signal), null)
  const message = { id: 'message-1', tripId: 'trip/1', text: 'fixture', mentionsFindId: null, createdAt: '2026-11-21T00:00:00Z' }
  globalThis.fetch = async () => Response.json({ message })
  assert.deepEqual(await readMessage('trip/1', controller.signal), message)
  for (const value of [{}, { message: { ...message, tripId: 'other' } }]) {
    globalThis.fetch = async () => Response.json(value)
    await assert.rejects(readMessage('trip/1', controller.signal), error => error.status === 503)
  }
  for (const status of [404, 503]) {
    globalThis.fetch = async () => new Response('{}', { status })
    await assert.rejects(readMessage('trip/1', controller.signal), error => error.status === status)
  }
})
