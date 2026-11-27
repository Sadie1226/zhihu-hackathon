import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { resolveAuthContext } from '../lib/auth/session.ts'
import { createTripScheduler, createTravelDial } from '../lib/trips/scheduler.ts'
import { createTripReturn } from '../lib/trips/return.ts'
import { createTripService, startsOnShanghaiDay } from '../lib/trips/service.ts'
import { createMemorySearchCache } from '../lib/trips/search-cache.ts'
import { revokeWish } from '../lib/wishes/contract.ts'
import { insertDog, insertExchange, mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'
import { draftFor, request, writeFixture } from './helpers/trip-return-fixtures.mjs'

const spawnNode = promisify(execFile)
const origin = '2026-11-27T03:00:00.000Z'
const clock = iso => () => new Date(iso)
const count = (db, table) => db.prepare('SELECT count(*) n FROM ' + table).get().n
const input = (owner, intentId) => ({ dogId: owner.id, request: request(owner.cookie), intentId })
const scenes = ({ trip }) => ['a', 'b', 'c'].map(id => ({
  id, dogId: trip.dogId, tripId: trip.id, kind: 'scene', happenedAt: trip.startedAt,
  title: '受控观察 ' + id, excerpt: null, topics: [],
}))
const article = { title: '受控知乎', sourceUrl: 'https://www.zhihu.com/question/451', sourceMode: 'live',
  excerpt: null, authorityLevel: null, voteUpCount: null }
const live = fetchedAt => ({ ok: true, httpStatus: 200, fetchedAt, items: [article] })
const limited = { ok: false, httpStatus: 429, alert: false, fallback: 'cache-or-fixture',
  error: { code: 'RATE_LIMITED', detail: '受控限流', retriable: false } }

async function childRun(path, owner, key, mode = 'run') {
  const { stdout } = await spawnNode(process.execPath, ['--input-type=module', '-e', `
    import { openDatabase } from './lib/db/bootstrap.ts'
    import { createTripScheduler } from './lib/trips/scheduler.ts'
    import { createTripService } from './lib/trips/service.ts'
    import { resolveAuthContext } from './lib/auth/session.ts'
    import { request, writeFixture, draftFor } from './tests/helpers/trip-return-fixtures.mjs'
    const { path, owner, key, mode, origin, article } = JSON.parse(process.argv[1])
    const db = openDatabase(path), now = () => new Date(origin)
    const req = request(owner.cookie)
    let searches = 0, generations = 0
    try {
      if (mode === 'lost-response') {
        const service = createTripService(db, { now, authorizeOwner(dogId, ownerId) {
          if (resolveAuthContext(req, db)?.ownerId !== ownerId || dogId !== owner.id) throw new Error('Unauthorized test session')
        } })
        service.schedule(owner.id, owner.sessionId, key)
        // Simulate losing the response immediately after COMMIT.
      } else {
        const scheduler = createTripScheduler(db, { now, executor: {
          provider: async () => {
            if (db.isTransaction) throw new Error('Network in transaction')
            searches++
            return { ok: true, httpStatus: 200, fetchedAt: origin, items: [article] }
          },
          ownerObservations: ({ trip }) => ['a', 'b'].map(id => ({
            id, tripId: trip.id, dogId: trip.dogId, kind: 'scene', happenedAt: trip.startedAt,
            title: '受控进程材料 ' + id, excerpt: null, topics: [],
          })),
        }, returnPorts: { generationTimeoutMs: 2000, writeMessageInTransaction: writeFixture,
          generate: async evidence => { generations++; return draftFor(evidence) } } })
        console.log(JSON.stringify({ result: await scheduler.owner({ request: req, dogId: owner.id, intentId: key }), searches, generations }))
      }
    } catch (error) { console.log(JSON.stringify({ error: error.code ?? error.message })) }
    finally { db.close() }
  `, JSON.stringify({ path, owner, key, mode, origin, article })], { windowsHide: true })
  return stdout.trim() ? JSON.parse(stdout) : null
}

test('cold after create response loss, then cold after full return: one stable Trip and zero replay I/O', async t => {
  const { db, path } = mailboxDatabase(t)
  const owner = ownedDog(db, 'scheduled-owner')
  const key = 'opaque-job-17'
  assert.equal(await childRun(path, owner, key, 'lost-response'), null)
  const pending = db.prepare('SELECT id,status FROM trip').get()
  assert.equal(pending.status, 'pending')
  assert.equal(startsOnShanghaiDay(db, owner.id, origin), 0)
  const first = await childRun(path, owner, key)
  assert.equal(first.result.discovery.trip.id, pending.id)
  assert.equal(first.result.return.status, 'confirmed')
  assert.deepEqual([first.searches, first.generations], [1, 1])
  const cold = await childRun(path, owner, key)
  assert.equal(cold.result.discovery.status, 'terminal')
  assert.equal(cold.result.return.replayed, true)
  assert.deepEqual(cold.result.return.message, first.result.return.message)
  assert.deepEqual([cold.searches, cold.generations], [0, 0])
  for (const table of ['trip', 'trip_snapshot', 'trip_discovery_receipt', 'message']) assert.equal(count(db, table), 1)
  assert.equal(startsOnShanghaiDay(db, owner.id, origin), 1)
})

test('two OS processes share a stable intent; distinct intents for an active dog are rejected', async t => {
  const { db, path } = mailboxDatabase(t)
  const owner = ownedDog(db, 'concurrent-owner')
  const results = await Promise.all([childRun(path, owner, 'same'), childRun(path, owner, 'same')])
  const ids = results.map(row => row.result?.discovery.trip.id)
  assert.ok(ids[0])
  assert.equal(ids[0], ids[1])
  assert.equal(count(db, 'trip'), 1)
  assert.equal(count(db, 'trip_snapshot'), 1)
  assert.equal(count(db, 'message'), 1)
  const other = ownedDog(db, 'other-concurrent-owner')
  const distinct = await Promise.all([childRun(path, other, 'one', 'lost-response'), childRun(path, other, 'two', 'lost-response')])
  assert.equal(distinct.filter(item => item === null).length, 1)
  assert.deepEqual(distinct.find(item => item !== null), { error: 'CONFLICT' })
})

test('keys are owner-scoped; mismatched reserved rows fail without replaying foreign state', async t => {
  const { db } = mailboxDatabase(t)
  const first = ownedDog(db, 'first')
  const second = ownedDog(db, 'second')
  const scheduler = createTripScheduler(db, { now: clock(origin), executor: { provider: async () => live(origin) } })
  const a = await scheduler.owner(input(first, 'same-key'))
  const b = await scheduler.owner(input(second, 'same-key'))
  assert.notEqual(a.discovery.trip.id, b.discovery.trip.id)
  await assert.rejects(scheduler.owner({ ...input(first, 'same-key'), dogId: second.id }), { code: 'NOT_FOUND' })
  db.prepare("UPDATE trip SET trigger='friend' WHERE id=?").run(a.discovery.trip.id)
  await assert.rejects(scheduler.owner(input(first, 'same-key')), { code: 'CONFLICT' })
})

test('dial retries are stable, follow Shanghai quota and six-hour rules, and deliver only on the receiver seq', async t => {
  const { db } = mailboxDatabase(t)
  const receiver = ownedDog(db, 'receiver')
  const sender = ownedDog(db, 'sender')
  const dial = createTravelDial(db, { ownerObservations: scenes })
  const settle = (trip, owner, time) => createTripService(db, { now: clock(time) }).finish(trip.id, owner.sessionId, 'done')
  const dialAt = (dog, id, target) => dial.owner({ ...input(dog, id), target })
  insertExchange(db, 'delayed', sender.id, receiver.id, 2)
  await dialAt(sender, 'sender-job', origin)
  assert.equal(db.prepare("SELECT delivered_at FROM exchange WHERE id='delayed'").get().delivered_at, null)
  const one = await dialAt(receiver, 'one', origin)
  assert.equal(one.discovery.status, 'partial')
  assert.equal((await dialAt(receiver, 'one', origin)).discovery.trip.id, one.discovery.trip.id)
  assert.equal(startsOnShanghaiDay(db, receiver.id, origin), 1)
  settle(one.discovery.trip, receiver, origin)
  await assert.rejects(dialAt(receiver, 'two', '2026-11-27T08:59:59.999Z'), { code: 'CONFLICT' })
  assert.equal(db.prepare('SELECT count(*) n FROM trip WHERE dog_id=?').get(receiver.id).n, 1)
  const twoAt = '2026-11-27T09:00:00.000Z'
  const two = await dialAt(receiver, 'two', twoAt)
  assert.equal(two.discovery.trip.seq, 2)
  assert.equal(db.prepare("SELECT delivered_at FROM exchange WHERE id='delayed'").get().delivered_at, twoAt)
  settle(two.discovery.trip, receiver, twoAt)
  await assert.rejects(dialAt(receiver, 'three', '2026-11-27T15:59:59.999Z'), { code: 'CONFLICT' })
  assert.equal((await dialAt(receiver, 'two', twoAt)).discovery.status, 'terminal')
  const midnight = '2026-11-27T16:00:00.000Z'
  assert.equal(startsOnShanghaiDay(db, receiver.id, midnight), 0)
  const three = await dialAt(receiver, 'three', midnight)
  assert.equal(three.discovery.trip.seq, 3)
  assert.equal(startsOnShanghaiDay(db, receiver.id, midnight), 1)
  assert.equal(db.prepare("SELECT delivered_at FROM exchange WHERE id='delayed'").get().delivered_at, twoAt)
})

test('scheduled start reevaluates Wishes under lock, honors owner priority and blocks restricted texts', async t => {
  const { db } = mailboxDatabase(t)
  const owner = ownedDog(db, 'wish-owner')
  const insert = db.prepare('INSERT INTO wish(id,dog_id,text,category,source,source_url,created_at) VALUES (?,?,?,?,?,?,?)')
  insert.run('owner-first', owner.id, '愿望原文', '自然风景', 'owner', null, origin)
  insert.run('collection-new', owner.id, '收藏原文', '自然风景', 'collection',
    'https://www.zhihu.com/question/333', '2026-11-27T03:01:00.000Z')
  const scheduler = createTripScheduler(db, { now: clock(origin), executor: { provider: async () => live(origin) } })
  const c4 = createTripService(db, { now: clock(origin), authorizeOwner() {} })
  const pending = c4.schedule(owner.id, owner.sessionId, 'wish-job')
  assert.equal(pending.wishId, null)
  assert.equal((await scheduler.owner(input(owner, 'wish-job'))).discovery.trip.wishId, 'owner-first')
  revokeWish(db, 'owner-first', owner.sessionId, origin)
  assert.equal(c4.get(pending.id, owner.sessionId).wishId, 'owner-first')
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM snapshot').all()), /愿望原文|收藏原文/)
  c4.finish(pending.id, owner.sessionId, 'done')
  const later = '2026-11-27T09:00:00.000Z'
  const second = createTripService(db, { now: clock(later), authorizeOwner() {} }).schedule(owner.id, owner.sessionId, 'revoked')
  insert.run('pending-wish', owner.id, '撤销的候选', '自然风景', 'owner', null, later)
  revokeWish(db, 'pending-wish', owner.sessionId, later)
  db.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run('["收藏原文"]', owner.id)
  const result = await createTravelDial(db).owner({ ...input(owner, 'revoked'), target: later })
  assert.equal(result.discovery.trip.id, second.id)
  assert.equal(result.discovery.trip.trigger, 'auto')
  assert.equal(result.discovery.trip.wishId, null)
})

test('dial does not touch cache or accelerate cookie expiration; real TTL still rejects exactly 24 hours', async t => {
  const { db } = mailboxDatabase(t)
  const owner = ownedDog(db, 'ttl-owner')
  const demo = ownedDog(db, 'dial-owner')
  const cache = createMemorySearchCache()
  let calls = 0
  const first = await createTripScheduler(db, { now: clock(origin), executor: { cache, ownerObservations: scenes,
    provider: async () => { calls++; return live(origin) } } }).owner(input(owner, 'warm'))
  assert.equal(first.discovery.status, 'complete')
  createTripService(db, { now: clock(origin) }).finish(first.discovery.trip.id, owner.sessionId, 'done')
  const clockBefore = Date.now()
  const dial = createTravelDial(db, { ownerObservations: scenes })
  const future = await dial.owner({ ...input(demo, 'future'), target: '2036-01-01T00:00:00.000Z' })
  assert.equal(future.discovery.trip.startedAt, '2036-01-01T00:00:00.000Z')
  assert.ok(resolveAuthContext(request(demo.cookie), db))
  assert.ok(Date.now() - clockBefore < 10000)
  const exact = '2026-11-28T03:00:00.000Z'
  const result = await createTripScheduler(db, { now: clock(exact), executor: { cache, ownerObservations: scenes,
    provider: async () => { calls++; return limited } } }).owner(input(owner, 'exact-ttl'))
  assert.equal(result.discovery.status, 'partial')
  assert.ok(result.discovery.finds.every(find => find.sourceMode === null))
  assert.equal(calls, 2)
})

test('v7 held seed is found by its original scheduled intent with zero discovery or return I/O', async t => {
  const { db, path } = mailboxDatabase(t, migrations.filter(m => m.version <= 7),
    readFileSync('tests/fixtures/schema-v1.sql', 'utf8'))
  insertDog(db, 'old-scheduled-seed', 'seed', 1)
  const scope = { dogId: 'old-scheduled-seed', intentId: 'old-seed-job' }
  const { sampleTripLifecycle } = await import('../lib/trips/service.ts')
  const seed = sampleTripLifecycle(db, scope.dogId, scope.intentId, { now: clock(origin) })
  seed.create()
  const { trip } = seed.start()
  db.prepare("INSERT INTO find(id,trip_id,kind,title,created_at) VALUES('old',?,'scene','旧发现',?)").run(trip.id, origin)
  db.close()
  const migrated = openDatabase(path)
  try {
    const forbidden = () => assert.fail('held trip must not invoke I/O')
    const scheduler = createTripScheduler(migrated, { now: clock(origin),
      executor: { conditions: forbidden, seedObservations: forbidden, provider: forbidden },
      returnPorts: { generationTimeoutMs: 1000, generate: forbidden, writeMessageInTransaction: forbidden } })
    const result = await scheduler.seed({ ...scope, retryDiscovery: true })
    assert.equal(result.discovery.status, 'held')
    assert.equal(result.discovery.trip.status, 'running')
    assert.equal(result.return, null)
    assert.equal(count(migrated, 'trip'), 1)
    assert.equal(count(migrated, 'message'), 0)
  } finally { migrated.close() }
})

test('explicit upstream deadline settles a partial running Trip via C4 without generation', async t => {
  const { db } = mailboxDatabase(t)
  const owner = ownedDog(db, 'deadline-owner')
  const scope = input(owner, 'deadline')
  const started = await createTripScheduler(db, { now: clock(origin), executor: { provider: async () => limited } }).owner(scope)
  assert.equal(started.discovery.status, 'partial')
  const unreachable = () => assert.fail('expiry must not generate or write a Message')
  const returns = createTripReturn(db, { now: clock(origin), generationTimeoutMs: 1000,
    generate: unreachable, writeMessageInTransaction: unreachable })
  const expired = await returns.owner({ ...scope, tripId: started.discovery.trip.id, expire: true })
  assert.equal(expired.status, 'expired')
  assert.equal(expired.trip.status, 'timeout')
  assert.equal(count(db, 'message'), 0)
})
