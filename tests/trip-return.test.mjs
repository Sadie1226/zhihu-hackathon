import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { revokeSession } from '../lib/auth/session.ts'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { createTripService } from '../lib/trips/service.ts'
import { mailboxDatabase, ownedDog, insertDog } from './helpers/mailbox-fixtures.mjs'
import { at, end, endedAt, now, discovery, request, returns, draftFor } from './helpers/trip-return-fixtures.mjs'

const conflicts = { code: 'CONFLICT' }
const readMessages = db => db.prepare('SELECT * FROM message ORDER BY id').all()
const readTrip = (db, id) => ({ ...db.prepare('SELECT status,ended_at FROM trip WHERE id=?').get(id) })
const history = (db, tripId, id, createdAt = '2026-11-27T08:00:00.000Z') =>
  db.prepare('INSERT INTO message(id,trip_id,text,created_at) VALUES(?,?,?,?)').run(id, tripId, '普通历史', createdAt)

async function fixture(t, versions, schema) {
  const { db, path } = mailboxDatabase(t, versions, schema)
  const owner = ownedDog(db, 'return-owner')
  const create = { dogId: owner.id, request: request(owner.cookie), action: 'create' }
  const result = await discovery(db).owner(create)
  assert.equal(result.status, 'complete')
  return { db, path, owner, result, input: { ...create, tripId: result.trip.id } }
}

function childRun(f, hold = false) {
  const child = fork(new URL('./helpers/trip-return-process.mjs', import.meta.url), { silent: true, windowsHide: true })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const first = once(child, 'message').then(([value]) => value)
  const exited = once(child, 'close')
  child.send({ path: f.path, dogId: f.owner.id, tripId: f.input.tripId, cookie: f.owner.cookie, hold })
  return {
    child,
    first: Promise.race([first, exited.then(() => { throw new Error(stderr || 'Return subprocess exited early') })]),
    async result(message) {
      const value = await message
      assert.deepEqual(await exited, [0, null], stderr)
      return value
    },
  }
}

test('confirmed return commits the exact Message and done; preserves ordinary history and replays across processes', async t => {
  const f = await fixture(t)
  const { db, input } = f
  history(db, input.tripId, 'msg_ordinary_old')
  history(db, input.tripId, 'msg_ordinary_latest')
  const prior = readMessages(db)
  let calls = 0
  const result = await returns(db, { generate: async evidence => {
    calls++
    assert.equal(db.isTransaction, false)
    assert.equal(evidence.scope, 'owner')
    assert.deepEqual(evidence.finds, f.result.finds)
    return draftFor(evidence)
  } }).owner(input)
  assert.equal(result.status, 'confirmed')
  assert.equal(result.replayed, false)
  assert.equal(result.trip.endedAt, endedAt)
  assert.equal(result.message.createdAt, endedAt)
  assert.match(result.message.id, /^msg_auto_return_v1_[a-f0-9]{64}$/)
  assert.deepEqual(readMessages(db).filter(row => row.id.startsWith('msg_ordinary')), prior)
  assert.deepEqual(readTrip(db, input.tripId), { status: 'done', ended_at: endedAt })
  const service = returns(db, { now: () => new Date('2026-11-27T09:00:00Z'),
    generate: async () => { calls++; throw new Error('unexpected regeneration') } })
  const retry = await service.owner(input)
  assert.equal(retry.replayed, true)
  assert.deepEqual(retry.message, result.message)
  const worker = childRun(f)
  const cold = await worker.result(worker.first)
  assert.equal(cold.calls, 0)
  assert.deepEqual(cold.result, retry)
  assert.equal(calls, 1)
  db.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run(JSON.stringify(['街景']), input.dogId)
  assert.deepEqual(await service.owner(input), { status: 'confirmed-hidden', trip: retry.trip })
  assert.equal(calls, 1)
  assert.equal(readMessages(db).length, 3)
})

test('two OS processes can generate concurrently but only one automatic confirmation persists', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const workers = [childRun(f, true), childRun(f, true)]
  t.after(() => { for (const { child } of workers) if (child.connected) child.kill() })
  assert.deepEqual(await Promise.all(workers.map(worker => worker.first)), [{ phase: 'generating' }, { phase: 'generating' }])
  const results = workers.map(worker => worker.result(once(worker.child, 'message').then(([value]) => value)))
  for (const worker of workers) worker.child.send('continue')
  const [a, b] = await Promise.all(results)
  assert.equal(a.calls + b.calls, 2)
  assert.equal(a.result.status, 'confirmed')
  assert.notEqual(a.result.replayed, b.result.replayed)
  assert.deepEqual(a.result.message, b.result.message)
  assert.equal(readMessages(f.db).length, 1)
})

test('reserved primary-key collision rejects before generation without altering history', async t => {
  const { db, owner, input, result } = await fixture(t)
  const alien = ownedDog(db, 'alien-return')
  const other = createTripService(db, { now }).create(alien.id, alien.sessionId, 'auto')
  const key = 'msg_auto_return_v1_' + createHash('sha256').update(JSON.stringify([
    'c10-auto-return-v1', 'owner', owner.sessionId, owner.id, input.tripId, result.intentId,
  ])).digest('hex')
  history(db, other.id, key)
  const prior = readMessages(db)
  let called = false
  await assert.rejects(returns(db, { generate: async () => { called = true } }).owner(input), /does not match/)
  assert.equal(called, false)
  assert.deepEqual(readMessages(db), prior)
  assert.deepEqual(readTrip(db, input.tripId), { status: 'running', ended_at: null })
})

for (const fault of ['INSERT', 'COMMIT']) {
  test(fault + ' fault rolls back Message, done and endedAt; same Trip can recover', async t => {
    const { db, input } = await fixture(t)
    const sql = fault === 'INSERT'
      ? "SELECT RAISE(ABORT, 'injected Message INSERT fault');"
      : "INSERT INTO return_fault(find_id) VALUES('missing-fk');"
    if (fault === 'COMMIT') db.exec('CREATE TABLE return_fault(find_id TEXT REFERENCES find(id) DEFERRABLE INITIALLY DEFERRED)')
    db.exec(`CREATE TRIGGER fail_return AFTER INSERT ON message BEGIN ${sql} END`)
    await assert.rejects(returns(db).owner(input), fault === 'INSERT' ? /injected Message INSERT/ : /FOREIGN KEY/)
    assert.equal(db.isTransaction, false)
    assert.deepEqual(readTrip(db, input.tripId), { status: 'running', ended_at: null })
    assert.deepEqual(readMessages(db), [])
    if (fault === 'COMMIT') assert.equal(db.prepare('SELECT count(*) n FROM return_fault').get().n, 0)
    db.exec('DROP TRIGGER fail_return')
    assert.equal((await returns(db).owner(input)).status, 'confirmed')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  })
}

for (const race of ['revoked', 'blocked', 'finished']) {
  test('generation race: ' + race, async t => {
    const { db, path, owner, input } = await fixture(t)
    const other = openDatabase(path)
    try {
      const service = returns(db, { generate: async evidence => {
        if (race === 'revoked') revokeSession(input.request, other)
        if (race === 'blocked') other.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run('["街景"]', input.dogId)
        if (race === 'finished') createTripService(other, { now: end }).finish(input.tripId, owner.sessionId, 'timeout')
        return draftFor(evidence)
      } })
      if (race === 'finished') assert.equal((await service.owner(input)).status, 'terminal')
      else await assert.rejects(service.owner(input), race === 'revoked' ? { code: 'NOT_FOUND' } : conflicts)
      assert.deepEqual(readMessages(db), [])
      assert.equal(readTrip(db, input.tripId).status, race === 'finished' ? 'timeout' : 'running')
    } finally { other.close() }
  })
}

test('foreign and hidden references reject even when they satisfy the plain foreign key', async t => {
  const { db, input, result } = await fixture(t)
  const other = ownedDog(db, 'foreign-reference-dog')
  const foreign = await discovery(db).owner({ action: 'create', dogId: other.id, request: request(other.cookie) })
  assert.equal(foreign.status, 'complete')
  db.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run('["街景"]', input.dogId)
  for (const id of [foreign.finds[0].id, result.finds.find(find => find.kind === 'scene').id]) {
    const service = returns(db, { generate: async evidence => {
      assert.equal(evidence.finds.length, 1)
      assert.ok(evidence.finds.every(find => find.id !== id))
      return { text: '离线受控文案', mentionsFindId: id }
    } })
    await assert.rejects(service.owner(input), /does not match/)
    assert.deepEqual(readMessages(db), [])
    assert.equal(readTrip(db, input.tripId).status, 'running')
  }
})

test('corrupt and held discovery never call the generator', async t => {
  const f = await fixture(t)
  f.db.prepare('UPDATE find SET title=? WHERE id=?').run('损坏的来源正文', f.result.finds[0].id)
  let calls = 0
  const generate = async () => { calls++ }
  await assert.rejects(returns(f.db, { generate }).owner(f.input), { code: 'DISCOVERY_RECEIPT_INVALID' })

  const v7 = migrations.filter(({ version }) => version <= 7)
  const { db, path } = mailboxDatabase(t, v7, readFileSync('tests/fixtures/schema-v1.sql', 'utf8'))
  const owner = ownedDog(db, 'held-return-owner')
  const c4 = createTripService(db, { now })
  const trip = c4.start(c4.create(owner.id, owner.sessionId, 'auto').id, owner.sessionId).trip
  db.prepare("INSERT INTO find(id,trip_id,kind,title,created_at) VALUES('old',?,'scene','历史发现',?)").run(trip.id, at)
  db.close()
  const upgraded = openDatabase(path)
  try {
    const result = await returns(upgraded, { generate }).owner({ tripId: trip.id, dogId: owner.id, request: request(owner.cookie) })
    assert.equal(result.status, 'held')
    assert.equal(readTrip(upgraded, trip.id).status, 'running')
    assert.deepEqual(readMessages(upgraded), [])
  } finally { upgraded.close() }
  assert.equal(calls, 0)
})

for (const reason of ['failed', 'timeout']) {
  test('generator ' + reason + ' finalizes without fabricating a Message', async t => {
    const { db, input } = await fixture(t)
    let calls = 0
    const service = returns(db, { generationTimeoutMs: 10, generate: async () => {
      calls++
      if (reason === 'failed') throw new Error('controlled failure')
      return new Promise(() => {})
    }, writeMessageInTransaction() { assert.fail('no Message is expected') } })
    const result = await service.owner(input)
    assert.equal(result.status, 'generation-failed')
    assert.equal(result.reason, reason)
    assert.equal(readTrip(db, input.tripId).status, reason)
    assert.equal((await service.owner(input)).status, 'terminal')
    assert.deepEqual(readMessages(db), [])
    assert.equal(calls, 1)
  })
}

test('trusted seed returns with its original intent and no owner-cookie authorization shortcut', async t => {
  const { db } = mailboxDatabase(t)
  insertDog(db, 'return-seed', 'seed-fixture', 1)
  const { trip } = await discovery(db).seed({ action: 'create', dogId: 'return-seed', intentId: 'sample-return' })
  const input = { tripId: trip.id, dogId: trip.dogId, intentId: 'sample-return' }
  let calls = 0
  const service = returns(db, { generate: async evidence => {
    calls++
    assert.equal(evidence.scope, 'seed')
    assert.ok(evidence.finds.every(find => find.sourceMode === null))
    return draftFor(evidence)
  } })
  await assert.rejects(service.seed({ ...input, intentId: 'wrong' }), { code: 'NOT_FOUND' })
  const owner = ownedDog(db, 'seed-intruder')
  await assert.rejects(service.owner({ ...input, request: request(owner.cookie) }), { code: 'NOT_FOUND' })
  assert.equal((await service.seed(input)).status, 'confirmed')
  assert.equal((await service.seed(input)).replayed, true)
  assert.equal(calls, 1)
})
