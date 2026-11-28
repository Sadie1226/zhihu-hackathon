import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { revokeSession } from '../lib/auth/session.ts'
import { createTripExecutor } from '../lib/trips/executor.ts'
import { createTripDiscoverySearch } from '../lib/trips/discover.ts'
import { createTripDiscoveryComposer } from '../lib/trips/composer.ts'
import { createTripService } from '../lib/trips/service.ts'
import { createTripReturn } from '../lib/trips/return.ts'
import { eligibleSearchInput } from '../lib/trips/search-proof.ts'
import { ownerDiscoveryIntent } from '../lib/trips/discovery-receipt.ts'
import { createMemorySearchCache } from '../lib/trips/search-cache.ts'
import { mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'

const day = 86400000
const url = id => `https://www.zhihu.com/question/${id}`
const article = (id, title) => ({ title, excerpt: null, sourceUrl: url(id), sourceMode: 'live',
  authorityLevel: null, voteUpCount: null })
const pool = [article(101, '植物叶片观察'), article(102, '陶器拉坯工具'), article(103, '山川日落记录'),
  article(104, '酵母与发酵温度'), article(105, '店主采访'), article(106, '街边记录')]
const req = owner => new Request('https://local.test/trips', { headers: { cookie: owner.cookie } })
const observations = ({ trip }) => [1, 2].map(id => ({ id: String(id), tripId: trip.id, dogId: trip.dogId,
  kind: 'scene', title: `开发场景${id}`, excerpt: null, topics: [], happenedAt: trip.startedAt }))

async function fixture(t) {
  const { db, path } = mailboxDatabase(t)
  const clock = { at: Date.parse('2026-11-20T02:00:00.000Z') }
  const now = () => new Date(clock.at)
  const owner = ownedDog(db, 'learning-dog')
  const control = ownedDog(db, 'control-dog')
  const service = createTripService(db, { now })
  const calls = []
  const run = (who, items, experience = true) => createTripExecutor(db, { now, experience,
    ownerObservations: observations, provider: async (_query, count) => {
      calls.push(count)
      return { ok: true, httpStatus: 200, fetchedAt: now().toISOString(), items }
    } }).owner({ dogId: who.id, request: req(who), action: 'create' })
  for (let index = 0; index < 3; index++) {
    const result = await run(owner, [article(200 + index, `酵母发酵实验${index}`)], false)
    assert.equal(result.status, 'complete')
    clock.at += 600000
    service.finish(result.trip.id, owner.sessionId, 'done')
    clock.at += day
  }
  return { db, path, clock, now, owner, control, service, calls, run }
}

test('same dog zero-trip versus three done trips changes persistent Find set with exactly the same candidates', async t => {
  const { db } = mailboxDatabase(t)
  const owner = ownedDog(db, 'same-dog-control')
  let at = Date.parse('2026-11-10T02:00:00.000Z')
  const now = () => new Date(at)
  const service = createTripService(db, { now })
  const run = items => createTripExecutor(db, { now, ownerObservations: observations,
    provider: async () => ({ ok: true, httpStatus: 200, fetchedAt: now().toISOString(), items }) })
    .owner({ dogId: owner.id, request: req(owner), action: 'create' })
  const before = await run(pool)
  assert.equal(before.status, 'complete')
  assert.ok(!before.finds.some(row => row.sourceUrl === url(104)))
  // Retain this control batch as failed so it is not a positive learning event.
  service.finish(before.trip.id, owner.sessionId, 'failed')
  for (let index = 0; index < 3; index++) {
    at += day
    const done = await run([article(800 + index, `酵母发酵观察${index}`)])
    service.finish(done.trip.id, owner.sessionId, 'done')
  }
  at += day
  const after = await run(pool)
  assert.equal(after.status, 'complete')
  assert.ok(after.finds.some(row => row.sourceUrl === url(104)))
  assert.equal(db.prepare("SELECT count(*) n FROM trip WHERE dog_id=? AND status='done'").get(owner.id).n, 3)
  assert.equal(db.prepare('SELECT personality_tags FROM dog WHERE id=?').get(owner.id).personality_tags,
    '["好奇","看物","直给"]')
})

test('three completed SQLite trips change actual Find membership and persisted Message reference; control dog and cold replay', async t => {
  const f = await fixture(t)
  const { db, run, owner, control, clock, now, path, calls } = f
  const old = JSON.stringify(db.prepare('SELECT * FROM snapshot ORDER BY dog_id,version').all())
  const baseline = await run(control, pool)
  const learned = await run(owner, pool)
  assert.equal(learned.status, 'complete')
  const sources = result => result.finds.filter(row => row.kind === 'zhihu').map(row => row.sourceUrl)
  assert.ok(!sources(baseline).includes(url(104)))
  assert.ok(sources(learned).includes(url(104)))
  assert.ok(sources(learned).some(source => source !== url(104)))
  assert.equal(learned.finds.length, 5)
  assert.equal(calls.at(-1), 6)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8)
  clock.at += 600000
  // Explicit controlled B5 adapter: the test proves selection->Find->Message, not a real model provider.
  const returned = await createTripReturn(db, { now, generationTimeoutMs: 1000,
    generate: async ({ finds }) => {
      const find = finds.find(row => row.sourceUrl === url(104))
      return { text: `我读到《${find.title}》。`, mentionsFindId: find.id }
    },
    writeMessageInTransaction(connection, target, draft) {
      assert.equal(connection.isTransaction, true)
      assert.ok(target.allowedFindIds.includes(draft.mentionsFindId))
      connection.prepare('INSERT INTO message(id,trip_id,text,mentions_find_id,created_at) VALUES(?,?,?,?,?)')
        .run(target.id, target.tripId, draft.text, draft.mentionsFindId, target.createdAt)
    },
  }).owner({ dogId: owner.id, tripId: learned.trip.id, request: req(owner) })
  assert.equal(returned.status, 'confirmed')
  const reference = db.prepare('SELECT source_url FROM find WHERE id=?').get(returned.message.mentionsFindId)
  assert.equal(reference.source_url, url(104))
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM snapshot WHERE dog_id=? AND version<=3 ORDER BY dog_id,version').all(owner.id)), old)
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { openDatabase } from './lib/db/bootstrap.ts';
    import { createTripReturn } from './lib/trips/return.ts';
    const input=JSON.parse(process.argv[1]); const db=openDatabase(input.path);
    try { const result=await createTripReturn(db,{generationTimeoutMs:1000,
      generate:()=>{throw Error('must not generate')},writeMessageInTransaction:()=>{throw Error('must not write')}})
      .owner({dogId:input.dogId,tripId:input.tripId,request:new Request('https://local.test/',{headers:{cookie:input.cookie}})});
      console.log(JSON.stringify(result)); } finally { db.close(); }
  `, JSON.stringify({ path, dogId: owner.id, cookie: owner.cookie, tripId: learned.trip.id })],
  { encoding: 'utf8', windowsHide: true })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(JSON.parse(child.stdout).message.id, returned.message.id)
  assert.equal(JSON.parse(child.stdout).replayed, true)
  console.log('A7_REPLAY_EVIDENCE ' + JSON.stringify({ fixtureOnly: true, sameCandidatePool: pool.map(row => row.sourceUrl),
    completedHistoryTrips: 3, controlFinds: sources(baseline), learnedFinds: sources(learned),
    messageReference: reference.source_url, coldReplaySameMessage: true, searchRequested: calls.at(-1),
    persistedFinds: learned.finds.length, schema: 8, realModel: false }))
})

test('history or profile changed during external search cannot produce accepted proofs; revocation rejects commit', async t => {
  const { db, owner, service, now } = await fixture(t)
  const trip = service.start(service.create(owner.id, owner.sessionId, 'auto').id, owner.sessionId).trip
  const result = await createTripDiscoverySearch(db, async () => {
    db.prepare('UPDATE dog SET personality_tags=? WHERE id=?').run('["好奇","看人","直给"]', owner.id)
    return { ok: true, httpStatus: 200, fetchedAt: now().toISOString(), items: pool }
  }, { now })(trip.id, req(owner))
  assert.equal(result.ok, false)
  const current = await createTripDiscoverySearch(db, async () => ({ ok: true, httpStatus: 200,
    fetchedAt: now().toISOString(), items: pool }), { now })(trip.id, req(owner))
  assert.equal(current.ok, true)
  const execution = { tripId: trip.id, dogId: owner.id, ownerId: owner.sessionId,
    intentId: ownerDiscoveryIntent(trip.id) }
  // A proof is valid before the actual change; this is not a test of an unrelated wrong intent.
  assert.ok(eligibleSearchInput(current.proof, execution, [], now().toISOString()))
  db.prepare('UPDATE dog SET personality_tags=? WHERE id=?').run('["好奇","看物","直给"]', owner.id)
  assert.throws(() => createTripDiscoveryComposer(db, { now })(trip.id, req(owner), { searchProofs: current.proofs }), { code: 'CONFLICT' })
  assert.equal(db.prepare('SELECT count(*) n FROM find WHERE trip_id=?').get(trip.id).n, 0)
  db.prepare('UPDATE dog SET personality_tags=? WHERE id=?').run('["好奇","看人","直给"]', owner.id)
  revokeSession(req(owner), db)
  assert.throws(() => eligibleSearchInput(current.proof, execution, [], now().toISOString()), { code: 'NOT_FOUND' })
  assert.throws(() => createTripDiscoveryComposer(db, { now })(trip.id, req(owner), { searchProofs: current.proofs }), { code: 'NOT_FOUND' })
})

test('raw cache remains isolated by owner; explicit wish bypasses growth', async t => {
  const { db, owner, control, service, now, clock } = await fixture(t)
  const cache = createMemorySearchCache()
  const start = who => service.start(service.create(who.id, who.sessionId, 'auto').id, who.sessionId).trip
  const liveTrip = start(owner)
  const live = await createTripDiscoverySearch(db, async (_query, count) => {
    assert.equal(count, 6)
    return { ok: true, httpStatus: 200, fetchedAt: now().toISOString(), items: pool }
  }, { now, cache })(liveTrip.id, req(owner))
  assert.equal(live.ok, true)
  // A second session for the same owner may share raw cache; a different owner's cache cannot leak.
  const otherTrip = start(control)
  const unavailable = async () => ({ ok: false, httpStatus: 401, error: { code: 'AUTH', detail: '开发响应', retriable: false }, alert: true })
  const miss = await createTripDiscoverySearch(db, unavailable, { now, cache })(otherTrip.id, req(control))
  assert.equal(miss.ok, true)
  assert.equal(miss.proofs.length, 0)
  db.prepare('INSERT INTO wish(id,dog_id,text,category,created_at) VALUES(?,?,?,?,?)')
    .run('explicit-wish', owner.id, '想看发酵过程', '手作与食物', now().toISOString())
  service.finish(liveTrip.id, owner.sessionId, 'failed')
  clock.at += 6 * 60 * 60 * 1000
  const wish = service.start(service.create(owner.id, owner.sessionId, 'wish').id, owner.sessionId).trip
  const selected = await createTripDiscoverySearch(db, async (query, count) => {
    assert.equal(query, '想看发酵过程'); assert.equal(count, 3)
    return { ok: true, httpStatus: 200, fetchedAt: now().toISOString(), items: pool.slice(0, 3) }
  }, { now })(wish.id, req(owner))
  assert.equal(selected.ok, true)
  assert.equal(selected.proofs.length, 3)
})

test('changed historical evidence after search aborts the write; confirmed discovery replays without reselecting', async t => {
  const { db, owner, service, now, run, clock } = await fixture(t)
  const confirmed = await run(owner, pool)
  const rows = JSON.stringify(db.prepare('SELECT * FROM find WHERE trip_id=? ORDER BY id').all(confirmed.trip.id))
  db.prepare('UPDATE dog SET personality_tags=? WHERE id=?').run('["好奇","看人","直给"]', owner.id)
  const replay = await createTripExecutor(db, { now, provider: () => { throw Error('must not re-search') } }).owner({
    action: 'resume', dogId: owner.id, tripId: confirmed.trip.id, request: req(owner), retryDiscovery: true })
  assert.equal(replay.confirmation.replayed, true)
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM find WHERE trip_id=? ORDER BY id').all(confirmed.trip.id)), rows)
  service.finish(confirmed.trip.id, owner.sessionId, 'done')
  clock.at += 6 * 60 * 60 * 1000
  const current = service.start(service.create(owner.id, owner.sessionId, 'auto').id, owner.sessionId).trip
  const search = await createTripDiscoverySearch(db, async () => ({ ok: true, httpStatus: 200,
    fetchedAt: now().toISOString(), items: pool }), { now })(current.id, req(owner))
  assert.equal(search.ok, true)
  const historic = db.prepare("SELECT f.id FROM find f JOIN trip t ON t.id=f.trip_id WHERE t.dog_id=? AND t.seq=1 AND f.kind='zhihu'").get(owner.id)
  db.prepare('UPDATE find SET title=? WHERE id=?').run('改变了的历史原文', historic.id)
  assert.throws(() => createTripDiscoveryComposer(db, { now })(current.id, req(owner), { searchProofs: search.proofs }), { code: 'CONFLICT' })
  assert.equal(db.prepare('SELECT count(*) n FROM find WHERE trip_id=?').get(current.id).n, 0)
})
