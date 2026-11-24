import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { sessionCookieName } from '../lib/auth/session.ts'
import { initializeDatabase, openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { handleTripRequest } from '../lib/trips/http.ts'
import { createSeedTripRunner } from '../lib/trips/seed-runner.ts'
import { insertExchange, mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'

const seedSql = readFileSync('team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql', 'utf8')
const seed = 'dog_seed_07'
const other = 'dog_seed_01'
const firstAt = '2026-11-24T00:00:00.000Z'
const sixHours = '2026-11-24T06:00:00.000Z'
const tripRows = db => db.prepare('SELECT * FROM trip ORDER BY dog_id, seq').all()
const exchange = (db, id) => ({ ...db.prepare(
  'SELECT delivered_at, replied_at, read_at FROM exchange WHERE id = ?').get(id) })

function setup(t) {
  const { db, path } = mailboxDatabase(t, migrations.filter(m => m.version <= 5),
    readFileSync('tests/fixtures/schema-v1.sql', 'utf8'))
  db.exec(seedSql)
  // Preserve the original seed roster bytes through the real v5 -> v6 migration.
  initializeDatabase(db, () => { throw new Error('existing schema must not be reread') })
  assert.equal(db.prepare('SELECT count(*) n FROM dog WHERE is_sample = 1 AND owner_id IS NULL').get().n, 20)
  assert.deepEqual(tripRows(db), [])
  const clock = { at: firstAt }
  const runner = createSeedTripRunner(db, { now: () => new Date(clock.at) })
  return { db, path, clock, runner }
}

test('D seed roster: seq 0→1→2 through C4, delayed delivery, gap, Shanghai quota and persisted history', t => {
  const { db, path, clock, runner } = setup(t)
  const sender = ownedDog(db, 'sender')
  const beforeDogs = db.prepare('SELECT * FROM dog ORDER BY id').all()
  insertExchange(db, 'due-first', sender.id, seed, 1)
  insertExchange(db, 'for-other-dog', sender.id, other, 1)
  insertExchange(db, 'due-second', sender.id, seed, 2)
  const first = runner(seed, 'seed-test:001')
  const second = runner(seed, 'seed-test:002')
  const pending = first.create()
  assert.deepEqual(pending, {
    id: pending.id, dogId: seed, seq: 1, status: 'pending', trigger: 'auto',
    createdAt: firstAt, startedAt: null, endedAt: null, wishId: null,
  })
  assert.deepEqual(first.create(), pending)
  assert.throws(() => second.create(), { code: 'CONFLICT' })
  assert.throws(() => first.finish('done'), { code: 'CONFLICT' })
  assert.equal(exchange(db, 'due-first').delivered_at, null)
  const started = first.start()
  assert.equal(started.trip.status, 'running')
  assert.equal(started.trip.startedAt, firstAt)
  assert.deepEqual(started.delivered.map(row => row.id), ['due-first'])
  assert.deepEqual(first.start(), { trip: started.trip, delivered: [] })
  assert.throws(() => second.create(), { code: 'CONFLICT' })
  assert.equal(exchange(db, 'due-second').delivered_at, null)
  assert.equal(exchange(db, 'for-other-dog').delivered_at, null)

  clock.at = '2026-11-24T00:05:00.000Z'
  const done = first.finish('done').trip
  assert.equal(done.endedAt, clock.at)
  assert.deepEqual(first.finish('done').trip, done)
  assert.deepEqual(first.start(), { trip: done, delivered: [] })
  assert.throws(() => first.finish('failed'), { code: 'CONFLICT' })

  clock.at = '2026-11-24T05:59:59.999Z'
  const secondPending = second.create()
  assert.equal(secondPending.seq, 2)
  assert.throws(() => second.start(), { code: 'CONFLICT', message: /6 小时/ })
  assert.deepEqual(second.create(), secondPending)
  assert.equal(exchange(db, 'due-second').delivered_at, null)
  clock.at = sixHours
  const secondStart = second.start()
  assert.deepEqual(secondStart.delivered.map(row => row.id), ['due-second'])
  assert.equal(secondStart.trip.startedAt, sixHours)
  assert.deepEqual(second.start(), { trip: secondStart.trip, delivered: [] })
  const secondDone = second.finish('done').trip

  clock.at = '2026-11-24T12:00:00.000Z'
  assert.throws(() => runner(seed, 'seed-test:003').create(), { code: 'CONFLICT', message: /两次/ })
  for (const [id, at] of [['due-first', firstAt], ['due-second', sixHours]]) {
    assert.deepEqual(exchange(db, id), { delivered_at: at, replied_at: null, read_at: null })
  }
  assert.deepEqual(db.prepare('SELECT * FROM dog ORDER BY id').all(), beforeDogs)
  assert.equal(db.prepare('SELECT count(*) n FROM reply').get().n, 0)
  assert.equal(tripRows(db).length, 2)

  db.close()
  const reopened = openDatabase(path)
  try {
    const replay = createSeedTripRunner(reopened, { now: () => assert.fail('terminal retry read the clock') })
    assert.deepEqual(replay(seed, 'seed-test:001').create(), done)
    assert.deepEqual(replay(seed, 'seed-test:002').create(), secondDone)
    assert.equal(tripRows(reopened).length, 2)

    const evidence = reopened.prepare(`
      SELECT d.id AS dogId, t.id AS tripId, t.seq, t.status, t.started_at AS startedAt,
        e.code AS eventCode, te.happened_at AS happenedAt
      FROM dog d JOIN trip t ON t.dog_id = d.id
      LEFT JOIN trip_event te ON te.trip_id = t.id AND te.dog_id = d.id
      LEFT JOIN event e ON e.id = te.event_id
      WHERE d.is_sample = 1 ORDER BY d.id, t.seq`).all().map(row => ({ ...row }))
    assert.deepEqual(evidence, [done, secondDone].map(trip => ({
      dogId: seed, tripId: trip.id, seq: trip.seq, status: 'done',
      startedAt: trip.startedAt, eventCode: null, happenedAt: null,
    })))
    t.diagnostic('D5 evidence (isolated SQLite test): ' + JSON.stringify(evidence))
  } finally {
    reopened.close()
  }
})

test('seed intent is scoped to one dog; unowned non-sample, v5 owner, unknown and changed flags are rejected', t => {
  const { db, runner } = setup(t)
  const owner = ownedDog(db, 'owner-dog')
  const first = runner(seed, 'same-key')
  const otherRun = runner(other, 'same-key')
  for (const id of [owner.id, 'unknown-dog']) {
    const invalid = runner(id, 'same-key')
    assert.throws(() => invalid.create(), { code: 'NOT_FOUND' })
    assert.throws(() => invalid.start(), { code: 'NOT_FOUND' })
    assert.throws(() => invalid.finish('done'), { code: 'NOT_FOUND' })
  }
  for (const key of ['', ' ', '../trip/no', 'x'.repeat(129)]) {
    assert.throws(() => runner(seed, key), { code: 'CONFLICT' })
  }
  assert.throws(() => first.start(), { code: 'NOT_FOUND' })
  const a = first.create()
  const b = otherRun.create()
  assert.notEqual(a.id, b.id)
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 1)
  insertExchange(db, 'for-other', owner.id, other, 1)
  assert.deepEqual(first.start().delivered, [])
  assert.equal(exchange(db, 'for-other').delivered_at, null)
  assert.deepEqual(otherRun.start().delivered.map(row => row.id), ['for-other'])

  db.prepare('UPDATE dog SET is_sample = 0 WHERE id = ?').run(seed)
  assert.throws(() => first.create(), { code: 'NOT_FOUND' })
  assert.throws(() => first.start(), { code: 'NOT_FOUND' })
  assert.throws(() => first.finish('done'), { code: 'NOT_FOUND' })
  assert.equal(tripRows(db).find(row => row.id === a.id).status, 'running')
  assert.equal(otherRun.finish('done').trip.status, 'done')
})

test('faults roll back create, start together with delivery, and finish; the same intent remains retryable', t => {
  const { db, runner } = setup(t)
  const sender = ownedDog(db, 'sender')
  const intent = runner(seed, 'test-rollbacks')
  insertExchange(db, 'due', sender.id, seed, 1)
  db.exec(`CREATE TRIGGER test_create_fault AFTER INSERT ON trip BEGIN
    SELECT RAISE(FAIL, 'create fault');
  END`)
  assert.throws(() => intent.create(), /create fault/)
  assert.deepEqual(tripRows(db), [])
  assert.equal(db.isTransaction, false)
  db.exec('DROP TRIGGER test_create_fault')
  const created = intent.create()

  db.exec(`CREATE TRIGGER test_start_fault AFTER UPDATE OF delivered_at ON exchange BEGIN
    SELECT RAISE(FAIL, 'delivery fault');
  END`)
  assert.throws(() => intent.start(), /delivery fault/)
  assert.deepEqual(intent.create(), created)
  assert.deepEqual(exchange(db, 'due'), { delivered_at: null, replied_at: null, read_at: null })
  db.exec('DROP TRIGGER test_start_fault')
  const { trip, delivered } = intent.start()
  assert.equal(delivered.length, 1)

  db.exec(`CREATE TRIGGER test_finish_fault AFTER UPDATE OF ended_at ON trip BEGIN
    SELECT RAISE(ROLLBACK, 'finish fault');
  END`)
  assert.throws(() => intent.finish('done'), /finish fault/)
  assert.deepEqual(intent.create(), trip)
  assert.equal(exchange(db, 'due').delivered_at, firstAt)
  db.exec('DROP TRIGGER test_finish_fault')
  assert.equal(intent.finish('done').trip.status, 'done')
})

test('two SQLite connections use one trip for one intent and only one performs delivery', { timeout: 15000 }, async t => {
  const { db, path } = setup(t)
  const sender = ownedDog(db, 'sender')
  insertExchange(db, 'concurrent', sender.id, seed, 1)
  const workers = Array.from({ length: 2 }, () => {
    const worker = new Worker(new URL('./helpers/seed-runner-worker.mjs', import.meta.url), {
      workerData: { path, dogId: seed, at: firstAt },
    })
    t.after(() => worker.terminate())
    return { worker, ready: once(worker, 'message'), exit: once(worker, 'exit') }
  })
  assert.deepEqual(await Promise.all(workers.map(entry => entry.ready)), [['ready'], ['ready']])
  const results = workers.map(({ worker }) => once(worker, 'message'))
  for (const { worker } of workers) worker.postMessage('go')
  const [[a], [b]] = await Promise.all(results)
  for (const { exit } of workers) assert.deepEqual(await exit, [0])
  assert.deepEqual(a.trip, b.trip)
  assert.equal(tripRows(db).length, 1)
  assert.deepEqual([a.delivered.length, b.delivered.length].sort(), [0, 1])
  assert.equal(exchange(db, 'concurrent').delivered_at, a.trip.startedAt)
})

test('server HTTP rejects a normal owner and forged seed cookie on seed trip actions', async t => {
  const { db, runner } = setup(t)
  const owner = ownedDog(db, 'normal-owner')
  const intent = runner(seed, 'http-denied')
  const pending = intent.create()
  const http = (action, id, cookie, body) => handleTripRequest(new Request('http://localhost/api/test', {
    method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), action, id, () => db)
  const attempts = [
    ['create', seed, owner.cookie, { trigger: 'auto' }],
    ['list', seed, owner.cookie, undefined],
    ['get', pending.id, owner.cookie, undefined],
    ['start', pending.id, owner.cookie, {}],
    ['finish', pending.id, owner.cookie, { status: 'done' }],
    ['start', pending.id, `${sessionCookieName()}=seed`, {}],
  ]
  for (const [action, id, cookie, body] of attempts) {
    const result = await http(action, id, cookie, body)
    assert.equal(result.status, 404)
    assert.equal((await result.json()).code, 'NOT_FOUND')
  }
  const spoof = await http('create', owner.id, owner.cookie, { trigger: 'auto', dogId: seed, intentId: 'http-denied' })
  assert.equal(spoof.status, 409)
  assert.deepEqual(intent.create(), pending)
  assert.equal(tripRows(db).length, 1)
  assert.equal((await http('create', owner.id, owner.cookie, { trigger: 'auto' })).status, 200)
})
