import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { createTripService } from '../lib/trips/service.ts'
import { createSeedTripRunner } from '../lib/trips/seed-runner.ts'
import { createTripDiscoveryComposer } from '../lib/trips/composer.ts'
import { createTripDiscoverySearch, createTripDiscoverer } from '../lib/trips/discover.ts'
import { createFindStore, handleFindsRequest } from '../lib/trips/finds.ts'
import { searchForTrip } from '../lib/trips/search-proof.ts'
import { ownerDiscoveryIntent } from '../lib/trips/discovery-receipt.ts'
import { seedIntentTripId } from '../lib/trips/seed-event-scope.ts'
import { mailboxDatabase, ownedDog, insertDog } from './helpers/mailbox-fixtures.mjs'

const v7 = migrations.filter(migration => migration.version <= 7)
const at = '2026-11-25T02:00:00.000Z'
const now = () => new Date(at)
const held = { code: 'CONFLICT', message: /LEGACY_DISCOVERY_HOLD/ }
const preflight = path => spawnSync(process.execPath, ['scripts/check-v7-discovery-cutover.mjs', '--db', path],
  { encoding: 'utf8', windowsHide: true })
const rows = (db, table) => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()
const request = owner => new Request('https://local.test/finds', { headers: { cookie: owner.cookie } })
const scene = (trip, id) => ({ id, tripId: trip.id, dogId: trip.dogId, kind: 'scene',
  happenedAt: at, title: '隔离场景 ' + id, excerpt: null, topics: [] })
const article = { title: '离线验证材料', excerpt: null, sourceMode: 'live',
  sourceUrl: 'https://www.zhihu.com/question/802', authorityLevel: null, voteUpCount: null }
const providerResult = { ok: true, items: [article], httpStatus: 200, fetchedAt: at }

test('stopped v7 preflight and atomic upgrade hold only old running Trips with Finds; every write path is guarded', async t => {
  const { db, path } = mailboxDatabase(t, v7, readFileSync('tests/fixtures/schema-v1.sql', 'utf8'))
  const empty = preflight(path)
  assert.equal(empty.status, 0, empty.stderr)
  assert.equal(JSON.parse(empty.stdout).status, 'EMPTY_CAN_PROCEED_TO_UPGRADE_GATE')
  const owner = ownedDog(db, 'legacy-owner-dog')
  const lifecycle = createTripService(db, { now })
  const trip = lifecycle.start(lifecycle.create(owner.id, owner.sessionId, 'auto').id, owner.sessionId).trip
  insertDog(db, 'legacy-seed', 'sample-fixture', 1)
  const seed = { dogId: 'legacy-seed', intentId: 'fixture-intent', tripId: seedIntentTripId('legacy-seed', 'fixture-intent') }
  const runner = createSeedTripRunner(db, { now })(seed.dogId, seed.intentId)
  runner.create()
  runner.start()
  const other = ownedDog(db, 'legacy-no-find-dog')
  lifecycle.start(lifecycle.create(other.id, other.sessionId, 'auto').id, other.sessionId)
  const finished = ownedDog(db, 'legacy-finished-dog')
  const finishedTrip = lifecycle.create(finished.id, finished.sessionId, 'auto')
  lifecycle.start(finishedTrip.id, finished.sessionId)
  lifecycle.finish(finishedTrip.id, finished.sessionId, 'done')
  const insert = db.prepare("INSERT INTO find(id,trip_id,kind,title,created_at) VALUES(?,?,'scene','private-fixture-text',?)")
  for (const [id, tripId] of [['old-a', trip.id], ['old-b', trip.id], ['old-seed', seed.tripId],
    ['old-finished', finishedTrip.id]]) insert.run(id, tripId, at)
  const originalFinds = rows(db, 'find')
  const originalTrips = rows(db, 'trip')
  db.close()

  const gate = preflight(path)
  assert.equal(gate.status, 2, gate.stderr)
  assert.ok(!gate.stdout.includes('private-fixture-text'))
  const inventory = JSON.parse(gate.stdout)
  assert.equal(inventory.trip_count, 2)
  assert.equal(inventory.find_count, 3)
  const upgraded = openDatabase(path)
  try {
    const captured = upgraded.prepare('SELECT trip_id,dog_id,find_count FROM trip_discovery_legacy_hold ORDER BY trip_id').all()
    assert.deepEqual(captured.map(row => ({ ...row })), inventory.trips)
    const wrongVersion = preflight(path)
    assert.equal(wrongVersion.status, 1)
    assert.match(wrongVersion.stderr, /requires schema v7/)
    const io = { provider: 0, read: 0, write: 0 }
    const provider = async () => { io.provider++; return providerResult }
    const cache = { async read() { io.read++ }, async write() { io.write++ } }
    const scoped = request(owner)
    const store = createFindStore(upgraded, { now })
    const search = createTripDiscoverySearch(upgraded, provider, { cache, now })
    await assert.rejects(search(trip.id, scoped), held)
    await assert.rejects(createTripDiscoverer(upgraded, { provider, cache, now })(trip.id, scoped), held)
    assert.throws(() => store.prepareOwnerSearch(trip.id, scoped), held)
    assert.throws(() => createTripDiscoveryComposer(upgraded, { now })(trip.id, scoped,
      { observations: [scene(trip, 'new')] }), held)
    assert.throws(() => store.write({ tripId: trip.id, kind: 'scene' }, owner.sessionId), held)
    assert.throws(() => store.commitSearchSelection(trip.id, null, scoped), held)
    assert.throws(() => store.writeSeedBatch(seed, () => []), held)
    assert.deepEqual(io, { provider: 0, read: 0, write: 0 })

    // A proof created outside the preflight models a result already in flight.
    const { proof } = await searchForTrip({ tripId: trip.id, dogId: owner.id, ownerId: owner.sessionId,
      intentId: ownerDiscoveryIntent(trip.id), query: '隔离验证', category: '自然风景', blockedTopics: [] },
    async () => providerResult)
    assert.ok(proof)
    assert.throws(() => store.writeVerified(proof, scoped), held)
    assert.throws(() => store.commitSearchSelection(trip.id, proof, scoped), held)
    assert.equal(upgraded.isTransaction, false)
    assert.deepEqual(rows(upgraded, 'trip_discovery_receipt'), [])
    assert.deepEqual(rows(upgraded, 'find'), originalFinds)
    assert.deepEqual(rows(upgraded, 'trip'), originalTrips)
    const history = handleFindsRequest(scoped, trip.id, () => upgraded)
    assert.equal(history.status, 200)
    assert.deepEqual((await history.json()).finds.map(row => row.id), ['old-a', 'old-b'])
  } finally { upgraded.close() }
})

test('fresh and new partial have no hold, including after reopen; trusted evidence can complete the same Trip', async t => {
  const { db, path } = mailboxDatabase(t)
  const owner = ownedDog(db, 'new-partial-dog')
  const lifecycle = createTripService(db, { now })
  const trip = lifecycle.start(lifecycle.create(owner.id, owner.sessionId, 'auto').id, owner.sessionId).trip
  const scoped = request(owner)
  const facts = [scene(trip, 'one'), scene(trip, 'two')]
  assert.equal(createTripDiscoveryComposer(db, { now })(trip.id, scoped, { observations: facts }).status, 'partial')
  assert.deepEqual(rows(db, 'trip_discovery_legacy_hold'), [])
  db.close()

  const reopened = openDatabase(path)
  try {
    let calls = 0
    const search = createTripDiscoverySearch(reopened, async () => { calls++; return providerResult }, { now })
    const result = await search(trip.id, scoped)
    const composition = createTripDiscoveryComposer(reopened, { now })(trip.id, scoped, {
      searchProofs: result.proofs, observations: facts,
    })
    assert.equal(calls, 1)
    assert.equal(composition.status, 'complete')
    assert.equal(composition.finds.length, 3)
    assert.equal(rows(reopened, 'trip_discovery_receipt').length, 1)
    assert.deepEqual(rows(reopened, 'trip_discovery_legacy_hold'), [])
  } finally { reopened.close() }
})
