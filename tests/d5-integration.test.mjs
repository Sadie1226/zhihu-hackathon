import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { TRIP_HISTORY_V7_SQL } from '../lib/db/migrations/007-trip-history.ts'
import { readDepartureSnapshot } from '../lib/trips/departure-snapshot.ts'
import { requireRunningSeedEventTrip, seedIntentTripId } from '../lib/trips/seed-event-scope.ts'
import { createTripService } from '../lib/trips/service.ts'
import { insertDog, insertExchange, mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'

const at = '2026-11-24T00:00:00.000Z'
const clock = () => new Date(at)
const v6Migrations = migrations.slice(0, -1)

function since(db, owner, id) {
  const service = createTripService(db, { now: clock, newId: () => id })
  service.create(owner.id, owner.sessionId, 'auto')
  service.start(id, owner.sessionId)
  return service
}

function event(db) {
  db.exec("INSERT INTO event(id,code,text,season,weather,time_of_day) VALUES ('ev','ev_old','旧的公开摘要。','any','any','any')")
}

test('v7-shaped migration rolls back as a unit and preserves unverified old rows without current text', t => {
  const { db, path } = mailboxDatabase(t, v6Migrations)
  const owner = ownedDog(db, 'owner')
  db.prepare(`INSERT INTO trip(id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
    VALUES('legacy-trip',?,1,'done','auto',?,?,?)`).run(owner.id, at, at, at)
  event(db)
  db.prepare('INSERT INTO trip_event VALUES (?,?,?,?)').run('legacy-trip', 'ev', owner.id, at)
  db.close()

  const bad = { ...migrations.at(-1), sql: TRIP_HISTORY_V7_SQL + '\n INVALID SQL;' }
  assert.throws(() => openDatabase(path, [...v6Migrations, bad]), /syntax error/)
  const afterFailure = openDatabase(path, v6Migrations)
  try {
    assert.equal(afterFailure.prepare('PRAGMA user_version').get().user_version, 6)
    assert.equal(afterFailure.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'trip_event_fact'").get(), undefined)
    assert.equal(afterFailure.prepare('SELECT count(*) n FROM trip_event').get().n, 1)
  } finally {
    afterFailure.close()
  }
  for (let open = 0; open < 2; open += 1) {
    const migrated = openDatabase(path)
    try {
      assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 7)
      assert.deepEqual({ ...migrated.prepare('SELECT * FROM v_trip_event_history').get() }, {
        trip_id: 'legacy-trip', event_id: 'ev', dog_id: owner.id, happened_at: at,
        event_code_at_occurrence: null, public_text_at_occurrence: null, history_status: 'unverifiable',
      })
      assert.throws(() => migrated.exec(`INSERT OR REPLACE INTO trip_event_fact VALUES
        ('legacy-trip','ev','ev_old','旧的公开摘要。')`), /already exists/)
      assert.equal(readDepartureSnapshot(migrated, 'legacy-trip', owner.id), null)
      assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), [])
      assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    } finally {
      migrated.close()
    }
  }
})

test('occurrence and frozen public fields commit together, survive template edits and resist SQL replacement', t => {
  const { db } = mailboxDatabase(t)
  const a = ownedDog(db, 'owner-a')
  const b = ownedDog(db, 'owner-b')
  event(db)
  const service = since(db, a, 'trip-a')
  since(db, b, 'trip-b')
  const insert = db.prepare('INSERT INTO trip_event VALUES (?,?,?,?)')
  assert.throws(() => insert.run('trip-a', 'ev', b.id, at), /matching running trip/)
  assert.throws(() => insert.run('trip-a', 'ev', a.id, '2026-11-23T23:59:59.999Z'), /matching running trip/)
  db.exec(`CREATE TRIGGER fault_fact AFTER INSERT ON trip_event_fact
    BEGIN SELECT RAISE(ABORT, 'fact fault'); END;`)
  assert.throws(() => insert.run('trip-a', 'ev', a.id, at), /fact fault/)
  assert.equal(db.prepare('SELECT count(*) n FROM trip_event').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) n FROM trip_event_fact').get().n, 0)
  db.exec('DROP TRIGGER fault_fact')
  insert.run('trip-a', 'ev', a.id, at)
  service.finish('trip-a', a.sessionId, 'done')

  db.exec("UPDATE event SET code = 'ev_new', text = '新的公开摘要。' WHERE id = 'ev'")
  insert.run('trip-b', 'ev', b.id, at)
  assert.deepEqual(db.prepare(`SELECT event_code_at_occurrence, public_text_at_occurrence, history_status
    FROM v_trip_event_history ORDER BY trip_id`).all().map(Object.values), [
    ['ev_old', '旧的公开摘要。', 'frozen'], ['ev_new', '新的公开摘要。', 'frozen'],
  ])
  for (const sql of [
    "UPDATE trip_event SET happened_at = 'new'",
    'DELETE FROM trip_event',
    "UPDATE trip_event_fact SET public_text_at_occurrence = 'new'",
    'DELETE FROM trip_event_fact',
    "INSERT OR REPLACE INTO trip_event_fact VALUES ('trip-a','ev','ev_new','新的公开摘要。')",
    "UPDATE trip SET dog_id = 'owner-b' WHERE id = 'trip-a'",
  ]) assert.throws(() => db.exec(sql), /immutable|already exists/)
  assert.throws(() => db.exec("INSERT OR REPLACE INTO trip SELECT * FROM trip WHERE id = 'trip-a'"), /cannot be replaced/)
})

test('seed event authorization checks the exact intent, dog and current trip status inside the transaction', t => {
  const { db } = mailboxDatabase(t)
  insertDog(db, 'sample-a', 'sample fixture a', 1)
  insertDog(db, 'sample-b', 'sample fixture b', 1)
  const owner = ownedDog(db, 'owner')
  const intentId = 'contract-test'
  const dogId = 'sample-a'
  const tripId = seedIntentTripId(dogId, intentId)
  const scope = { dogId, tripId, intentId }
  assert.equal(seedIntentTripId('dog_seed_07', 'seed-test:001'),
    'trip_seed_intent_13612605004b11f0f22ea07e528fe50eaeba248294bbb64c364a6f5a0716f001')
  assert.throws(() => requireRunningSeedEventTrip(db, scope), /requires a transaction/)
  const service = createTripService(db, { now: clock, newId: () => tripId })
  service.create(dogId, 'sample fixture a', 'auto')
  const inside = scope => {
    db.exec('BEGIN IMMEDIATE')
    try { return requireRunningSeedEventTrip(db, scope) } finally { db.exec('ROLLBACK') }
  }
  assert.throws(() => inside(scope), { code: 'CONFLICT' })
  service.start(tripId, 'sample fixture a')
  assert.deepEqual(inside(scope), { startedAt: at, interestCategories: null, blockedTopics: '[]' })
  assert.throws(() => inside({ ...scope, dogId: 'sample-b' }), { code: 'NOT_FOUND' })
  assert.throws(() => inside({ ...scope, intentId: 'other-intent' }), { code: 'NOT_FOUND' })
  assert.throws(() => inside({ ...scope, tripId: 'unrelated' }), { code: 'NOT_FOUND' })
  assert.throws(() => service.get(tripId, owner.sessionId), { code: 'NOT_FOUND' })
  assert.throws(() => service.get(tripId, 'seed'), { code: 'NOT_FOUND' })
  const ownerTrip = seedIntentTripId(owner.id, intentId)
  since(db, owner, ownerTrip)
  assert.throws(() => inside({ dogId: owner.id, tripId: ownerTrip, intentId }), { code: 'NOT_FOUND' })
  service.finish(tripId, 'sample fixture a', 'done')
  assert.throws(() => inside(scope), { code: 'CONFLICT' })
})

test('C4 binds the validated version before start/delivery, and rollback, retry and reopen preserve the boundary', t => {
  const { db, path } = mailboxDatabase(t)
  const owner = ownedDog(db, 'owner')
  const sender = ownedDog(db, 'sender')
  insertExchange(db, 'due', sender.id, owner.id, 1)
  const service = createTripService(db, { now: clock, newId: () => 'departing' })
  const pending = service.create(owner.id, owner.sessionId, 'auto')
  assert.equal(readDepartureSnapshot(db, pending.id, owner.id), null)
  db.exec(`CREATE TRIGGER test_snapshot_before_start BEFORE INSERT ON snapshot BEGIN
    SELECT RAISE(ABORT, 'snapshot must precede departure and delivery')
    WHERE (SELECT status FROM trip WHERE id = 'departing') <> 'pending'
      OR (SELECT delivered_at FROM exchange WHERE id = 'due') IS NOT NULL;
  END;`)
  db.exec(`CREATE TRIGGER fault_delivery AFTER UPDATE OF delivered_at ON exchange
    BEGIN SELECT RAISE(FAIL, 'delivery fault'); END;`)
  assert.throws(() => service.start(pending.id, owner.sessionId), /delivery fault/)
  assert.deepEqual(service.get(pending.id, owner.sessionId), pending)
  assert.equal(readDepartureSnapshot(db, pending.id, owner.id), null)
  assert.equal(db.prepare('SELECT count(*) n FROM snapshot').get().n, 0)
  assert.equal(db.prepare("SELECT delivered_at FROM exchange WHERE id = 'due'").get().delivered_at, null)
  db.exec('DROP TRIGGER fault_delivery')

  const started = service.start(pending.id, owner.sessionId)
  assert.deepEqual(started.delivered.map(row => row.id), ['due'])
  assert.deepEqual(started.delivered.map(row => [row.deliveredAt, row.readAt, row.repliedAt]), [[at, null, null]])
  assert.deepEqual(service.start(pending.id, owner.sessionId), { trip: started.trip, delivered: [] })
  const bound = readDepartureSnapshot(db, pending.id, owner.id)
  assert.equal(bound.version, 1)
  assert.equal(bound.createdAt, at)
  assert.equal(readDepartureSnapshot(db, pending.id, sender.id), null)
  db.exec('DROP TRIGGER test_snapshot_before_start')
  db.prepare('INSERT INTO snapshot SELECT dog_id, 2, personality_tags, interest_categories, recent_trips, waiting_for, created_at FROM snapshot WHERE version=1').run()
  assert.deepEqual(readDepartureSnapshot(db, pending.id, owner.id), bound)
  for (const sql of [
    'UPDATE snapshot SET waiting_for = NULL',
    'DELETE FROM snapshot WHERE version=1',
    'UPDATE trip_snapshot SET snapshot_version=2',
    'DELETE FROM trip_snapshot',
    'INSERT OR REPLACE INTO snapshot SELECT * FROM snapshot WHERE version=1',
    'INSERT OR REPLACE INTO trip_snapshot SELECT * FROM trip_snapshot',
  ]) assert.throws(() => db.exec(sql), /immutable|already exists/)
  db.close()

  const reopened = openDatabase(path)
  try {
    const retry = createTripService(reopened, { now: () => assert.fail('repeat start allocated a new departure time') })
    assert.deepEqual(retry.start(pending.id, owner.sessionId), { trip: started.trip, delivered: [] })
    assert.deepEqual(readDepartureSnapshot(reopened, pending.id, owner.id), bound)
  } finally {
    reopened.close()
  }
})

test('two C4 start connections bind one snapshot version and deliver once', { timeout: 15000 }, async t => {
  const { db, path } = mailboxDatabase(t)
  const owner = ownedDog(db, 'racing-owner')
  const sender = ownedDog(db, 'sender')
  const service = createTripService(db, { now: clock })
  const trip = service.create(owner.id, owner.sessionId, 'auto')
  insertExchange(db, 'race-gift', sender.id, owner.id, 1)
  const workers = Array.from({ length: 2 }, () => {
    const worker = new Worker(new URL('./helpers/d5-departure-worker.mjs', import.meta.url), {
      workerData: { path, tripId: trip.id, sessionId: owner.sessionId, at },
    })
    t.after(() => worker.terminate())
    return { worker, ready: once(worker, 'message'), exit: once(worker, 'exit') }
  })
  assert.deepEqual(await Promise.all(workers.map(worker => worker.ready)), [['ready'], ['ready']])
  const results = workers.map(({ worker }) => once(worker, 'message'))
  for (const { worker } of workers) worker.postMessage('start')
  const [[a], [b]] = await Promise.all(results)
  for (const { exit } of workers) assert.deepEqual(await exit, [0])
  assert.deepEqual(a.trip, b.trip)
  assert.deepEqual([a.delivered.length, b.delivered.length].sort(), [0, 1])
  assert.equal(db.prepare('SELECT count(*) n FROM snapshot').get().n, 1)
  assert.equal(db.prepare('SELECT count(*) n FROM trip_snapshot').get().n, 1)
  assert.equal(readDepartureSnapshot(db, trip.id, owner.id).version, 1)
})
