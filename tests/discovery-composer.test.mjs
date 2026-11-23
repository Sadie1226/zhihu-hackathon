import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { createTripDiscoveryComposer } from '../lib/trips/composer.ts'
import { createTripDiscoverySearch } from '../lib/trips/discover.ts'
import { createFindStore, handleFindsRequest } from '../lib/trips/finds.ts'
import { createTripService } from '../lib/trips/service.ts'
import { createZhihuSearchClient } from '../lib/zhihu/client.ts'
import { fixtureSession } from './helpers/owner-session.mjs'

const started = '2026-11-23T00:00:00Z'
const observed = '2026-11-23T00:01:00Z'
const now = () => new Date('2026-11-23T00:02:00Z')
const url = id => `https://www.zhihu.com/question/123/answer/${id}`
const item = (id, title = `fixture article ${id}`) => ({
  Title: title, ContentText: 'fixture excerpt', Url: url(id), AuthorityLevel: '3', VoteUpCount: 1,
})
function fixture(t) {
  const root = resolve('.local/c6-composer-tests')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'case-'))
  const path = join(directory, 'app.sqlite')
  const db = openDatabase(path)
  t.after(() => {
    if (db.isOpen) db.close()
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  const first = fixtureSession(db), second = fixtureSession(db)
  const insertDog = db.prepare(`INSERT INTO dog(id,session_id,owner_id,personality_tags,assembly,created_at)
    VALUES(?,?,?,'["好奇","看物","直给"]','{"cloth":"hoodie","hat":null,"glasses":null,"face":"hopeful"}',?)`)
  const trips = createTripService(db, { now: () => new Date(started) })
  function addTrip(dogId, owner) {
    insertDog.run(dogId, owner.sessionId, owner.sessionId, started)
    const { id } = trips.create(dogId, owner.sessionId, 'auto')
    return { ...owner, cookie: owner.setCookie.split(';', 1)[0],
      ...trips.start(id, owner.sessionId).trip }
  }
  const trip = addTrip('own-dog', first), other = addTrip('other-dog', second)
  function observation(id, kind, title, selected = trip) {
    return { id, kind, title, excerpt: null, happenedAt: observed, tripId: selected.id, dogId: selected.dogId }
  }
  function event(id, text, selected, happenedAt = observed, dogId = selected?.dogId) {
    db.prepare(`INSERT INTO event(id,code,text,season,weather,time_of_day) VALUES(?,?,?,'any','any','any')`)
      .run(id, id, text)
    if (selected) db.prepare('INSERT INTO trip_event VALUES(?,?,?,?)').run(selected.id, id, dogId, happenedAt)
  }
  function search(items, selected = trip, beforeResponse = () => {}) {
    // Exercise the existing C5 parser, with synthetic responses and no external IO.
    const provider = createZhihuSearchClient({ accessSecret: 'offline-fixture', now: () => now().valueOf(),
      fetch: async () => {
        beforeResponse()
        return Response.json({ Code: 0, Data: { Items: items } })
      } })
    return createTripDiscoverySearch(db, provider)(selected.id, selected.sessionId)
  }
  const compose = createTripDiscoveryComposer(db, { now })
  const history = () => createFindStore(db).list(trip.id, trip.sessionId)
  return { db, path, trips, trip, other, compose, history, observation, event, search }
}

test('multiple C5 proofs, trusted scenes and observed events produce a bounded, repeatable batch; history survives restart', async t => {
  const { db, path, trip, other, compose, observation, event, search, trips } = fixture(t)
  event('occurred', '本趟实际事件', trip)
  event('pool-only', '事件池未发生', null)
  event('other-event', '另一趟事件', other)
  const duplicate = { ...item(101), Url: url(101) + '/?utm_medium=link' }
  const results = await search([item(101), duplicate, item(102)])
  const observations = [
    observation('scene-a', 'scene', '本趟场景甲'),
    observation('scene-b', 'scene', '本趟场景乙'),
    observation('moment-a', 'moment', '本趟已发生片段'),
  ]
  observations.push({ ...observations[0] })
  const saved = compose(trip.id, trip.sessionId, { searchProofs: results.proofs, observations })
  assert.equal(saved.status, 'complete')
  assert.deepEqual(saved.reasons, [])
  assert.equal(saved.finds.length, 5)
  assert.equal(saved.finds[0].sourceMode, 'live') // C5 protocol simulation only.
  assert.deepEqual(new Set(saved.finds.filter(row => row.kind === 'zhihu').map(row => row.sourceUrl)), new Set([url(101), url(102)]))
  assert.ok(saved.finds.some(row => row.kind === 'scene'))
  assert.ok(saved.finds.some(row => row.title === '本趟实际事件'))
  assert.ok(saved.finds.filter(row => row.kind !== 'zhihu').every(row => row.sourceMode === null && row.sourceUrl === null))
  assert.ok(!saved.finds.some(row => row.title === '事件池未发生' || row.title === '另一趟事件'))
  const changed = await search([item(101, 'updated upstream metadata')])
  assert.deepEqual(compose(trip.id, trip.sessionId, { searchProofs: changed.proofs, observations: observations.toReversed() }), saved)
  assert.equal(db.prepare('SELECT count(*) n FROM find').get().n, 5)
  const fetch = (cookie, database) => handleFindsRequest(new Request(`http://localhost/api/trips/${trip.id}/finds`, {
    headers: { cookie },
  }), trip.id, () => database)
  assert.equal(fetch(other.cookie, db).status, 404)
  const finished = trips.finish(trip.id, trip.sessionId, 'done')
  assert.equal(finished.message, null)
  assert.equal(finished.finds.length, 5)
  const otherProofs = (await search([item(101)], other)).proofs
  const separate = compose(other.id, other.sessionId, {
    searchProofs: otherProofs, observations: [observation('scene-a', 'scene', '另一趟自己的场景', other)],
  })
  assert.equal(separate.status, 'complete')
  assert.equal(separate.finds.length, 3)
  assert.ok(separate.finds.every(row => row.tripId === other.id && !saved.finds.some(own => own.id === row.id)))
  const prior = await fetch(trip.cookie, db).json()
  db.close()
  const reopened = openDatabase(path)
  try { assert.deepEqual(await fetch(trip.cookie, reopened).json(), prior) }
  finally { reopened.close() }
})

test('insufficient facts stay partial, leave capacity for one verified source and preserve cache and fixture labels', async t => {
  const { db, trip, other, compose, observation, search } = fixture(t)
  assert.deepEqual(compose(trip.id, trip.sessionId), {
    status: 'partial', finds: [], reasons: ['NO_REAL_ZHIHU', 'INSUFFICIENT_FACTS'],
  })
  const observations = Array.from({ length: 5 }, (_, i) => observation(`fact-${i}`, 'scene', `场景 ${i}`))
  const partial = compose(trip.id, trip.sessionId, { observations })
  assert.equal(partial.finds.length, 4)
  assert.deepEqual(partial.reasons, ['NO_REAL_ZHIHU'])
  const result = await search([item(201)])
  const complete = compose(trip.id, trip.sessionId, { searchProofs: result.proofs, observations })
  assert.equal(complete.status, 'complete')
  assert.equal(complete.finds.length, 5)
  assert.equal(complete.finds[0].sourceUrl, url(201))
  db.prepare(`INSERT INTO find(id,trip_id,kind,title,source_mode,source_url,created_at)
    VALUES ('previous-cache',?,'zhihu','已存缓存','cache',?,?)`).run(other.id, url(301), observed)
  createFindStore(db, { now }).write({ tripId: other.id, kind: 'zhihu', title: '历史夹具', excerpt: null,
    sourceUrl: url(302), sourceMode: 'fixture', authorityLevel: null, voteUpCount: null, assetPath: null }, other.sessionId)
  const cached = compose(other.id, other.sessionId, { observations: [observation('one', 'scene', '一个场景', other)] })
  assert.equal(cached.status, 'partial')
  assert.deepEqual(cached.reasons, ['INSUFFICIENT_FACTS'])
  assert.deepEqual(cached.finds.map(row => row.sourceMode), ['cache', null, 'fixture'])
})

test('commit rechecks latest blocks and only accepts events belonging to this trip and dog within its time window', async t => {
  const { db, trip, other, compose, observation, event, search } = fixture(t)
  const result = await search([item(401, '新屏蔽关键词'), item(402, '符合的来源')])
  db.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run('["新屏蔽","城市角落"]', trip.dogId)
  event('valid', '真实同趟事件', trip)
  event('early', '出发前事件', trip, '2026-11-22T23:00:00Z')
  event('future', '未来事件', trip, '2026-11-23T01:00:00Z')
  event('wrong-dog', '错误伙伴事件', trip, observed, other.dogId)
  event('blocked-by-tag', '场景标题没有关键词', trip)
  db.prepare("UPDATE event SET match_tags='[\"城市角落\"]' WHERE id='blocked-by-tag'").run()
  const observations = [observation('blocked-text', 'moment', '新屏蔽片段'),
    { ...observation('blocked-topic', 'scene', '这是真场景'), topics: ['城市角落'] }]
  const saved = compose(trip.id, trip.sessionId, { searchProofs: result.proofs, observations })
  assert.deepEqual(saved.finds.map(row => row.title), ['符合的来源', '真实同趟事件'])
  assert.deepEqual(saved.reasons, ['INSUFFICIENT_FACTS'])
  assert.equal(db.prepare('SELECT count(*) n FROM trip_event').get().n, 5)
  db.prepare("UPDATE event SET match_tags='[\"城市角落\"]' WHERE id='valid'").run()
  assert.deepEqual(compose(trip.id, trip.sessionId).finds.map(row => row.title), ['符合的来源'])
  assert.equal(db.prepare('SELECT count(*) n FROM find').get().n, 2)
})

test('foreign, forged and invalid inputs fail closed and any insert failure rolls back the batch', async t => {
  const { db, trip, other, compose, observation, search, history } = fixture(t)
  const own = await search([item(501), item(502)])
  const foreign = await search([item(503)], other)
  assert.throws(() => compose(trip.id, other.sessionId), { code: 'NOT_FOUND' })
  for (const input of [
    { searchProofs: [...own.proofs, ...foreign.proofs] },
    { searchProofs: [...own.proofs, { ...own.proof }] },
    { observations: [observation('wrong', 'scene', '来自别趟', other)] },
    { observations: [{ ...observation('future', 'moment', '未来'), happenedAt: '2026-11-24T00:00:00Z' }] },
  ]) {
    assert.throws(() => compose(trip.id, trip.sessionId, input), { code: 'CONFLICT' })
    assert.deepEqual(history(), [])
  }
  db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON find WHEN NEW.source_url='${url(502)}'
    BEGIN SELECT RAISE(ABORT,'fixture insertion failed'); END`)
  assert.throws(() => compose(trip.id, trip.sessionId, { searchProofs: own.proofs }), /fixture insertion failed/)
  assert.deepEqual(history(), [])
  db.exec('DROP TRIGGER fail_second')
  assert.equal(compose(trip.id, trip.sessionId, { searchProofs: own.proofs }).finds.length, 2)
})

test('a second SQLite connection can finish during C5 and the final batch writes nothing', async t => {
  const { path, trip, compose, history, observation, search } = fixture(t)
  const result = await search([item(601)], trip, () => {
    const otherConnection = openDatabase(path)
    try { createTripService(otherConnection, { now }).finish(trip.id, trip.sessionId, 'timeout') }
    finally { otherConnection.close() }
  })
  assert.equal(result.ok, true)
  assert.throws(() => compose(trip.id, trip.sessionId, {
    searchProofs: result.proofs, observations: [observation('scene', 'scene', '已经失效的场景写入')],
  }), { code: 'CONFLICT' })
  assert.deepEqual(history(), [])
})
