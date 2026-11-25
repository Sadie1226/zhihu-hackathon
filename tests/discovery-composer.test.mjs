import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { revokeSession, sessionCookieName } from '../lib/auth/session.ts'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { createTripEventSelector } from '../lib/events/select.ts'
import { createTripDiscoveryComposer } from '../lib/trips/composer.ts'
import { readDepartureSnapshot } from '../lib/trips/departure-snapshot.ts'
import { createTripDiscoverySearch } from '../lib/trips/discover.ts'
import { createFindStore, handleFindsRequest } from '../lib/trips/finds.ts'
import { readOccurrenceFact } from '../lib/trips/occurrence-facts.ts'
import { searchForTrip } from '../lib/trips/search-proof.ts'
import { createSeedTripRunner } from '../lib/trips/seed-runner.ts'
import { createTripService } from '../lib/trips/service.ts'
import { createZhihuSearchClient } from '../lib/zhihu/client.ts'
import { insertDog, insertExchange, mailboxDatabase } from './helpers/mailbox-fixtures.mjs'
import { fixtureSession } from './helpers/owner-session.mjs'

const started = '2026-11-25T00:00:00.000Z'
const observed = '2026-11-25T00:01:00.000Z'
const written = '2026-11-25T00:02:00.000Z'
const now = () => new Date(written)
const conditions = { sceneFile: 'scenes/nantou.png', season: 'spring', weather: 'clear', timeOfDay: 'morning' }
const url = id => `https://www.zhihu.com/question/123/answer/${id}`
const item = (id, title = `Controlled article ${id}`) => ({
  Title: title, ContentText: 'Controlled response excerpt', Url: url(id), AuthorityLevel: '3', VoteUpCount: 1,
})
const conflict = { code: 'CONFLICT' }
const missing = { code: 'NOT_FOUND' }
const get = (cookie, suffix = '') => new Request(`http://localhost/api/trips/test/finds${suffix}`, { headers: { cookie } })
const findRows = db => db.prepare('SELECT * FROM find ORDER BY id').all()

function owner(db, dogId) {
  const subject = `c6-${dogId}`
  const session = fixtureSession(db, subject)
  insertDog(db, dogId, session.sessionId)
  const cookie = session.setCookie.split(';', 1)[0]
  return { dogId, ownerId: session.sessionId, request: get(cookie), cookie, subject }
}

function pool(db) {
  db.exec(readFileSync('team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql', 'utf8'))
  db.exec("UPDATE event SET enabled = (code = 'any_shop_cat')")
}

function selectEvent(db, trip, context = conditions) {
  return createTripEventSelector(db, { now: () => new Date(observed), random: () => 0 })({
    dogId: trip.dogId, tripId: trip.id, sessionId: trip.ownerId, conditions: context,
  })
}

function observation(trip, key, title = `实地场景 ${key}`) {
  // Controlled server observation for this trip and dog, never an HTTP payload.
  return { id: key, kind: 'scene', title, excerpt: null, happenedAt: observed, tripId: trip.id, dogId: trip.dogId }
}

function controlledProvider(items, beforeResponse = () => {}) {
  // Runs the C5 protocol parser with synthetic responses. No real provider or credentials.
  return createZhihuSearchClient({ accessSecret: 'c6-offline-fixture', now: () => now().valueOf(),
    fetch: async () => {
      beforeResponse()
      return Response.json({ Code: 0, Data: { Items: items } })
    } })
}

function fixture(t) {
  const { db, path } = mailboxDatabase(t)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7)
  const trips = createTripService(db, { now: () => new Date(started) })
  function addTrip(dogId, beforeStart = () => {}) {
    const account = owner(db, dogId)
    const { id } = trips.create(dogId, account.ownerId, 'auto')
    beforeStart({ ...account, id })
    const departure = trips.start(id, account.ownerId)
    assert.equal(db.isTransaction, false)
    return { ...account, id, departure }
  }
  const compose = createTripDiscoveryComposer(db, { now })
  function search(trip, items, beforeResponse) {
    return createTripDiscoverySearch(db, controlledProvider(items, beforeResponse))(trip.id, trip.request)
  }
  return { db, path, trips, addTrip, compose, search }
}

test('real v7 owner start, C7 and frozen Moment retain the first content and G3 departure facts', t => {
  const { db, path, trips, addTrip, compose } = fixture(t)
  const sender = owner(db, 'sender')
  const trip = addTrip('traveler', ({ dogId }) => {
    insertExchange(db, 'due', sender.dogId, dogId, 1)
    insertExchange(db, 'future', sender.dogId, dogId, 2)
  })
  pool(db)
  assert.deepEqual(trip.departure.delivered.map(row => [row.id, row.deliveredAt]), [['due', started]])
  const snapshot = readDepartureSnapshot(db, trip.id, trip.dogId)
  assert.equal(snapshot.createdAt, started)
  assert.equal(snapshot.version, 1)
  const recorded = selectEvent(db, trip)
  assert.equal(recorded.eventId, 'ev_any_shop_cat')
  const fact = readOccurrenceFact(db, trip.id, trip.dogId)
  db.prepare("UPDATE event SET text=?,code=?,place_tags='[\"bookstore\"]',match_tags='[\"自然风景\"]' WHERE id=?")
    .run('今天改过的模板', 'changed-code', recorded.eventId)
  const batch = compose(trip.id, trip.request)
  const [saved] = batch.finds
  const key = `trip-event:${recorded.eventId}`
  const stableId = 'find_' + createHash('sha256').update(JSON.stringify(['c6-find-v1', trip.id, 'moment', key])).digest('hex')
  assert.deepEqual(saved, { id: stableId, tripId: trip.id, kind: 'moment', title: fact.text, excerpt: null,
    sourceMode: null, sourceUrl: null, assetPath: null, createdAt: written, authorityLevel: null, voteUpCount: null })
  const second = openDatabase(path)
  try {
    const retry = createTripDiscoveryComposer(second, { now: () => new Date('2026-11-25T00:03:00Z') })
    assert.deepEqual(retry(trip.id, trip.request), batch)
  } finally { second.close() }
  assert.equal(findRows(db).length, 1)
  assert.deepEqual(readDepartureSnapshot(db, trip.id, trip.dogId), snapshot)
  assert.deepEqual(db.prepare('SELECT id, delivered_at FROM exchange ORDER BY id').all()
    .map(row => [row.id, row.delivered_at]), [['due', started], ['future', null]])
  assert.deepEqual(trips.start(trip.id, trip.ownerId).delivered, [])
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('earliest migrated unverifiable occurrence wins SQLite ordering over a later frozen occurrence', t => {
  const { db: legacy, path } = mailboxDatabase(t, migrations.slice(0, -1))
  const account = owner(legacy, 'migrated')
  const trips = createTripService(legacy, { now: () => new Date(started) })
  const trip = { ...account, id: trips.create(account.dogId, account.ownerId, 'auto').id }
  // On-disk pre-v7 state, before the current start service began binding snapshots.
  legacy.prepare("UPDATE trip SET status='running', started_at=? WHERE id=?").run(started, trip.id)
  legacy.exec(`INSERT INTO event(id,code,text,season,weather,time_of_day)
    VALUES ('old','old','当前旧模板','any','any','any'),('later','later','其后冻结','any','any','any')`)
  // Text sort would put the later .500Z before the earlier Z.
  legacy.prepare("INSERT INTO trip_event VALUES (?,'old',?,'2026-11-25T00:01:00Z')").run(trip.id, trip.dogId)
  legacy.close()
  const db = openDatabase(path)
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7)
    db.prepare("INSERT INTO trip_event VALUES (?,'later',?,'2026-11-25T00:01:00.500Z')").run(trip.id, trip.dogId)
    assert.deepEqual(db.prepare('SELECT history_status FROM v_trip_event_history ORDER BY event_id').all()
      .map(row => row.history_status), ['frozen', 'unverifiable'])
    assert.equal(readOccurrenceFact(db, trip.id, trip.dogId), null)
    assert.deepEqual(createTripDiscoveryComposer(db, { now })(trip.id, trip.request), {
      status: 'partial', finds: [], reasons: ['NO_REAL_ZHIHU', 'INSUFFICIENT_FACTS'],
    })
    assert.deepEqual(findRows(db), [])
  } finally { db.close() }
})

test('corrupt or unavailable event storage fails the batch while an out-of-window fact does not enter it', t => {
  const { db, addTrip, compose } = fixture(t)
  const trip = addTrip('future-event')
  pool(db)
  db.prepare("INSERT INTO trip_event VALUES (?,'ev_any_shop_cat',?,'2026-11-25T00:02:01Z')").run(trip.id, trip.dogId)
  assert.deepEqual(compose(trip.id, trip.request).finds, [])
  db.exec('DROP TRIGGER trip_event_fact_v7_no_delete; DELETE FROM trip_event_fact')
  const input = { observations: [observation(trip, 'valid')] }
  assert.throws(() => compose(trip.id, trip.request, input), /Invalid v7 occurrence fact/)
  db.exec('DROP VIEW v_trip_event_history')
  assert.throws(() => compose(trip.id, trip.request, input), /v_trip_event_history/)
  assert.deepEqual(findRows(db), [])
  assert.equal(db.isTransaction, false)
})

test('same-key legacy Event Find mismatch is isolated for review and remains readable', async t => {
  const { db, addTrip, compose } = fixture(t)
  const trip = addTrip('legacy-find')
  pool(db)
  selectEvent(db, trip)
  const [first] = compose(trip.id, trip.request).finds
  db.prepare('UPDATE find SET title=? WHERE id=?').run('旧拼装采用了后来模板', first.id)
  const old = findRows(db)
  const next = compose(trip.id, trip.request, { observations: [observation(trip, 'valid')] })
  assert.equal(next.eventOmission, 'EVENT_FIND_MISMATCH')
  assert.equal(next.finds.length, 1)
  assert.equal(next.finds[0].kind, 'scene')
  assert.deepEqual(findRows(db).filter(row => row.id === first.id), old)
  const response = handleFindsRequest(trip.request, trip.id, () => db)
  assert.ok((await response.json()).finds.some(row => row.id === first.id && row.title === old[0].title))
})

test('seed requires exact running intent, accepts frozen events and controlled scenes, and cannot search', async t => {
  const { db, addTrip, compose, search } = fixture(t)
  const ordinary = addTrip('ordinary')
  const dogId = 'sample', intentId = 'c6-seed-intent'
  insertDog(db, dogId, 'seed', 1)
  insertDog(db, 'other-seed', 'seed', 1)
  pool(db)
  const intent = createSeedTripRunner(db, { now: () => new Date(observed) })(dogId, intentId)
  const { id } = intent.create()
  const scope = { dogId, tripId: id, intentId }
  assert.throws(() => compose.forSeed(scope), conflict)
  intent.start()
  assert.equal(intent.selectEvent(null), null)
  assert.deepEqual(compose.forSeed(scope), { status: 'partial', finds: [], reasons: ['INSUFFICIENT_FACTS'] })
  assert.equal(intent.selectEvent(conditions).eventId, 'ev_any_shop_cat')
  const fact = readOccurrenceFact(db, id, dogId)
  const proof = (await search(ordinary, [item(100)])).proof
  for (const spoof of [{ ...scope, dogId: 'other-seed' }, { ...scope, intentId: 'wrong' },
    { ...scope, tripId: ordinary.id, dogId: ordinary.dogId }]) assert.throws(() => compose.forSeed(spoof), missing)
  assert.throws(() => compose(id, scope), missing)
  assert.throws(() => compose(id, 'seed'), missing)
  assert.throws(() => compose(id, ordinary.request), missing)
  assert.throws(() => compose.forSeed(scope, { searchProofs: [proof] }), conflict)
  assert.throws(() => compose.forSeed(scope, { observations: [observation(ordinary, 'wrong')] }), conflict)
  const scene = observation({ id, dogId }, 'seed-scene')
  assert.throws(() => compose.forSeed(scope, { observations: [{ ...scene, kind: 'moment' }] }), conflict)
  let calls = 0
  const searchSeed = createTripDiscoverySearch(db, async () => { calls++; throw new Error('seed provider called') })
  for (const auth of [ordinary.request, 'seed', get(`${sessionCookieName()}=seed`)]) {
    await assert.rejects(searchSeed(id, auth), missing)
  }
  assert.equal(calls, 0)
  assert.equal(handleFindsRequest(ordinary.request, id, () => db).status, 404)
  const own = compose.forSeed(scope, { observations: [scene, observation({ id, dogId }, 'second-scene')] })
  assert.equal(own.status, 'complete')
  assert.deepEqual(own.reasons, [])
  assert.equal(own.finds.find(row => row.kind === 'moment').title, fact.text)
  assert.ok(own.finds.every(row => row.sourceMode === null && row.sourceUrl === null))
  assert.throws(() => compose.forSeed(scope, { searchProofs: [proof] }), conflict)
  intent.finish('done')
  assert.throws(() => compose.forSeed(scope), conflict)
  assert.equal(findRows(db).length, 3)
})

test('three and five eligible owner finds, URL dedup, stable owner cookies and complete/terminal replay', async t => {
  const { db, path, trips, addTrip, compose, search } = fixture(t)
  pool(db)
  const three = addTrip('three'), five = addTrip('five')
  selectEvent(db, three)
  selectEvent(db, five)
  const secondDevice = fixtureSession(db, three.subject)
  assert.equal(secondDevice.sessionId, three.ownerId)
  const otherDevice = get(secondDevice.setCookie.split(';', 1)[0])
  const oldProofs = await search(three, [item(201)])
  const drift = await search(three, [item(299)])
  assert.deepEqual(findRows(db), [])
  assert.throws(() => compose(three.id, five.request), missing)
  assert.throws(() => compose(five.id, five.request, { searchProofs: oldProofs.proofs }), conflict)
  const threeInput = { searchProofs: oldProofs.proofs, observations: [observation(three, 'three')] }
  const first = compose(three.id, otherDevice, threeInput)
  assert.equal(first.status, 'complete')
  assert.equal(first.finds.length, 3)
  assert.deepEqual(compose(three.id, three.request, { searchProofs: drift.proofs, observations: [] }), first)
  let replayCalls = 0
  const replay = await search(three, [item(300)], () => { replayCalls++ })
  assert.equal(replay.ok, true)
  assert.deepEqual(replay.proofs, [])
  assert.equal(replayCalls, 0)
  const second = openDatabase(path)
  try {
    const replayFromSecond = createTripDiscoveryComposer(second, { now })
    assert.deepEqual(replayFromSecond(three.id, three.request, { searchProofs: drift.proofs }), first)
    assert.throws(() => createFindStore(second, { now }).writeVerified(drift.proof, three.request), conflict)
  } finally { second.close() }
  const duplicate = { ...item(301), Url: url(301).replace('www.zhihu.com', 'zhihu.com') + '/?utm_medium=demo' }
  const fiveProofs = await search(five, [item(301), duplicate, item(302)])
  const fiveInput = { searchProofs: fiveProofs.proofs,
    observations: ['a', 'b', 'c'].map(key => observation(five, key)) }
  const result = compose(five.id, five.request, fiveInput)
  assert.equal(result.status, 'complete')
  assert.equal(result.finds.length, 5)
  assert.deepEqual(new Set(result.finds.filter(row => row.kind === 'zhihu').map(row => row.sourceUrl)), new Set([url(301), url(302)]))
  assert.equal(result.finds.filter(row => row.kind === 'moment').length, 1)

  const before = findRows(db)
  const forbidden = [get(five.cookie), get('', `?ownerId=${three.ownerId}`),
    get(three.cookie, `?session_id=${three.ownerId}`)]
  for (const request of forbidden) assert.equal(handleFindsRequest(request, three.id, () => db).status, 404)
  trips.finish(three.id, three.ownerId, 'done')
  await assert.rejects(search(three, [item(300)], () => assert.fail('terminal C5')), conflict)
  assert.throws(() => compose(three.id, three.request, { searchProofs: drift.proofs }), conflict)
  const read = (trip, database) => {
    const response = handleFindsRequest(trip.request, trip.id, () => database)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('vary'), 'Cookie')
    return response.json()
  }
  const previous = await Promise.all([read(three, db), read(five, db)])
  assert.deepEqual(findRows(db), before)
  db.close()
  const reopened = openDatabase(path)
  try { assert.deepEqual(await Promise.all([read(three, reopened), read(five, reopened)]), previous) }
  finally { reopened.close() }
})

test('unproven cache, fixture and legacy live labels stay historical and cannot make a batch complete', async t => {
  const { db, addTrip, compose, search } = fixture(t)
  const trip = addTrip('history-labels')
  const historical = db.prepare(`INSERT INTO find(id,trip_id,kind,title,source_mode,source_url,created_at)
    VALUES (?,?,'zhihu',?,?,?,?)`)
  for (const [index, mode] of ['cache', 'fixture', 'live'].entries()) {
    historical.run(mode, trip.id, mode, mode, url(400 + index), observed)
  }
  // A current live proof for an old cache/fixture URL cannot upgrade that stored row.
  const results = await search(trip, [item(400), item(401)])
  const saved = compose(trip.id, trip.request, { searchProofs: results.proofs, observations: [observation(trip, 'one')] })
  assert.equal(saved.status, 'partial')
  assert.deepEqual(saved.reasons, ['NO_REAL_ZHIHU', 'INSUFFICIENT_FACTS'])
  assert.deepEqual(saved.finds.map(row => row.kind), ['scene'])
  const history = createFindStore(db).list(trip.id, trip.ownerId)
  assert.deepEqual(history.map(row => row.sourceMode), ['cache', 'fixture', 'live', null])
  assert.equal(history.find(row => row.id === 'cache').createdAt, observed)
})

test('commit rejects terminal and revoked sessions, filters revised blocks, and reports missing historical topics', async t => {
  const { db, path, addTrip, compose, search } = fixture(t)
  pool(db)
  const blocked = addTrip('blocked'), revoked = addTrip('revoked'), ended = addTrip('ended')
  selectEvent(db, blocked)
  const second = openDatabase(path)
  try {
    const pending = await search(blocked, [item(501, 'new-policy'), item(502)], () => {
      assert.equal(db.isTransaction, false)
      second.prepare('UPDATE dog SET blocked_topics=? WHERE id=?')
        .run(JSON.stringify(['new-policy', '当前主题']), blocked.dogId)
    })
    const restricted = compose(blocked.id, blocked.request, { searchProofs: pending.proofs,
      observations: [{ ...observation(blocked, 'blocked-topic'), topics: ['当前主题'] }] })
    assert.deepEqual(restricted.finds.map(row => row.sourceUrl), [url(502)])
    assert.equal(restricted.eventOmission, 'EVENT_TOPICS_UNVERIFIABLE')
    const fact = readOccurrenceFact(db, blocked.id, blocked.dogId)
    second.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run(JSON.stringify([fact.text]), blocked.dogId)
    const textBlocked = compose(blocked.id, blocked.request, { searchProofs: [pending.proofs[1]] })
    assert.equal(textBlocked.eventOmission, undefined)
    assert.deepEqual(textBlocked.finds.map(row => row.kind), ['zhihu'])

    const revokedResult = await search(revoked, [item(503)], () => revokeSession(revoked.request, second))
    assert.throws(() => compose(revoked.id, revoked.request, { searchProofs: revokedResult.proofs }), missing)
    const endedResult = await search(ended, [item(504)], () => {
      createTripService(second, { now }).finish(ended.id, ended.ownerId, 'timeout')
    })
    assert.throws(() => compose(ended.id, ended.request, { searchProofs: endedResult.proofs }), conflict)
    assert.equal(findRows(db).length, 1)
  } finally { second.close() }
})

test('proof scope and insert failures are atomic; replay on a second connection keeps first stored values', async t => {
  const { db, path, addTrip, compose, search } = fixture(t)
  const trip = addTrip('atomic'), foreign = addTrip('atomic-foreign')
  assert.equal(selectEvent(db, trip, null), null)
  assert.deepEqual(compose(trip.id, trip.request).finds, [])
  const result = await search(trip, [item(601), item(602)])
  const wrongDog = (await searchForTrip({ tripId: trip.id, ownerId: trip.ownerId, dogId: foreign.dogId,
    query: '可核验资料', category: '自然风景', blockedTopics: [] }, controlledProvider([item(603)]))).proof
  for (const input of [{ searchProofs: [result.proof, { ...result.proof }] }, { searchProofs: [wrongDog] },
    { observations: [observation(foreign, 'cross-trip')] },
    { observations: [{ ...observation(trip, 'future'), happenedAt: '2026-11-26T00:00:00Z' }] }]) {
    assert.throws(() => compose(trip.id, trip.request, input), conflict)
    assert.deepEqual(findRows(db), [])
  }
  const inputs = { searchProofs: result.proofs, observations: [observation(trip, 'rollback')] }
  db.exec(`CREATE TRIGGER injected_fail BEFORE INSERT ON find WHEN NEW.kind='scene'
    BEGIN SELECT RAISE(ABORT, 'controlled batch write failure'); END`)
  assert.throws(() => compose(trip.id, trip.request, inputs), /controlled batch write failure/)
  assert.deepEqual(findRows(db), [])
  assert.equal(db.isTransaction, false)
  db.exec('DROP TRIGGER injected_fail')
  // Leave the batch partial so this exercises database reuse independently of the complete receipt.
  const saved = compose(trip.id, trip.request, { ...inputs, searchProofs: [result.proof] })
  const second = openDatabase(path)
  try {
    const retry = createTripDiscoveryComposer(second, { now: () => new Date('2026-11-25T00:03:00Z') })
    const searchAgain = createTripDiscoverySearch(second, controlledProvider([item(601, 'new response')]))
    const changed = await searchAgain(trip.id, trip.request)
    assert.deepEqual(retry(trip.id, trip.request, { searchProofs: changed.proofs,
      observations: [observation(trip, 'rollback', '新观察正文')] }), saved)
    assert.equal(findRows(second).length, 2)
  } finally { second.close() }
})
