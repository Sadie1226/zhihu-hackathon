import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { revokeSession } from '../lib/auth/session.ts'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { createTripEventSelector } from '../lib/events/select.ts'
import { createTripDiscoveryComposer } from '../lib/trips/composer.ts'
import { createTripDiscoverer, createTripDiscoverySearch } from '../lib/trips/discover.ts'
import { handleFindsRequest } from '../lib/trips/finds.ts'
import { createTripService } from '../lib/trips/service.ts'
import { createZhihuSearchClient } from '../lib/zhihu/client.ts'
import { mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'

const startedAt = '2026-11-25T02:00:00.000Z'
const at = '2026-11-25T02:02:00.000Z'
const later = '2026-11-25T02:04:00.000Z'
const now = () => new Date(at)
const intentId = 'owner-execution-1'
const query = '主人私有测试心愿'
const topic = '保留的观察主题'
const invalid = { code: 'DISCOVERY_RECEIPT_INVALID', message: 'Invalid stored discovery receipt' }
const missing = { code: 'NOT_FOUND' }
const conflict = { code: 'CONFLICT' }
const rowset = (db, tripId) => db.prepare('SELECT * FROM find WHERE trip_id=? ORDER BY id').all(tripId)
const receipt = (db, tripId) => db.prepare('SELECT * FROM trip_discovery_receipt WHERE trip_id=?').get(tripId)

function fixture(t) {
  const { db, path } = mailboxDatabase(t)
  const owner = ownedDog(db, 'receipt-dog')
  db.prepare('INSERT INTO wish(id,dog_id,text,category,created_at) VALUES (?, ?, ?, ?, ?)')
    .run('private-wish-1', owner.id, query, '自然风景', startedAt)
  const trips = createTripService(db, { now: () => new Date(startedAt) })
  const trip = trips.create(owner.id, owner.sessionId, 'wish')
  trips.start(trip.id, owner.sessionId)
  const request = new Request('http://localhost/api/trips/demo/finds', { headers: { cookie: owner.cookie } })
  const observations = ['a', 'b'].map(id => ({
    id, tripId: trip.id, dogId: owner.id, kind: 'scene', title: `已核验场景 ${id}`, excerpt: null,
    happenedAt: startedAt, topics: id === 'a' ? [topic] : [],
  }))
  const compose = createTripDiscoveryComposer(db, { now })
  const setBlocks = topics => db.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run(JSON.stringify(topics), owner.id)
  const selectEvent = () => {
    db.exec(readFileSync('team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql', 'utf8'))
    db.exec("UPDATE event SET enabled = (code = 'any_shop_cat')")
    return createTripEventSelector(db, { now, random: () => 0 })({
      tripId: trip.id, dogId: owner.id, sessionId: owner.sessionId,
      conditions: { sceneFile: 'scenes/nantou.png', season: 'spring', weather: 'clear', timeOfDay: 'morning' },
    })
  }
  function newSearch(beforeResponse) {
    let calls = 0
    const provider = createZhihuSearchClient({ accessSecret: 'receipt-synthetic-fixture', now: () => Date.parse(at),
      fetch: async () => {
        calls++
        await beforeResponse?.()
        return Response.json({ Code: 0, Data: { Items: [{
          Title: '受控知乎资料', ContentText: '受控摘要', Url: 'https://www.zhihu.com/question/123/answer/901',
          AuthorityLevel: '3', VoteUpCount: 1,
        }] } })
      } })
    const search = createTripDiscoverySearch(db, provider, { now })
    return { search, get calls() { return calls } }
  }
  async function complete(observed = observations) {
    const result = await newSearch().search(trip.id, request, intentId)
    assert.equal(result.ok, true)
    const completed = compose(trip.id, request, { intentId, observations: observed, searchProofs: result.proofs })
    assert.equal(completed.status, 'complete')
    assert.ok(completed.confirmation)
    return completed
  }
  return { db, path, owner, trip, request, observations, compose, setBlocks, selectEvent, newSearch, complete }
}

function launch(t, f, options = {}) {
  const child = fork(fileURLToPath(new URL('./helpers/discovery-receipt-process.mjs', import.meta.url)), [],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [], windowsHide: true })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const exit = once(child, 'exit')
  let searchMessage
  const searching = new Promise(resolve => { searchMessage = resolve })
  let result
  child.on('message', message => {
    if (message.phase === 'searching') searchMessage(message)
    if (message.phase === 'done') result = message
  })
  child.send({ path: f.path, tripId: f.trip.id, cookie: f.owner.cookie,
    intentId, at, candidateIds: [901], observations: f.observations, ...options })
  return {
    async searching() {
      return Promise.race([searching, exit.then(([code]) => assert.fail(`Child exited before barrier (${code}): ${stderr}`))])
    },
    release() { child.send('release') },
    async result() {
      const [code, signal] = await exit
      assert.deepEqual([code, signal], [0, null], stderr)
      assert.ok(result, 'The child must send a result before exiting')
      return result
    },
  }
}

test('A1 two sequential OS processes retain the first receipt and skip the second provider', { timeout: 15000 }, async t => {
  const f = fixture(t)
  const first = await launch(t, f).result()
  assert.equal(first.providerCalls, 1)
  assert.equal(first.composition.status, 'complete')
  assert.deepEqual(first.composition.confirmation, { completedAt: at, replayed: false, visibilityReasons: [] })
  assert.equal(first.count, 3)
  assert.equal(first.receipts.length, 1)
  const members = JSON.parse(first.receipts[0].members_json)
  assert.deepEqual(members.map(item => item[0]), first.composition.finds.map(row => row.id))
  assert.ok(members.every(item => /^[0-9a-f]{64}$/.test(item[1])))

  f.db.close()
  const second = await launch(t, f, { at: later, candidateIds: [902, 903] }).result()
  assert.equal(second.providerCalls, 0)
  assert.equal(second.count, first.count)
  assert.deepEqual(second.receipts, first.receipts)
  assert.deepEqual(second.composition, { ...first.composition,
    confirmation: { ...first.composition.confirmation, replayed: true } })
})

test('A2 both OS processes reach a provider barrier, then only one commits its candidate set', { timeout: 15000 }, async t => {
  const f = fixture(t)
  const a = launch(t, f, { hold: true, candidateIds: [901] })
  const b = launch(t, f, { hold: true, candidateIds: [904] })
  const [pa, pb] = await Promise.all([a.searching(), b.searching()])
  assert.notEqual(pa.pid, pb.pid)
  assert.notEqual(pa.pid, process.pid)
  assert.notEqual(pb.pid, process.pid)
  assert.deepEqual([pa.transaction, pb.transaction], [false, false])
  assert.deepEqual([pa.candidateIds, pb.candidateIds], [[901], [904]])
  a.release()
  b.release()
  const results = await Promise.all([a.result(), b.result()])
  assert.deepEqual(results.map(value => value.providerCalls), [1, 1])
  assert.deepEqual(results.map(value => value.count), [3, 3])
  assert.ok(results.every(value => value.composition.status === 'complete'))
  const winner = results.find(value => !value.composition.confirmation.replayed)
  const loser = results.find(value => value.composition.confirmation.replayed)
  assert.ok(winner && loser)
  assert.deepEqual(winner.composition.finds, loser.composition.finds)
  assert.deepEqual(winner.receipts, loser.receipts)
  assert.equal(winner.receipts.length, 1)
  const rows = rowset(f.db, f.trip.id)
  assert.deepEqual(rows.map(row => row.id).sort(), winner.composition.finds.map(row => row.id).sort())
  const urls = rows.flatMap(row => row.source_url ?? [])
  assert.deepEqual(urls, [winner.composition.finds.find(row => row.kind === 'zhihu').sourceUrl])
  assert.equal(f.db.prepare('SELECT count(*) n FROM trip_discovery_receipt').get().n, 1)
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('A3 a different server intent conflicts both before and after the concurrent provider', { timeout: 15000 }, async t => {
  const f = fixture(t)
  const rival = launch(t, f, { hold: true, intentId: 'rival-intent', candidateIds: [905] })
  assert.equal((await rival.searching()).transaction, false)
  const first = await launch(t, f).result()
  assert.equal(first.composition.status, 'complete')
  rival.release()
  const raced = await rival.result()
  assert.equal(raced.providerCalls, 1)
  assert.equal(raced.error.code, 'CONFLICT')
  const next = await launch(t, f, { intentId: 'rival-intent', candidateIds: [906] }).result()
  assert.equal(next.providerCalls, 0)
  assert.equal(next.error.code, 'CONFLICT')
  assert.equal(receipt(f.db, f.trip.id).intent_id, intentId)
  assert.equal(receipt(f.db, f.trip.id).receipt_hash, first.receipts[0].receipt_hash)
  assert.equal(rowset(f.db, f.trip.id).length, 3)
})

test('an opaque search proof also binds the original execution intent before confirmation', async t => {
  const f = fixture(t)
  const result = await f.newSearch().search(f.trip.id, f.request, intentId)
  assert.equal(result.proofs.length, 1)
  assert.throws(() => f.compose(f.trip.id, f.request, {
    intentId: 'unrelated', observations: f.observations, searchProofs: result.proofs,
  }), conflict)
  assert.deepEqual(rowset(f.db, f.trip.id), [])
})

const faults = [
  ['B1 Find INSERT', "CREATE TRIGGER test_failure BEFORE INSERT ON find WHEN NEW.kind='scene' " +
    "BEGIN SELECT RAISE(ABORT,'injected Find failure'); END;", 'DROP TRIGGER test_failure', /injected Find failure/],
  ['B2 receipt INSERT after three additional Finds', `CREATE TRIGGER test_failure BEFORE INSERT ON trip_discovery_receipt
    WHEN (SELECT count(*) FROM find WHERE trip_id=NEW.trip_id)=4
    BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;`, 'DROP TRIGGER test_failure', /injected receipt failure/],
  ['B3 actual COMMIT with a deferred foreign key', `CREATE TABLE test_failure(trip_id TEXT REFERENCES trip(id)
      DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER test_receipt_commit AFTER INSERT ON trip_discovery_receipt
      BEGIN INSERT INTO test_failure VALUES('missing-trip'); END;`,
    'DROP TRIGGER test_receipt_commit; DROP TABLE test_failure;', /FOREIGN KEY/],
]
for (const [label, setup, teardown, expected] of faults) {
  test(`${label} rolls back newly written rows and supports retry`, async t => {
    const f = fixture(t)
    f.db.prepare("INSERT INTO find(id,trip_id,kind,title,created_at) VALUES('old',?,'scene','历史场景',?)")
      .run(f.trip.id, startedAt)
    const old = rowset(f.db, f.trip.id)
    const results = await f.newSearch().search(f.trip.id, f.request, intentId)
    const input = { intentId, observations: f.observations, searchProofs: results.proofs }
    f.db.exec(setup)
    assert.throws(() => f.compose(f.trip.id, f.request, input), expected)
    assert.equal(f.db.isTransaction, false)
    assert.deepEqual(rowset(f.db, f.trip.id), old)
    assert.equal(receipt(f.db, f.trip.id), undefined)
    if (label.startsWith('B3')) assert.equal(f.db.prepare('SELECT count(*) n FROM test_failure').get().n, 0)
    f.db.exec(teardown)
    assert.equal(f.compose(f.trip.id, f.request, input).status, 'complete')
    assert.equal(rowset(f.db, f.trip.id).length, 4)
    assert.ok(receipt(f.db, f.trip.id))
  })
}

const damageReceipt = (db, tripId, field, value) => {
  db.exec('DROP TRIGGER trip_discovery_receipt_v8_no_update; PRAGMA ignore_check_constraints=ON')
  db.prepare(`UPDATE trip_discovery_receipt SET ${field}=? WHERE trip_id=?`).run(value, tripId)
  db.exec('PRAGMA ignore_check_constraints=OFF')
}
const damageMembers = (f, update) => {
  const members = JSON.parse(receipt(f.db, f.trip.id).members_json)
  update(members)
  damageReceipt(f.db, f.trip.id, 'members_json', JSON.stringify(members))
}

const corruption = [
  ['C1 missing Find', f => f.db.prepare('DELETE FROM find WHERE trip_id=? AND kind=\'zhihu\'').run(f.trip.id)],
  ['C2 altered body', f => f.db.prepare("UPDATE find SET title='改写正文' WHERE trip_id=?").run(f.trip.id)],
  ['C3 altered provenance', f => f.db.prepare("UPDATE find SET source_mode='cache' WHERE trip_id=? AND kind='zhihu'").run(f.trip.id)],
  ['C4 cross-Trip Find', f => {
    const service = createTripService(f.db, { now })
    const other = ownedDog(f.db, 'other-dog')
    const foreign = service.create(other.id, other.sessionId, 'auto')
    f.db.prepare("UPDATE find SET trip_id=? WHERE trip_id=? AND kind='zhihu'").run(foreign.id, f.trip.id)
  }],
  ['C5 invalid receipt JSON', f => damageReceipt(f.db, f.trip.id, 'members_json', '{')],
  ['C6 unknown hash rules', f => damageReceipt(f.db, f.trip.id, 'hash_version', 2)],
  ['C7 missing private filter', f => damageMembers(f, members => members[0].pop())],
  ['C7 corrupted private filter', f => damageMembers(f, members => { members[0][2] = ['search', 'changed', '自然风景'] })],
  ['C8 duplicate member', f => damageMembers(f, members => { members[1] = members[0] })],
  ['C8 changed member order', f => damageMembers(f, members => members.reverse())],
  ['C8 invalid member count', f => damageMembers(f, members => members.pop())],
]
for (const [label, damage] of corruption) {
  test(`${label} fails closed before search and under the write lock`, async t => {
    const f = fixture(t)
    await f.complete()
    damage(f)
    const bad = receipt(f.db, f.trip.id)
    const before = rowset(f.db, f.trip.id)
    const attempt = f.newSearch()
    await assert.rejects(attempt.search(f.trip.id, f.request, intentId), invalid)
    assert.equal(attempt.calls, 0)
    assert.throws(() => f.compose(f.trip.id, f.request, { intentId, observations: f.observations }), invalid)
    assert.deepEqual(receipt(f.db, f.trip.id), bad)
    assert.deepEqual(rowset(f.db, f.trip.id), before)
  })
}

test('D1-D3 unauthorized replay fails before receipt access for revoked and foreign owners', async t => {
  const f = fixture(t)
  await f.complete()
  const other = ownedDog(f.db, 'unrelated')
  const foreign = new Request('http://localhost', { headers: { cookie: other.cookie } })
  const service = createTripService(f.db, { now })
  const otherTrip = service.create(other.id, other.sessionId, 'auto')
  const attempt = f.newSearch()
  await assert.rejects(attempt.search(otherTrip.id, f.request, intentId), missing)
  await assert.rejects(attempt.search(f.trip.id, foreign, intentId), missing)
  assert.throws(() => f.compose(f.trip.id, foreign, { intentId }), missing)
  revokeSession(f.request, f.db)
  damageReceipt(f.db, f.trip.id, 'members_json', '{}')
  await assert.rejects(attempt.search(f.trip.id, f.request, intentId), missing)
  assert.throws(() => f.compose(f.trip.id, f.request, { intentId }), missing)
  assert.equal(attempt.calls, 0)
})

test('D4-D7 current rules filter without reopening completion and never infer frozen event labels', async t => {
  const f = fixture(t)
  const event = f.selectEvent()
  const observed = [f.observations[0], { ...f.observations[1], topics: undefined }]
  const confirmed = await f.complete(observed)
  assert.equal(confirmed.finds.length, 4)
  assert.equal(confirmed.finds.filter(row => row.kind === 'moment').length, 1)
  const durable = receipt(f.db, f.trip.id)

  f.db.prepare("UPDATE event SET text='后来模板',match_tags='[\"自然风景\"]' WHERE id=?").run(event.eventId)
  const reopened = openDatabase(f.path)
  try {
    const compose = createTripDiscoveryComposer(reopened, { now })
    const replay = () => compose(f.trip.id, f.request, { intentId })
    assert.deepEqual(replay().finds, confirmed.finds)
    f.setBlocks([topic])
    const filtered = replay()
    assert.equal(filtered.status, 'complete')
    assert.deepEqual(filtered.finds.map(row => row.kind), ['zhihu'])
    assert.deepEqual(new Set(filtered.confirmation.visibilityReasons),
      new Set(['TOPIC_EVIDENCE_UNAVAILABLE', 'BLOCKED_TOPICS']))
    f.setBlocks([topic, '私有测试'])
    const hidden = replay()
    assert.equal(hidden.status, 'complete')
    assert.deepEqual(hidden.finds, [])
    assert.equal(hidden.confirmation.completedAt, at)
    assert.deepEqual(hidden.reasons, [])
    const attempt = f.newSearch()
    const preflight = await attempt.search(f.trip.id, f.request, intentId)
    assert.deepEqual(preflight.replay.finds, [])
    assert.equal(attempt.calls, 0)
    const single = await createTripDiscoverer(reopened, { now })(f.trip.id, f.request, intentId)
    assert.deepEqual(single.finds, [])
    assert.ok(single.confirmation.replayed)
    assert.equal(rowset(f.db, f.trip.id).length, 4)
    assert.deepEqual(receipt(f.db, f.trip.id), durable)
    assert.ok(!JSON.stringify(hidden).includes(query))
    assert.ok(!JSON.stringify(hidden).includes(topic))
    const response = handleFindsRequest(f.request, f.trip.id, () => f.db)
    const payload = await response.json()
    assert.deepEqual(Object.keys(payload), ['finds'])
    assert.ok(!JSON.stringify(payload).includes(query))
  } finally { reopened.close() }
})

test('D8 changes during provider wait are rechecked before any Find or receipt write', async t => {
  const f = fixture(t)
  const second = openDatabase(f.path)
  try {
    const attempt = f.newSearch(() => {
      assert.equal(f.db.isTransaction, false)
      createTripService(second, { now }).finish(f.trip.id, f.owner.sessionId, 'timeout')
    })
    const result = await attempt.search(f.trip.id, f.request, intentId)
    assert.equal(result.proofs.length, 1)
    assert.throws(() => f.compose(f.trip.id, f.request,
      { intentId, observations: f.observations, searchProofs: result.proofs }), conflict)
    assert.equal(receipt(f.db, f.trip.id), undefined)
    assert.deepEqual(rowset(f.db, f.trip.id), [])
  } finally { second.close() }
})

test('D8 revocation during provider wait rejects confirmation under the write lock', async t => {
  const f = fixture(t)
  const second = openDatabase(f.path)
  try {
    const result = await f.newSearch(() => revokeSession(f.request, second)).search(f.trip.id, f.request, intentId)
    assert.equal(result.proofs.length, 1)
    assert.throws(() => f.compose(f.trip.id, f.request,
      { intentId, observations: f.observations, searchProofs: result.proofs }), missing)
    assert.equal(receipt(f.db, f.trip.id), undefined)
    assert.deepEqual(rowset(f.db, f.trip.id), [])
  } finally { second.close() }
})
