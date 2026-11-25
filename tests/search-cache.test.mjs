import assert from 'node:assert/strict'
import { test } from 'node:test'
import { revokeSession } from '../lib/auth/session.ts'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { createTripDiscoveryComposer } from '../lib/trips/composer.ts'
import { createTripDiscoverer, createTripDiscoverySearch } from '../lib/trips/discover.ts'
import { createFindStore, handleFindsRequest } from '../lib/trips/finds.ts'
import { createMemorySearchCache, isFreshSearchTime } from '../lib/trips/search-cache.ts'
import { createSeedTripRunner } from '../lib/trips/seed-runner.ts'
import { createTripService } from '../lib/trips/service.ts'
import { createZhihuSearchClient } from '../lib/zhihu/client.ts'
import { insertDog, mailboxDatabase } from './helpers/mailbox-fixtures.mjs'
import { fixtureSession } from './helpers/owner-session.mjs'

const first = Date.parse('2026-11-25T00:00:00.000Z')
const hour = 60 * 60 * 1000
const day = 24 * hour
const privateQuery = '这只狗的私有心愿'
const category = '自然风景'
const secret = 'controlled-c9-secret'
const article = {
  Title: '<em>山景记录</em>', ContentText: '受控摘要',
  Url: 'https://zhihu.com/question/123/answer/321/?utm_source=test#comment', AuthorityLevel: '4', VoteUpCount: 17,
}
const canonical = 'https://www.zhihu.com/question/123/answer/321'
const ok = (...items) => Response.json({ Code: 0, Data: { Items: items } })
const unavailable = status => Response.json({}, { status })
const conflict = { code: 'CONFLICT' }
const missing = { code: 'NOT_FOUND' }

function fixture(t) {
  const { db, path } = mailboxDatabase(t)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8)
  const clock = { at: first }
  const now = () => new Date(clock.at)
  const trips = createTripService(db, { now })
  const cache = createMemorySearchCache()
  const compose = createTripDiscoveryComposer(db, { now })
  const store = createFindStore(db, { now })

  function owner(dogId, query = privateQuery, interest = category) {
    const { sessionId: ownerId, setCookie } = fixtureSession(db)
    insertDog(db, dogId, ownerId)
    db.prepare('INSERT INTO wish(id,dog_id,text,category,created_at) VALUES(?,?,?,?,?)')
      .run(`wish-${dogId}`, dogId, query, interest, now().toISOString())
    const request = new Request('https://local.test/finds', { headers: { cookie: setCookie.split(';', 1)[0] } })
    return { dogId, ownerId, request }
  }

  function start(profile) {
    const { id } = trips.create(profile.dogId, profile.ownerId, 'wish')
    const { trip } = trips.start(id, profile.ownerId)
    return { ...profile, id, startedAt: trip.startedAt }
  }

  function provider(reply) {
    const calls = []
    // Real C5 parser, with synthetic responses and no external I/O or real credentials.
    const search = createZhihuSearchClient({ accessSecret: secret, now: () => clock.at,
      fetch: async target => {
        assert.equal(db.isTransaction, false)
        calls.push(target.searchParams.get('Query'))
        return reply()
      } })
    return { search, calls }
  }

  function search(trip, reply, adapter = cache) {
    return createTripDiscoverySearch(db, provider(reply).search, { cache: adapter, now })(trip.id, trip.request)
  }

  function persist(trip, result, observations = []) {
    assert.equal(result.ok, true)
    return compose(trip.id, trip.request, { searchProofs: result.proofs, observations })
  }

  function history(trip) {
    return store.list(trip.id, trip.ownerId)
  }

  return { db, path, clock, now, trips, cache, compose, store, owner, start, provider, search, persist, history }
}

function scenes(trip, ...ids) {
  return ids.map(id => ({ id, tripId: trip.id, dogId: trip.dogId, kind: 'scene', title: `受控观察 ${id}`,
    excerpt: null, happenedAt: trip.startedAt, topics: [] }))
}

function watchCache(cache) {
  const reads = [], writes = []
  return {
    reads, writes,
    async read(key) {
      reads.push(key)
      return cache.read(key)
    },
    async write(key, value) {
      writes.push({ key, value })
      await cache.write(key, value)
    },
  }
}

test('verified C5 success produces live SQLite Find and scoped cache; later Trip falls back once on 429', async t => {
  const f = fixture(t)
  const owner = f.owner('owner')
  const liveTrip = f.start(owner)
  const adapter = watchCache(f.cache)
  const liveProvider = f.provider(() => ok(article))
  const discover = createTripDiscoverer(f.db, { provider: liveProvider.search, cache: adapter, now: f.now })
  const live = await discover(liveTrip.id, liveTrip.request)
  assert.equal(live.ok, true)
  assert.deepEqual(liveProvider.calls, [privateQuery])
  const [saved] = live.finds
  assert.equal(saved.sourceMode, 'live')
  assert.equal(saved.sourceUrl, canonical)
  assert.deepEqual(f.history(liveTrip), [saved])
  const [{ key, value }] = adapter.writes
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.deepEqual(value, { key, provider: 'zhihu-search', version: 1, ownerId: owner.ownerId,
    fetchedAt: new Date(first).toISOString(),
    items: [{ sourceUrl: canonical, sourceMode: 'live', title: '山景记录', excerpt: '受控摘要',
      authorityLevel: 4, voteUpCount: 17 }] })
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.items) && Object.isFrozen(value.items[0]))
  assert.ok(!JSON.stringify(value).includes(privateQuery))
  assert.ok(!JSON.stringify(value).includes(secret))

  f.trips.finish(liveTrip.id, owner.ownerId, 'done')
  f.clock.at += 7 * hour
  const cacheTrip = f.start(owner)
  const limited = f.provider(() => unavailable(429))
  const search = createTripDiscoverySearch(f.db, limited.search, { cache: adapter, now: f.now })
  const fallback = await search(cacheTrip.id, cacheTrip.request)
  assert.equal(fallback.fetchedAt, value.fetchedAt)
  assert.deepEqual(fallback.degradation, { code: 'RATE_LIMITED', alert: false })
  assert.deepEqual(limited.calls, [privateQuery])
  const batch = f.persist(cacheTrip, fallback, scenes(cacheTrip, '1', '2'))
  assert.equal(batch.status, 'complete')
  assert.equal(batch.finds.length, 3)
  const cached = batch.finds.find(row => row.kind === 'zhihu')
  assert.equal(cached.sourceMode, 'cache')
  assert.equal(cached.sourceUrl, canonical)
  assert.notEqual(cached.id, saved.id)
  assert.deepEqual(adapter.reads, [key])
  assert.equal(adapter.writes.length, 1)
  const reopened = openDatabase(f.path)
  try {
    const response = handleFindsRequest(cacheTrip.request, cacheTrip.id, () => reopened)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).finds.find(row => row.id === cached.id).sourceMode, 'cache')
  } finally { reopened.close() }
})

test('AUTH business failure keeps its internal alert and accepts cache; default adapter spans search factories', async t => {
  const f = fixture(t), trip = f.start(f.owner('auth'))
  const live = f.provider(() => ok(article)), denied = f.provider(() => Response.json({ Code: 20001 }))
  assert.equal((await createTripDiscoverySearch(f.db, live.search, { now: f.now })(trip.id, trip.request)).ok, true)
  const fallback = await createTripDiscoverySearch(f.db, denied.search, { now: f.now })(trip.id, trip.request)
  assert.deepEqual(denied.calls, [privateQuery])
  assert.deepEqual(fallback.degradation, { code: 'AUTH', alert: true })
  assert.equal(f.persist(trip, fallback).finds[0].sourceMode, 'cache')
  assert.equal(f.history(trip).length, 1)
})

test('cache age from original fetchedAt is inclusive at zero and exclusive at 24 hours', async t => {
  const f = fixture(t), adapter = watchCache(f.cache)
  f.clock.at = first - 1
  const trip = f.start(f.owner('ttl'))
  f.clock.at = first
  await f.search(trip, () => ok(article), adapter)
  for (const [age, accepted] of [[-1, false], [0, true], [day - 1, true], [day, false], [day + 1, false]]) {
    f.clock.at = first + age
    const result = await f.search(trip, () => unavailable(429), adapter)
    assert.equal(result.ok, true)
    assert.equal(result.proofs.length, Number(accepted), `age ${age}`)
    assert.equal(result.fetchedAt, accepted ? new Date(first).toISOString() : null)
  }
  assert.equal(adapter.writes.length, 1)
  assert.deepEqual(f.history(trip), [])
})

test('no proofs from invalid timestamps, future acquisitions, forged or copied cache records', async t => {
  const f = fixture(t), trip = f.start(f.owner('invalid')), adapter = watchCache(f.cache)
  const good = f.provider(() => ok(article))
  for (const fetchedAt of [undefined, null, '', 'yesterday', '2026-02-30T00:00:00Z', '2026-11-25T00:00:00']) {
    assert.equal(isFreshSearchTime(fetchedAt, first), false)
    const damaged = async query => ({ ...(await good.search(query)), fetchedAt })
    const result = await createTripDiscoverySearch(f.db, damaged, { cache: adapter, now: f.now })(trip.id, trip.request)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'NETWORK')
  }
  const future = async query => ({ ...(await good.search(query)), fetchedAt: new Date(first + 1).toISOString() })
  const live = await createTripDiscoverySearch(f.db, future, { cache: adapter, now: f.now })(trip.id, trip.request)
  assert.equal(live.ok, true)
  assert.equal(adapter.writes.length, 0)

  await f.search(trip, () => ok(article), adapter)
  const [{ value }] = adapter.writes
  for (const fake of [{ ...value }, JSON.parse(JSON.stringify(value)),
    { ...value, fetchedAt: undefined }, { ...value, fetchedAt: 'corrupt' },
    { ...value, fetchedAt: new Date(first + 1).toISOString() }]) {
    const forged = { read: async () => fake, write: () => assert.fail('fallback must not write cache') }
    const result = await f.search(trip, () => unavailable(429), forged)
    assert.equal(result.ok, true)
    assert.deepEqual(result.proofs, [])
    assert.equal(result.fetchedAt, null)
  }
})

test('age is checked again at write, and an expired unconfirmed proof cannot create or count a Find', async t => {
  const f = fixture(t), trip = f.start(f.owner('commit-ttl'))
  await f.search(trip, () => ok(article))
  f.clock.at += day - 1
  const fallback = await f.search(trip, () => unavailable(429))
  assert.equal(fallback.proofs.length, 1)
  f.clock.at += 1
  assert.throws(() => f.store.writeVerified(fallback.proof, trip.request), conflict)
  const partial = f.persist(trip, fallback, scenes(trip, '1', '2', '3'))
  assert.equal(partial.status, 'partial')
  assert.deepEqual(partial.reasons, ['NO_REAL_ZHIHU'])
  assert.equal(partial.finds.length, 3)
  assert.ok(f.history(trip).every(row => row.kind === 'scene'))
})

test('cache freshness is measured after the asynchronous read completes', async t => {
  const f = fixture(t), trip = f.start(f.owner('selection-ttl'))
  await f.search(trip, () => ok(article))
  f.clock.at += day - 1
  const adapter = { ...f.cache, async read(key) {
    const record = await f.cache.read(key)
    f.clock.at += 1
    return record
  } }
  const result = await f.search(trip, () => unavailable(429), adapter)
  assert.equal(f.clock.at, first + day)
  assert.equal(result.fetchedAt, null)
  assert.deepEqual(result.proofs, [])
})

test('owner, exact query and category isolate keys even when an adapter returns a genuine wrong record', async t => {
  const f = fixture(t)
  const own = f.start(f.owner('private-a')), other = f.start(f.owner('private-b'))
  const adapter = watchCache(f.cache)
  await f.search(own, () => ok(article), adapter)
  const [{ value, key }] = adapter.writes
  const keys = []
  const returnsWrongRecord = {
    async read(requested) {
      keys.push(requested)
      return value
    },
    write: () => assert.fail('fallback write'),
  }
  assert.deepEqual((await f.search(other, () => unavailable(429), returnsWrongRecord)).proofs, [])

  f.trips.finish(own.id, own.ownerId, 'done')
  f.clock.at += 7 * hour
  const wishId = `wish-${own.dogId}`
  f.db.prepare('UPDATE wish SET category=? WHERE id=?').run('冷知识', wishId)
  const newTrip = f.start(own)
  assert.deepEqual((await f.search(newTrip, () => unavailable(429), returnsWrongRecord)).proofs, [])
  f.db.prepare('UPDATE wish SET text=?,category=? WHERE id=?').run('完全不同的心愿', category, wishId)
  assert.deepEqual((await f.search(newTrip, () => unavailable(429), returnsWrongRecord)).proofs, [])
  assert.equal(keys.length, 3)
  assert.equal(new Set([key, ...keys]).size, 4)
})

test('cache proofs reject copies, cross-Trip use, plain source modes and seed paths', async t => {
  const f = fixture(t), trip = f.start(f.owner('proof'))
  await f.search(trip, () => ok(article))
  const result = await f.search(trip, () => unavailable(429))
  const proof = result.proof
  assert.ok(proof)
  for (const fake of [{ ...proof }, JSON.parse(JSON.stringify(proof)), { ...proof, sourceMode: 'cache' }]) {
    assert.throws(() => f.compose(trip.id, trip.request, { searchProofs: [fake] }), conflict)
  }
  assert.throws(() => f.store.write({ tripId: trip.id, kind: 'zhihu', title: '假证明',
    excerpt: null, sourceUrl: canonical, sourceMode: 'cache', authorityLevel: null, voteUpCount: null, assetPath: null },
  trip.ownerId), conflict)
  f.trips.finish(trip.id, trip.ownerId, 'done')
  f.clock.at += 7 * hour
  const next = f.start(trip)
  assert.throws(() => f.compose(next.id, next.request, { searchProofs: [proof] }), conflict)
  const dogId = 'c9-seed', intentId = 'seed-test'
  insertDog(f.db, dogId, 'seed', 1)
  const seed = createSeedTripRunner(f.db, { now: f.now })(dogId, intentId)
  const { id: tripId } = seed.create()
  seed.start()
  let calls = 0
  const forbidden = () => { calls++; throw new Error('seed reached provider or adapter') }
  const searchSeed = createTripDiscoverySearch(f.db, forbidden, { cache: { read: forbidden, write: forbidden }, now: f.now })
  for (const scope of ['seed', trip.request]) await assert.rejects(searchSeed(tripId, scope), missing)
  assert.equal(calls, 0)
  assert.throws(() => f.compose.forSeed({ dogId, tripId, intentId }, { searchProofs: [proof] }), conflict)
  assert.deepEqual(f.compose.forSeed({ dogId, tripId, intentId }).finds, [])
  assert.deepEqual(f.history(trip), [])
})

test('ordinary transport, server failures and malformed responses keep NETWORK without touching a warm cache', async t => {
  const f = fixture(t), trip = f.start(f.owner('network')), adapter = watchCache(f.cache)
  await f.search(trip, () => ok(article), adapter)
  for (const reply of [
    () => { throw new Error(secret) },
    () => { throw new globalThis.DOMException('controlled timeout', 'TimeoutError') },
    () => unavailable(503),
    () => Response.json({ Code: 30001 }, { status: 503 }),
    () => Response.json({ Code: 0, Data: {} }),
  ]) {
    const provider = f.provider(reply)
    const search = createTripDiscoverySearch(f.db, provider.search, { cache: adapter, now: f.now })
    const result = await search(trip.id, trip.request)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'NETWORK')
    assert.equal(result.error.retriable, true)
    assert.equal(result.fallback, null)
    assert.equal(provider.calls.length, 1)
    assert.ok(!JSON.stringify(result).includes(secret))
  }
  assert.deepEqual(adapter.reads, [])
  assert.equal(adapter.writes.length, 1)
  assert.deepEqual(f.history(trip), [])
})

test('cache miss produces explicit insufficiency and a successful empty search supersedes older content', async t => {
  const f = fixture(t), trip = f.start(f.owner('miss'))
  const miss = await f.search(trip, () => unavailable(429))
  assert.deepEqual(f.persist(trip, miss), { status: 'partial', finds: [], reasons: ['NO_REAL_ZHIHU', 'INSUFFICIENT_FACTS'] })
  await f.search(trip, () => ok(article))
  f.clock.at += 1
  await f.search(trip, () => ok())
  const later = await f.search(trip, () => unavailable(429))
  assert.deepEqual(f.persist(trip, later).finds, [])
  assert.deepEqual(later.degradation, { code: 'RATE_LIMITED', alert: false })
})

test('live does not upgrade stored fixture or cache and cache cannot authorize mismatching historical text', async t => {
  const f = fixture(t)
  const fixtureTrip = f.start(f.owner('fixture')), cacheTrip = f.start(f.owner('cache-first'))
  const fixtureFind = f.store.write({ tripId: fixtureTrip.id, kind: 'zhihu', title: '旧夹具', excerpt: null,
    sourceUrl: canonical, sourceMode: 'fixture', authorityLevel: null, voteUpCount: null, assetPath: null }, fixtureTrip.ownerId)
  const live = await f.search(fixtureTrip, () => ok(article))
  assert.deepEqual(f.persist(fixtureTrip, live).finds, [])
  assert.deepEqual(f.history(fixtureTrip), [fixtureFind])

  await f.search(cacheTrip, () => ok(article))
  const fallback = await f.search(cacheTrip, () => unavailable(429))
  const [saved] = f.persist(cacheTrip, fallback).finds
  f.clock.at += 1
  assert.deepEqual(f.persist(cacheTrip, fallback).finds, [saved])
  assert.deepEqual(f.persist(cacheTrip, await f.search(cacheTrip, () => ok(article))).finds, [])
  assert.deepEqual(f.history(cacheTrip), [saved])

  const historical = f.start(f.owner('historical'))
  f.db.prepare(`INSERT INTO find(id,trip_id,kind,title,source_url,source_mode,created_at)
    VALUES('old-cache',?,'zhihu','无证据的旧正文',?,'cache',?)`).run(historical.id, canonical, f.now().toISOString())
  await f.search(historical, () => ok(article))
  assert.deepEqual(f.persist(historical, await f.search(historical, () => unavailable(429))).finds, [])
  assert.equal(f.history(historical)[0].title, '无证据的旧正文')
})

test('blocks are checked at cache selection and again inside asynchronous fallback commit', async t => {
  const f = fixture(t), trip = f.start(f.owner('blocks'))
  await f.search(trip, () => ok(article))
  const second = openDatabase(f.path)
  const updateBlock = topics => second.prepare('UPDATE dog SET blocked_topics=? WHERE id=?')
    .run(JSON.stringify(topics), trip.dogId)
  try {
    updateBlock(['山景'])
    assert.deepEqual((await f.search(trip, () => unavailable(429))).proofs, [])
    updateBlock([])
    const adapter = { ...f.cache, async read(key) {
      assert.equal(f.db.isTransaction, false)
      await Promise.resolve()
      updateBlock(['受控摘要'])
      return f.cache.read(key)
    } }
    const fallback = await f.search(trip, () => unavailable(429), adapter)
    assert.equal(fallback.proofs.length, 1)
    assert.deepEqual(f.persist(trip, fallback).finds, [])
    assert.deepEqual(f.history(trip), [])
  } finally { second.close() }
})

test('terminal state and revoked cookie after provider search or async cache read reject writes', async t => {
  const f = fixture(t), finished = f.start(f.owner('ended')), revoked = f.start(f.owner('revoked'))
  await f.search(revoked, () => ok(article))
  const second = openDatabase(f.path)
  try {
    const live = await f.search(finished, () => {
      createTripService(second, { now: f.now }).finish(finished.id, finished.ownerId, 'timeout')
      return ok(article)
    })
    assert.throws(() => f.persist(finished, live), conflict)
    const adapter = { ...f.cache, async read(key) {
      assert.equal(f.db.isTransaction, false)
      revokeSession(revoked.request, second)
      return f.cache.read(key)
    } }
    const fallback = await f.search(revoked, () => unavailable(401), adapter)
    assert.equal(fallback.proofs.length, 1)
    assert.throws(() => f.persist(revoked, fallback), missing)
    assert.deepEqual(f.history(finished), [])
    assert.deepEqual(f.history(revoked), [])
  } finally { second.close() }
})

test('confirmed cache-backed batch replays after TTL with current blocks and never recreates or adds rows', async t => {
  const f = fixture(t), trip = f.start(f.owner('confirmed'))
  await f.search(trip, () => ok(article))
  const drift = await f.search(trip, () => ok({ ...article, Url: canonical.replace('321', '456') }))
  // Refill the original source. New result still carries the same server acquisition time.
  await f.search(trip, () => ok(article))
  const fallback = await f.search(trip, () => unavailable(429))
  const complete = f.persist(trip, fallback, scenes(trip, 'a', 'b'))
  assert.equal(complete.status, 'complete')
  const confirmedArticle = complete.finds.find(row => row.sourceMode === 'cache')
  f.clock.at += day
  const second = openDatabase(f.path)
  try {
    const replay = createTripDiscoveryComposer(second, { now: f.now })
    const provider = f.provider(() => unavailable(429)), cache = watchCache(f.cache)
    const search = createTripDiscoverySearch(second, provider.search, { cache, now: f.now })
    assert.deepEqual((await search(trip.id, trip.request)).proofs, [])
    assert.deepEqual(provider.calls, [])
    assert.deepEqual(cache.reads, [])
    assert.deepEqual(cache.writes, [])
    assert.deepEqual(replay(trip.id, trip.request, { searchProofs: drift.proofs }),
      { ...complete, confirmation: { ...complete.confirmation, replayed: true } })
    assert.equal(f.history(trip).length, 3)
    second.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run('["山景"]', trip.dogId)
    const filtered = replay(trip.id, trip.request)
    assert.equal(filtered.status, 'complete')
    assert.deepEqual(filtered.confirmation.visibilityReasons, ['BLOCKED_TOPICS'])
    assert.ok(filtered.finds.every(row => row.kind !== 'zhihu'))
    assert.ok(f.history(trip).some(row => row.id === confirmedArticle.id && row.sourceMode === 'cache'))
    second.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run('[]', trip.dogId)
    f.trips.finish(trip.id, trip.ownerId, 'done')
    assert.throws(() => replay(trip.id, trip.request), conflict)
    const response = handleFindsRequest(trip.request, trip.id, () => second)
    assert.deepEqual((await response.json()).finds.find(row => row.id === confirmedArticle.id), confirmedArticle)
  } finally { second.close() }
})

test('a failed cache-backed batch rolls back all writes and can retry with the same eligible proof', async t => {
  const f = fixture(t), trip = f.start(f.owner('rollback'))
  await f.search(trip, () => ok(article))
  const fallback = await f.search(trip, () => unavailable(429))
  const observations = scenes(trip, 'a', 'b')
  f.db.exec(`CREATE TRIGGER fail_c9_scene BEFORE INSERT ON find WHEN NEW.kind='scene'
    BEGIN SELECT RAISE(ABORT,'controlled C9 batch failure'); END`)
  assert.throws(() => f.persist(trip, fallback, observations), /controlled C9 batch failure/)
  assert.deepEqual(f.history(trip), [])
  f.db.exec('DROP TRIGGER fail_c9_scene')
  const batch = f.persist(trip, fallback, observations)
  assert.equal(batch.status, 'complete')
  assert.equal(batch.finds.filter(row => row.sourceMode === 'cache').length, 1)
  assert.deepEqual(f.persist(trip, fallback, observations),
    { ...batch, confirmation: { ...batch.confirmation, replayed: true } })
  assert.equal(f.history(trip).length, 3)
})

test('failed cache reads/writes are silent, create no trusted cache and do not duplicate or relabel live Find', async t => {
  const f = fixture(t), trip = f.start(f.owner('faults'))
  let staged
  const adapter = {
    async write(_key, value) {
      assert.equal(f.db.isTransaction, false)
      staged = value
      throw new Error(`private adapter diagnostics ${privateQuery} ${secret}`)
    },
    async read() {
      assert.equal(f.db.isTransaction, false)
      throw new Error(`private adapter diagnostics ${privateQuery} ${secret}`)
    },
  }
  const observedLogs = []
  t.mock.method(console, 'warn', (...args) => observedLogs.push(args))
  t.mock.method(console, 'error', (...args) => observedLogs.push(args))
  t.mock.method(console, 'log', (...args) => observedLogs.push(args))
  const first = await f.search(trip, () => ok(article), adapter)
  const saved = f.persist(trip, first).finds
  assert.equal(saved[0].sourceMode, 'live')
  assert.deepEqual(f.persist(trip, await f.search(trip, () => ok(article), adapter)).finds, saved)
  assert.equal(f.history(trip).length, 1)
  assert.ok(staged)
  const readFailed = await f.search(trip, () => unavailable(401), adapter)
  assert.deepEqual(readFailed.proofs, [])
  assert.deepEqual(readFailed.degradation, { code: 'AUTH', alert: true })
  const returnedUncommitted = { ...adapter, read: async () => staged }
  assert.deepEqual((await f.search(trip, () => unavailable(429), returnedUncommitted)).proofs, [])
  assert.deepEqual(observedLogs, [])
  assert.ok(!JSON.stringify(readFailed).includes(secret))
  assert.ok(!JSON.stringify(readFailed).includes(privateQuery))
})
