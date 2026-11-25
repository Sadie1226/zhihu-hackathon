import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { sessionCookieName } from '../lib/auth/session.ts'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { createTripEventSelector } from '../lib/events/select.ts'
import { readDepartureSnapshot } from '../lib/trips/departure-snapshot.ts'
import { handleTripRequest } from '../lib/trips/http.ts'
import { readOccurrenceFact } from '../lib/trips/occurrence-facts.ts'
import { createSeedTripRunner } from '../lib/trips/seed-runner.ts'
import { createTripService } from '../lib/trips/service.ts'
import { insertDog, insertExchange, mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'

const at = '2026-11-24T03:00:00.000Z'
const next = '2026-11-24T09:00:00.000Z'
const now = () => new Date(at)
const rehearsal = { sceneFile: 'scenes/nantou.png', season: 'spring', weather: 'clear', timeOfDay: 'morning' }

function startRequest(cookie, body = {}) {
  return new Request('http://localhost/api/trips/test/start', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

test('default owner start binds the formal snapshot on an upgraded v7 database', async t => {
  const { db: legacy, path } = mailboxDatabase(t, migrations.filter(migration => migration.version <= 6))
  const owner = ownedDog(legacy, 'g3-owner')
  const trips = createTripService(legacy, { now })
  const pending = trips.create(owner.id, owner.sessionId, 'auto')
  legacy.close()
  const db = openDatabase(path)
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8)
    assert.equal(readDepartureSnapshot(db, pending.id, owner.id), null)
    const response = await handleTripRequest(startRequest(owner.cookie), 'start', pending.id, () => db)
    assert.equal(response.status, 200)
    const { trip } = await response.json()
    assert.equal(readDepartureSnapshot(db, trip.id, owner.id).createdAt, trip.startedAt)
    assert.equal(readDepartureSnapshot(db, trip.id, owner.id).version, 1)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})

test('old running and terminal trips are never assigned a retrospective snapshot, and missing history blocks a new start', async t => {
  const { db: legacy, path } = mailboxDatabase(t, migrations.filter(migration => migration.version <= 6))
  const owner = ownedDog(legacy, 'g3-legacy')
  const sender = ownedDog(legacy, 'g3-sender')
  legacy.prepare(`INSERT INTO trip(id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
    VALUES('old',?,1,'running','auto',?,?,NULL)`).run(owner.id, at, at)
  legacy.exec("INSERT INTO event(id,code,text,season,weather,time_of_day) VALUES('old-event','old-code','可变模板','any','any','any')")
  legacy.prepare("INSERT INTO trip_event VALUES('old','old-event',?,?)").run(owner.id, at)
  insertExchange(legacy, 'due-to-legacy-owner', sender.id, owner.id, 2)
  legacy.close()
  const db = openDatabase(path)
  try {
    const trips = createTripService(db, { now: () => new Date(next) })
    assert.equal(trips.start('old', owner.sessionId).trip.status, 'running')
    assert.equal(readDepartureSnapshot(db, 'old', owner.id), null)
    trips.finish('old', owner.sessionId, 'done')
    assert.throws(() => trips.start('old', owner.sessionId), { code: 'CONFLICT' })
    assert.equal(readDepartureSnapshot(db, 'old', owner.id), null)
    assert.equal(readOccurrenceFact(db, 'old', owner.id), null)
    const pending = trips.create(owner.id, owner.sessionId, 'auto')
    const response = await handleTripRequest(startRequest(owner.cookie), 'start', pending.id, () => db)
    assert.equal(response.status, 409)
    assert.match((await response.json()).detail, /HISTORY_UNVERIFIABLE/)
    assert.equal(trips.get(pending.id, owner.sessionId).status, 'pending')
    assert.equal(db.prepare('SELECT count(*) AS n FROM snapshot').get().n, 0)
    assert.equal(readDepartureSnapshot(db, pending.id, owner.id), null)
    assert.equal(db.prepare("SELECT delivered_at FROM exchange WHERE id = 'due-to-legacy-owner'").get().delivered_at, null)
  } finally { db.close() }
})

test('seed runner binds snapshots and selects through C7 after commit, keeping the first immutable occurrence', async t => {
  const { db } = mailboxDatabase(t)
  const owner = ownedDog(db, 'g3-real-owner')
  const dogId = 'g3-sample'
  insertDog(db, dogId, 'seed', 1)
  db.exec(readFileSync('team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql', 'utf8'))
  db.exec("UPDATE event SET enabled = (code = 'any_shop_cat')")
  insertExchange(db, 'g3-gift', owner.id, dogId, 1)
  insertExchange(db, 'g3-next-gift', owner.id, dogId, 2)
  let atTime = at
  const runner = createSeedTripRunner(db, { now: () => new Date(atTime) })
  const intentId = 'g3-test-seed'
  const intent = runner(dogId, intentId)
  const pending = intent.create()
  assert.equal(readDepartureSnapshot(db, pending.id, dogId), null)
  assert.throws(() => intent.selectEvent(rehearsal), { code: 'CONFLICT' })
  for (const cookie of [owner.cookie, `${sessionCookieName()}=seed`]) {
    const response = await handleTripRequest(startRequest(cookie), 'start', pending.id, () => db)
    assert.equal(response.status, 404)
  }
  const injected = await handleTripRequest(startRequest(owner.cookie, { intentId }), 'start', pending.id, () => db)
  assert.equal(injected.status, 409)
  const departed = intent.start()
  assert.deepEqual(departed.delivered.map(row => [row.id, row.deliveredAt, row.readAt, row.repliedAt]),
    [['g3-gift', at, null, null]])
  assert.equal(db.isTransaction, false)
  const firstSnapshot = readDepartureSnapshot(db, pending.id, dogId)
  assert.equal(firstSnapshot.version, 1)
  assert.deepEqual(firstSnapshot.recentTrips, [])
  assert.deepEqual(intent.start(), { trip: departed.trip, delivered: [] })

  const pick = createTripEventSelector(db, { now, random: () => assert.fail('invalid scope must not draw') })
  const selection = { dogId, tripId: pending.id, conditions: rehearsal }
  for (const sessionId of [owner.sessionId, 'seed']) {
    assert.throws(() => pick({ ...selection, sessionId }), { code: 'NOT_FOUND' })
  }
  assert.throws(() => pick.forSeed({ ...selection, intentId: 'another-intent' }), { code: 'NOT_FOUND' })
  db.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(() => intent.selectEvent(rehearsal), /separate transaction after start commits/)
    assert.equal(db.isTransaction, true)
  } finally { db.exec('ROLLBACK') }
  assert.equal(intent.selectEvent(null), null)
  assert.equal(readOccurrenceFact(db, pending.id, dogId), null)
  const occurred = intent.selectEvent(rehearsal)
  assert.equal(occurred.eventId, 'ev_any_shop_cat')
  const fact = readOccurrenceFact(db, pending.id, dogId)
  assert.equal(fact.capturedAt, at)
  assert.deepEqual(pick.forSeed({ ...selection, intentId }), occurred)
  intent.finish('done')
  assert.throws(() => intent.selectEvent(rehearsal), { code: 'CONFLICT' })

  db.prepare('UPDATE event SET text = ? WHERE id = ?').run('测试时改过的模板', occurred.eventId)
  assert.deepEqual(readOccurrenceFact(db, pending.id, dogId), fact)
  atTime = next
  const second = runner(dogId, 'g3-test-seed-2')
  const secondTrip = second.create()
  assert.deepEqual(second.start().delivered.map(row => [row.id, row.deliveredAt]), [['g3-next-gift', next]])
  assert.deepEqual(readDepartureSnapshot(db, secondTrip.id, dogId).recentTrips, [fact.text])
  assert.equal(readDepartureSnapshot(db, secondTrip.id, dogId).version, 2)
  assert.deepEqual(readDepartureSnapshot(db, pending.id, dogId), firstSnapshot)
  assert.equal(second.selectEvent(rehearsal), null)
  assert.equal(second.finish('done').trip.status, 'done')
  assert.equal(db.prepare('SELECT count(*) AS n FROM trip_event_fact').get().n, 1)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})
