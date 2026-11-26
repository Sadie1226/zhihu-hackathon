import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { revokeSession } from '../lib/auth/session.ts'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { createTripExecutor } from '../lib/trips/executor.ts'
import { readOccurrenceFact } from '../lib/trips/occurrence-facts.ts'
import { createMemorySearchCache } from '../lib/trips/search-cache.ts'
import { createTripService } from '../lib/trips/service.ts'
import { mailboxDatabase, ownedDog, insertDog, insertExchange } from './helpers/mailbox-fixtures.mjs'

const at = '2026-11-26T02:00:00.000Z'
const now = () => new Date(at)
const request = owner => new Request('https://local.test/trips', { headers: { cookie: owner.cookie } })
const conditions = { sceneFile: 'scenes/nantou.png', season: 'spring', weather: 'clear', timeOfDay: 'morning' }
const article = { title: '受控文章', excerpt: null, sourceUrl: 'https://www.zhihu.com/question/191',
  sourceMode: 'live', authorityLevel: null, voteUpCount: null }
const live = { ok: true, httpStatus: 200, fetchedAt: at, items: [article] }
const failed = code => ({ ok: false, error: { code, detail: '受控错误', retriable: code === 'NETWORK' },
  alert: code === 'AUTH', httpStatus: code === 'NETWORK' ? 503 : code === 'AUTH' ? 401 : 429 })
const scenes = ({ trip }) => ['a', 'b'].map(id => ({ id, tripId: trip.id, dogId: trip.dogId, kind: 'scene',
  happenedAt: trip.startedAt, title: '受控场景 ' + id, excerpt: null, topics: [] }))
const count = (db, table) => db.prepare('SELECT count(*) AS n FROM ' + table).get().n
const execute = (executor, owner, input = { action: 'create' }) =>
  executor.owner({ ...input, dogId: owner.id, request: request(owner) })
const events = db => {
  db.exec(readFileSync('team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql', 'utf8'))
  db.exec("UPDATE event SET enabled=(code='any_shop_cat')")
}

function fixture(t, versions, schema) {
  const { db, path } = mailboxDatabase(t, versions, schema)
  const owner = ownedDog(db, 'executor-owner')
  const seen = { provider: 0, read: 0, write: 0, observations: 0, conditions: 0 }
  const memory = createMemorySearchCache()
  const cache = {
    async read(key) { assert.equal(db.isTransaction, false); seen.read++; return memory.read(key) },
    async write(key, value) { assert.equal(db.isTransaction, false); seen.write++; await memory.write(key, value) },
  }
  const make = ({ respond = () => live, ...rest } = {}) => createTripExecutor(db, {
    now, cache, provider: async () => { assert.equal(db.isTransaction, false); seen.provider++; return respond() },
    ownerObservations: context => { assert.equal(db.isTransaction, false); seen.observations++; return scenes(context) },
    conditions: () => { assert.equal(db.isTransaction, false); seen.conditions++; return conditions },
    ...rest,
  })
  return { db, path, owner, make, seen }
}

test('owner create executes G3/C7 and confirms discovery; same-trip replay stays complete with zero visible', async t => {
  const { db, owner, make, seen, path } = fixture(t)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8)
  events(db)
  insertDog(db, 'executor-sender', 'sample-sender', 1)
  insertExchange(db, 'due', 'executor-sender', owner.id, 1)
  const executor = make()
  const result = await execute(executor, owner)
  const tripId = result.trip.id
  assert.equal(result.status, 'complete')
  assert.equal(result.resumeAt, 'return')
  assert.equal(result.trip.status, 'running')
  assert.equal(result.confirmation.replayed, false)
  assert.equal(result.finds.length, 4)
  assert.equal(result.finds[0].sourceMode, 'live')
  assert.equal(count(db, 'trip_discovery_receipt'), 1)
  assert.equal(db.prepare('SELECT intent_id FROM trip_discovery_receipt').get().intent_id, result.intentId)
  assert.equal(count(db, 'find'), result.finds.length)
  const occurrence = readOccurrenceFact(db, tripId, owner.id)
  assert.ok(occurrence)
  assert.equal(result.finds.find(row => row.title === occurrence.text).sourceMode, null)
  db.exec("UPDATE event SET text='变更后的模板'")
  assert.deepEqual(readOccurrenceFact(db, tripId, owner.id), occurrence)
  const replay = await execute(executor, owner, { action: 'resume', tripId, retryDiscovery: true })
  assert.equal(replay.confirmation.replayed, true)
  assert.deepEqual(replay.finds, result.finds)
  assert.equal(count(db, 'trip'), 1)
  assert.equal(count(db, 'trip_snapshot'), 1)
  assert.equal(count(db, 'trip_event_fact'), 1)
  assert.equal(count(db, 'message'), 0)
  assert.deepEqual({ ...db.prepare('SELECT delivered_at, read_at, replied_at FROM exchange').get() },
    { delivered_at: at, read_at: null, replied_at: null })
  assert.deepEqual(seen, { provider: 1, read: 0, write: 1, observations: 1, conditions: 1 })

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { openDatabase } from './lib/db/bootstrap.ts';
    import { createTripExecutor } from './lib/trips/executor.ts';
    const input = JSON.parse(process.argv[1]);
    const db = openDatabase(input.path);
    const forbidden = () => { throw Error('unexpected I/O'); };
    try {
      const result = await createTripExecutor(db, { provider: forbidden, conditions: forbidden,
        ownerObservations: forbidden, cache: { read: forbidden, write: forbidden } }).owner({
        action: 'resume', tripId: input.tripId, dogId: input.dogId,
        request: new Request('https://local.test/trips', { headers: { cookie: input.cookie } })
      });
      console.log(JSON.stringify(result));
    } finally { db.close(); }
  `, JSON.stringify({ path, tripId, dogId: owner.id, cookie: owner.cookie })], { encoding: 'utf8', windowsHide: true })
  assert.equal(child.status, 0, child.stderr)
  const cold = JSON.parse(child.stdout)
  assert.equal(cold.confirmation.replayed, true)
  assert.deepEqual(cold.finds, result.finds)
  db.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run(JSON.stringify(['受控']), owner.id)
  const hidden = await execute(executor, owner, { action: 'resume', tripId, retryDiscovery: true })
  assert.equal(hidden.status, 'complete')
  assert.deepEqual(hidden.finds, [])
  assert.equal(seen.provider, 1)
})

test('seed run uses original intent, C7 and scene facts, without any owner I/O', async t => {
  const { db, make, seen } = fixture(t)
  insertDog(db, 'executor-seed', 'seed-fixture', 1)
  events(db)
  const executor = make({ seedObservations: scenes })
  const scope = { dogId: 'executor-seed', intentId: 'stable-seed' }
  const first = await executor.seed({ ...scope, action: 'create' })
  assert.equal(first.status, 'complete')
  assert.equal(first.finds.length, 3)
  assert.ok(first.finds.every(row => row.sourceMode === null))
  const resume = { ...scope, action: 'resume', tripId: first.trip.id }
  assert.equal((await executor.seed(resume)).confirmation.replayed, true)
  await assert.rejects(executor.seed({ ...resume, intentId: 'different-seed' }), { code: 'NOT_FOUND' })
  assert.equal(count(db, 'trip'), 1)
  assert.equal(count(db, 'trip_event_fact'), 1)
  assert.deepEqual(seen, { provider: 0, read: 0, write: 0, observations: 0, conditions: 1 })
})

test('v7 running hold precedes C7, observations and I/O, retaining history', async t => {
  const v7 = migrations.filter(({ version }) => version <= 7)
  const { db, path, owner } = fixture(t, v7, readFileSync('tests/fixtures/schema-v1.sql', 'utf8'))
  const service = createTripService(db, { now })
  const { trip } = service.start(service.create(owner.id, owner.sessionId, 'auto').id, owner.sessionId)
  db.prepare("INSERT INTO find(id,trip_id,kind,title,created_at) VALUES('old',?,'scene','旧证据',?)").run(trip.id, at)
  db.close()
  const migrated = openDatabase(path)
  const forbidden = () => assert.fail('held trip must not enter any material or I/O path')
  try {
    const executor = createTripExecutor(migrated, { now, provider: forbidden, ownerObservations: forbidden,
      conditions: forbidden, cache: { read: forbidden, write: forbidden } })
    const result = await execute(executor, owner, { action: 'resume', tripId: trip.id, retryDiscovery: true })
    assert.equal(result.status, 'held')
    assert.equal(count(migrated, 'trip_discovery_legacy_hold'), 1)
    assert.equal(count(migrated, 'trip_discovery_receipt'), 0)
    assert.equal(count(migrated, 'trip_event'), 0)
    assert.equal(migrated.prepare('SELECT title FROM find').get().title, '旧证据')
  } finally { migrated.close() }
})

test('new partial requires explicit resume and can confirm a trusted cache proof; handles AUTH, RATE_LIMITED and NETWORK', async t => {
  const { db, owner, make, seen } = fixture(t)
  const partial = await execute(make({ ownerObservations: () => [] }), owner)
  assert.equal(partial.status, 'partial')
  assert.equal(partial.finds[0].sourceMode, 'live')
  const resume = { action: 'resume', tripId: partial.trip.id }
  assert.equal((await execute(make(), owner, resume)).status, 'unconfirmed')
  assert.equal(seen.provider, 1)
  const retry = { ...resume, retryDiscovery: true }
  const network = await execute(make({ respond: () => failed('NETWORK') }), owner, retry)
  assert.equal(network.status, 'search-error')
  assert.equal(network.error.retriable, true)
  assert.equal(seen.read, 0)
  const completed = await execute(make(), owner, retry)
  assert.equal(completed.status, 'complete')
  assert.deepEqual(completed.finds[0], partial.finds[0])
  createTripService(db, { now }).finish(partial.trip.id, owner.sessionId, 'done')
  const later = () => new Date('2026-11-26T09:00:00.000Z')
  const cachedExecutor = make({ now: later, respond: () => failed('AUTH') })
  const cached = await execute(cachedExecutor, owner)
  assert.equal(cached.status, 'complete')
  assert.deepEqual(cached.degradation, { code: 'AUTH', alert: true })
  assert.equal(cached.finds[0].sourceMode, 'cache')
  const member = db.prepare('SELECT members_json FROM trip_discovery_receipt WHERE trip_id=?').get(cached.trip.id)
  assert.equal(JSON.parse(member.members_json)[0][2][3], at)
  assert.equal(seen.read, 1)
  const other = ownedDog(db, 'another-owner')
  const limited = await execute(make({ now: later, respond: () => failed('RATE_LIMITED') }), other)
  assert.equal(limited.status, 'partial')
  assert.deepEqual(limited.degradation, { code: 'RATE_LIMITED', alert: false })
  assert.ok(limited.finds.every(row => row.sourceMode === null))
  assert.equal(count(db, 'trip_discovery_legacy_hold'), 0)
})

test('revocation and terminal transition during I/O reject stale writes, and cross-owner resume is denied', async t => {
  const { db, path, owner, make, seen } = fixture(t)
  const foreign = ownedDog(db, 'foreign-owner')
  const connection = openDatabase(path)
  try {
    let id
    const closed = await execute(make({ respond: () => {
      id = db.prepare('SELECT id FROM trip WHERE dog_id=?').get(owner.id).id
      createTripService(connection, { now }).finish(id, owner.sessionId, 'timeout')
      return live
    } }), owner)
    assert.equal(closed.status, 'terminal')
    assert.equal(closed.trip.status, 'timeout')
    const resume = { action: 'resume', tripId: id, retryDiscovery: true }
    await assert.rejects(execute(make(), foreign, resume), { code: 'NOT_FOUND' })
    assert.deepEqual((await execute(make(), owner, resume)).trip, closed.trip)
    assert.equal(seen.provider, 1)
    await assert.rejects(execute(make({ respond: () => { revokeSession(request(foreign), connection); return live } }), foreign),
      { code: 'NOT_FOUND' })
    assert.equal(count(db, 'find'), 0)
    assert.equal(count(db, 'trip_discovery_receipt'), 0)
  } finally { connection.close() }
})

test('rollback at receipt write preserves start and frozen facts, and explicit resume safely confirms', async t => {
  const { db, owner, make } = fixture(t)
  events(db)
  const service = createTripService(db, { now })
  const pending = service.create(owner.id, owner.sessionId, 'auto')
  const resume = { action: 'resume', tripId: pending.id, retryDiscovery: true }
  db.exec(`CREATE TRIGGER fail_executor_receipt BEFORE INSERT ON trip_discovery_receipt
    BEGIN SELECT RAISE(ABORT, 'injected confirmation failure'); END`)
  await assert.rejects(execute(make(), owner, resume), /injected confirmation failure/)
  assert.equal(db.isTransaction, false)
  assert.equal(service.get(pending.id, owner.sessionId).status, 'running')
  assert.equal(count(db, 'trip_snapshot'), 1)
  assert.equal(count(db, 'trip_event_fact'), 1)
  assert.equal(count(db, 'find'), 0)
  assert.equal(count(db, 'trip_discovery_receipt'), 0)
  db.exec('DROP TRIGGER fail_executor_receipt')
  const result = await execute(make(), owner, resume)
  assert.equal(result.status, 'complete')
  assert.equal(count(db, 'trip'), 1)
  assert.equal(count(db, 'trip_snapshot'), 1)
  assert.equal(count(db, 'trip_event_fact'), 1)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('a blocked start discloses the existing pending Trip and resumes by ID without creating again', async t => {
  const { db, owner, make, seen } = fixture(t)
  const service = createTripService(db, { now })
  const first = service.create(owner.id, owner.sessionId, 'auto')
  service.start(first.id, owner.sessionId)
  service.finish(first.id, owner.sessionId, 'done')
  const pending = await execute(make(), owner)
  assert.equal(pending.status, 'pending')
  assert.equal(pending.resumeAt, 'start')
  assert.equal(pending.error.code, 'CONFLICT')
  assert.equal(pending.trip.status, 'pending')
  assert.equal(seen.provider, 0)
  assert.equal(count(db, 'trip_snapshot'), 1)
  await assert.rejects(execute(make(), owner), { code: 'CONFLICT' })
  const sixHours = () => new Date('2026-11-26T08:00:00.000Z')
  const resumed = await execute(make({ now: sixHours }), owner, { action: 'resume', tripId: pending.trip.id })
  assert.equal(resumed.status, 'complete')
  assert.equal(resumed.trip.id, pending.trip.id)
  assert.equal(count(db, 'trip'), 2)
  assert.equal(count(db, 'trip_snapshot'), 2)
})
