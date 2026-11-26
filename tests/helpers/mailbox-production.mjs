// Run after npm run build. The server only uses a temporary fixture database.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../lib/db/bootstrap.ts'
import { migrations } from '../../lib/db/migrations.ts'
import { readDepartureSnapshot } from '../../lib/trips/departure-snapshot.ts'
import { insertDog, insertExchange, mailboxDatabase, ownedDog, seedMailbox } from './mailbox-fixtures.mjs'

async function freePort() {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}

async function productionServer(path) {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1',
    '--port', String(port)], {
    windowsHide: true, stdio: 'ignore', env: {
      ...process.env, NODE_ENV: 'production', DATABASE_PATH: path, ZHIHU_ACCESS_SECRET: '',
    },
  })
  const exit = once(child, 'exit')
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exit
  }
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Production server exited before ready')
      try {
        if ((await globalThis.fetch(base, { signal: globalThis.AbortSignal.timeout(1000) })).ok) return { base, stop }
      } catch { /* Poll briefly while Next starts listening. */ }
      await setTimeout(100)
    }
    throw new Error('Production server readiness timed out')
  } catch (error) {
    await stop()
    throw error
  }
}

async function request(base, route, status, { cookie, method = 'GET', origin = base } = {}) {
  const headers = cookie ? { cookie } : {}
  const options = { method, headers, signal: globalThis.AbortSignal.timeout(5000) }
  if (method !== 'GET') {
    headers['content-type'] = 'application/json'
    if (origin !== null) headers.origin = origin
    options.body = route.endsWith('/trips') ? '{"trigger":"auto"}' : '{}'
  }
  const response = await globalThis.fetch(base + route, options)
  assert.equal(response.status, status, route)
  if (status === 405) return null
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('vary') ?? '', /(?:^|,\s*)Cookie(?:,|$)/i)
  assert.equal(response.headers.get('set-cookie'), null)
  return response.json()
}

test('production HTTP routes, ownership, explicit read, C4 start, restart and failed database', { timeout: 45000 }, async t => {
  const { db, path } = mailboxDatabase(t)
  const { owner, other, empty } = seedMailbox(db, true)
  insertDog(db, 'dog_seed_07', 'fixture-internal-seed-session', 1)
  db.close()
  let server = await productionServer(path)
  const inbox = '/api/dogs/dog_owner/inbox'
  const outbox = '/api/exchanges?from_dog=dog_owner'
  const read = '/api/exchanges/ex_message/read'
  const get = (route, status = 200, cookie = owner.cookie) => request(server.base, route, status, { cookie })
  const mutate = (route, method, status, cookie = owner.cookie, origin) =>
    request(server.base, route, status, { cookie, method, origin })
  try {
    const initial = await get(inbox + '?filter=arrived')
    assert.deepEqual(initial.exchanges.map(row => row.id), ['ex_read', 'ex_message', 'ex_legacy', 'ex_find'])
    assert.equal(initial.exchanges.find(row => row.id === 'ex_message').readAt, null)
    assert.deepEqual((await get(outbox)).exchanges.map(row => row.id), ['ex_sent_z', 'ex_sent_a', 'ex_sent_old'])
    assert.deepEqual(await get('/api/dogs/dog%20empty/inbox', 200, empty.cookie), { exchanges: [] })
    for (const route of [inbox, outbox]) {
      assert.equal((await get(route, 404, null)).code, 'NOT_FOUND')
      assert.equal((await get(route, 404, other.cookie)).code, 'NOT_FOUND')
    }
    assert.equal((await get(inbox + '?filter=arrived&filter=all', 409)).code, 'CONFLICT')
    assert.equal((await get('/api/exchanges?to_dog=dog_owner', 409)).code, 'CONFLICT')
    assert.equal((await mutate(read, 'PATCH', 404, other.cookie)).code, 'NOT_FOUND')
    assert.equal((await mutate(read, 'PATCH', 404, null)).code, 'NOT_FOUND')
    assert.equal((await mutate(read, 'PATCH', 409, owner.cookie, 'https://other.example')).code, 'CONFLICT')
    assert.equal((await mutate('/api/exchanges/ex_greeting/read', 'PATCH', 409)).code, 'CONFLICT')
    assert.deepEqual(await get(inbox + '?filter=arrived'), initial)
    const [first, retry] = await Promise.all([mutate(read, 'PATCH', 200), mutate(read, 'PATCH', 200)])
    assert.deepEqual(first, retry)
    const existing = initial.exchanges.find(row => row.id === first.exchange.id)
    assert.ok(Number.isFinite(Date.parse(first.exchange.readAt)))
    assert.deepEqual(first.exchange, { ...existing, readAt: first.exchange.readAt })
    await mutate('/api/exchanges', 'POST', 405)
    // Drive the existing C4 contract from this server-side client.
    const tripRequest = (route, status, cookie) => mutate(route, 'POST', status, cookie, null)
    assert.equal((await tripRequest('/api/dogs/dog_seed_07/trips', 404, owner.cookie)).code, 'NOT_FOUND')

    // The existing trip routes are the only cause of delivery for this due row.
    const writer = openDatabase(path)
    try { insertExchange(writer, 'ex_due', other.id, empty.id, 1) }
    finally { writer.close() }
    const emptyInbox = '/api/dogs/dog%20empty/inbox'
    assert.deepEqual((await get(emptyInbox + '?filter=onTheWay', 200, empty.cookie)).exchanges.map(row => row.id), ['ex_due'])
    const { trip } = await tripRequest('/api/dogs/dog%20empty/trips', 200, empty.cookie)
    assert.equal(trip.status, 'pending')
    assert.deepEqual(await get(emptyInbox + '?filter=arrived', 200, empty.cookie), { exchanges: [] })
    const result = await tripRequest(`/api/trips/${trip.id}/start`, 200, empty.cookie)
    assert.deepEqual(result.delivered.map(row => row.id), ['ex_due'])
    assert.equal(result.delivered[0].deliveredAt, result.trip.startedAt)
    assert.deepEqual((await tripRequest(`/api/trips/${trip.id}/start`, 200, empty.cookie)).delivered, [])
    assert.deepEqual(await get(emptyInbox + '?filter=arrived', 200, empty.cookie), { exchanges: result.delivered })

    await server.stop()
    server = await productionServer(path)
    assert.deepEqual(await mutate(read, 'PATCH', 200), first)
    assert.deepEqual(await get(emptyInbox + '?filter=arrived', 200, empty.cookie), { exchanges: result.delivered })
    await server.stop()
    server = await productionServer(join(path, 'unavailable.sqlite'))
    assert.equal((await get(inbox, 503)).code, 'NETWORK')
    assert.equal((await get(outbox, 503)).code, 'NETWORK')
    console.log('PASS production HTTP: 200/404/409/405/503, no-store/Cookie, C4 delivery, idempotent read and restart')
  } finally {
    await server.stop()
  }
})

test('production HTTP upgrades v6 and binds the departure snapshot on the first start', { timeout: 45000 }, async t => {
  const { db, path } = mailboxDatabase(t, migrations.filter(migration => migration.version <= 6))
  const owner = ownedDog(db, 'g3-production-owner', true)
  const sender = ownedDog(db, 'g3-production-sender', true)
  insertExchange(db, 'g3-production-gift', sender.id, owner.id, 1)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6)
  db.close()
  const server = await productionServer(path)
  try {
    const post = route => request(server.base, route, 200, { cookie: owner.cookie, method: 'POST' })
    const { trip } = await post(`/api/dogs/${owner.id}/trips`)
    const startRoute = `/api/trips/${trip.id}/start`
    const started = await post(startRoute)
    assert.equal(started.trip.status, 'running')
    assert.deepEqual(started.delivered.map(row => row.id), ['g3-production-gift'])
    assert.deepEqual(await post(startRoute), { trip: started.trip, delivered: [] })
    const reader = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(reader.prepare('PRAGMA user_version').get().user_version, 9)
      assert.deepEqual(readDepartureSnapshot(reader, trip.id, owner.id), {
        dogId: owner.id, version: 1, createdAt: started.trip.startedAt,
        personalityTags: ['好奇', '看物', '直给'], interestCategories: null, recentTrips: [], waitingFor: null,
      })
      assert.equal(reader.prepare('SELECT count(*) AS n FROM snapshot WHERE dog_id = ?').get(owner.id).n, 1)
      assert.deepEqual(reader.prepare('PRAGMA foreign_key_check').all(), [])
    } finally { reader.close() }
  } finally { await server.stop() }
})
