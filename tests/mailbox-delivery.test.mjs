import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { deliverOnTripStart, isArrived } from '../lib/mailbox/deliver.mjs'
import { readInbox } from '../lib/mailbox/service.ts'
import { createTripService } from '../lib/trips/service.ts'
import { gift, insertDog, insertExchange, mailboxDatabase, raceMailboxWorkers } from './helpers/mailbox-fixtures.mjs'

test('seed dog seq 0→1 and 1→2 deliver through C4 only on actual start', { timeout: 15000 }, async t => {
  const { db, path } = mailboxDatabase(t)
  const seed = 'dog_seed_07'
  const session = 'fixture-internal-seed-session'
  insertDog(db, seed, session, 1)
  insertDog(db, 'sender', 'fixture-sender-session')
  let at = '2026-11-21T01:00:00Z'
  const trips = createTripService(db, { now: () => new Date(at) })
  const replyCount = () => db.prepare('SELECT count(*) n FROM reply').get().n
  const timestamps = id => ({ ...db.prepare('SELECT delivered_at, replied_at, read_at FROM exchange WHERE id = ?').get(id) })
  assert.equal(db.prepare('SELECT is_sample FROM dog WHERE id = ?').get(seed).is_sample, 1)
  assert.deepEqual(trips.list(seed, session), [])

  insertExchange(db, 'first', 'sender', seed, 1)
  const first = trips.create(seed, session, 'auto')
  assert.equal(first.seq, 1)
  assert.equal(first.startedAt, null)
  assert.deepEqual(readInbox(db, seed, session, 'arrived'), { exchanges: [] })
  const started = trips.start(first.id, session)
  assert.deepEqual(started.delivered.map(row => row.id), ['first'])
  assert.deepEqual(timestamps('first'), { delivered_at: started.trip.startedAt, replied_at: null, read_at: null })
  at = '2026-11-21T01:05:00Z'
  const historical = trips.finish(first.id, session, 'done').trip

  const message = { kind: 'co_owner_message', message: '下次带一片树叶', fromOwnerOf: 'sender' }
  insertExchange(db, 'second', 'sender', seed, 2, message, '2026-11-21T02:00:00Z')
  // Simulate a historically missed row discovered after seq 1 had already started.
  insertExchange(db, 'overdue', 'sender', seed, 1, gift, '2026-11-21T00:30:00Z')
  assert.equal(isArrived(db, 'second').overdue, false)
  assert.equal(isArrived(db, 'overdue').overdue, true)
  assert.deepEqual(readInbox(db, seed, session, 'onTheWay').exchanges.map(row => row.id), ['second', 'overdue'])
  assert.equal(timestamps('overdue').delivered_at, null)
  at = '2026-11-21T03:00:00Z'
  const second = trips.create(seed, session, 'auto')
  assert.equal(second.seq, 2)
  assert.throws(() => trips.start(second.id, session), { code: 'CONFLICT' })
  assert.equal(timestamps('second').delivered_at, null)
  assert.equal(timestamps('overdue').delivered_at, null)

  const starts = await raceMailboxWorkers(t, path, 'start', second.id, session)
  assert.deepEqual(starts.map(result => result.delivered.length).sort(), [0, 2])
  assert.deepEqual(starts[0].trip, starts[1].trip)
  const deliveredAt = starts[0].trip.startedAt
  for (const id of ['second', 'overdue']) {
    assert.deepEqual(timestamps(id), { delivered_at: deliveredAt, replied_at: null, read_at: null })
  }
  assert.deepEqual(deliverOnTripStart(db, seed, 2, '2026-11-21T09:00:00Z'), { deliveredIds: [] })
  assert.equal(timestamps('second').delivered_at, deliveredAt)
  assert.equal(timestamps('first').delivered_at, started.trip.startedAt)
  assert.equal(isArrived(db, 'overdue').overdue, false)
  assert.deepEqual(trips.get(first.id, session), historical)
  assert.equal(replyCount(), 0)

  db.close()
  const reopened = openDatabase(path)
  try {
    assert.deepEqual(readInbox(reopened, seed, session, 'arrived').exchanges.map(row => [row.id, row.deliveredAt]), [
      ['second', deliveredAt], ['overdue', deliveredAt], ['first', started.trip.startedAt],
    ])
    assert.deepEqual(createTripService(reopened).get(first.id, session), historical)
    assert.equal(reopened.prepare('SELECT count(*) n FROM reply').get().n, 0)
  } finally { reopened.close() }
})
