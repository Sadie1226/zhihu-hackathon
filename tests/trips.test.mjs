import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { createTripService, startsOnShanghaiDay } from '../lib/trips/service.ts'
import { ensureAnonymousSession, readSessionId } from '../lib/auth/session.ts'
import { handleTripRequest } from '../lib/trips/http.ts'

const root = resolve('.local/c4-tests')
mkdirSync(root, { recursive: true })
function dog(db, id, session) {
  db.prepare('INSERT INTO dog(id,session_id,personality_tags,assembly,created_at) VALUES(?,?,?,?,?)')
    .run(id, session, '["好奇","看物","直给"]',
      '{"cloth":"hoodie","hat":"beanie","glasses":null,"face":"hopeful"}', '2026-11-16T00:00:00Z')
}
function setup(t) {
  const directory = mkdtempSync(join(root, 'trip-'))
  const path = join(directory, 'app.sqlite')
  const db = openDatabase(path)
  dog(db, 'dog-a', 'session-a'); dog(db, 'dog-b', 'session-b')
  let at = '2026-11-17T00:00:00Z'
  const service = createTripService(db, { now: () => new Date(at) })
  t.after(() => {
    if (db.isOpen) db.close()
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  return { db, path, service, at: value => { at = value } }
}
const isConflict = error => error.code === 'CONFLICT'
const isMissing = error => error.code === 'NOT_FOUND'
function sent(db, id, threshold = 1) {
  db.prepare(`INSERT INTO exchange(id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at)
    VALUES(?,'dog-b','dog-a','gift',?,?,?)`).run(id,
    '{"kind":"gift","giftName":"测试礼物","note":null,"imagePath":null}', threshold, '2026-11-16T00:00:00Z')
}

test('create persists pending; seq increases per dog; one active trip including running', t => {
  const { service, db, at } = setup(t)
  const first = service.create('dog-a', 'session-a', 'wish')
  assert.equal(first.seq, 1); assert.equal(first.status, 'pending')
  assert.equal(first.startedAt, null); assert.equal(first.endedAt, null)
  assert.equal(startsOnShanghaiDay(db, 'dog-a', first.createdAt), 0)
  assert.throws(() => service.create('dog-a', 'session-a', 'wish'), isConflict)
  service.start(first.id, 'session-a')
  assert.throws(() => service.create('dog-a', 'session-a', 'friend'), isConflict)
  service.finish(first.id, 'session-a', 'done')
  at('2026-11-17T06:00:00Z')
  const second = service.create('dog-a', 'session-a', 'auto')
  assert.equal(second.seq, 2)
  assert.equal(service.create('dog-b', 'session-b', 'friend').seq, 1)
  assert.deepEqual(service.list('dog-a', 'session-a').map(x => x.seq), [2, 1])
  assert.equal(service.list('dog-a', 'session-a', 1)[0].id, second.id)
})

for (const status of ['done', 'failed', 'timeout']) {
  test(`running -> ${status}; terminal replay preserves ended_at, conflicting replay rejects`, t => {
    const { service, at } = setup(t)
    const trip = service.create('dog-a', 'session-a', 'auto')
    assert.throws(() => service.finish(trip.id, 'session-a', status), isConflict)
    const running = service.start(trip.id, 'session-a').trip
    assert.equal(running.status, 'running')
    assert.equal(running.startedAt, '2026-11-17T00:00:00.000Z')
    at('2026-11-17T00:01:00Z')
    const result = service.finish(trip.id, 'session-a', status)
    assert.equal(result.trip.status, status); assert.equal(result.message, null)
    assert.deepEqual(result.finds, [])
    at('2026-11-17T01:00:00Z')
    assert.deepEqual(service.finish(trip.id, 'session-a', status), result)
    assert.throws(() => service.finish(trip.id, 'session-a', status === 'done' ? 'failed' : 'done'), isConflict)
    assert.throws(() => service.start(trip.id, 'session-a'), isConflict)
  })
}

test('start delivers once by seq, preserves replied/read fields and started_at', t => {
  const { service, db, at } = setup(t)
  sent(db, 'due'); sent(db, 'later', 2)
  const trip = service.create('dog-a', 'session-a', 'auto')
  const first = service.start(trip.id, 'session-a')
  assert.deepEqual(first.delivered.map(x => x.id), ['due'])
  assert.equal(first.delivered[0].deliveredAt, first.trip.startedAt)
  assert.equal(first.delivered[0].payload.kind, 'gift')
  assert.equal(first.delivered[0].repliedAt, null); assert.equal(first.delivered[0].readAt, null)
  // B/E have subsequently written their own fields. C must preserve both.
  db.prepare('UPDATE exchange SET replied_at = ?, read_at = ? WHERE id = ?').run('2026-11-17T00:01:00Z', '2026-11-17T00:01:00Z', 'due')
  at('2026-11-17T00:02:00Z')
  const replay = service.start(trip.id, 'session-a')
  assert.deepEqual(replay.trip, first.trip); assert.deepEqual(replay.delivered, [])
  service.finish(trip.id, 'session-a', 'done')
  const row = db.prepare('SELECT * FROM exchange WHERE id = ?').get('due')
  assert.equal(row.delivered_at, first.trip.startedAt)
  assert.equal(row.replied_at, '2026-11-17T00:01:00Z'); assert.equal(row.read_at, row.replied_at)
  assert.equal(db.prepare('SELECT delivered_at FROM exchange WHERE id = ?').get('later').delivered_at, null)
})

test('delivery failure rolls back start and every exchange in the same transaction', t => {
  const { service, db } = setup(t)
  sent(db, 'first'); sent(db, 'second')
  db.exec(`CREATE TRIGGER fail_delivery BEFORE UPDATE OF delivered_at ON exchange
    WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)
  const trip = service.create('dog-a', 'session-a', 'wish')
  assert.throws(() => service.start(trip.id, 'session-a'), /injected failure/)
  assert.deepEqual(service.get(trip.id, 'session-a'), trip)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM exchange WHERE delivered_at IS NOT NULL').get().n, 0)
  db.exec('DROP TRIGGER fail_delivery')
  assert.equal(service.start(trip.id, 'session-a').delivered.length, 2)
})

test('Shanghai day uses starts, counts failed/timeout, resets at 16:00 UTC and enforces 6h gap', t => {
  const { service, db, at } = setup(t)
  at('2026-11-16T16:00:00Z') // Shanghai Nov 17 00:00
  const first = service.create('dog-a', 'session-a', 'auto')
  service.start(first.id, 'session-a'); service.finish(first.id, 'session-a', 'timeout')
  at('2026-11-16T21:59:59Z')
  const second = service.create('dog-a', 'session-a', 'auto')
  assert.throws(() => service.start(second.id, 'session-a'), isConflict)
  at('2026-11-16T22:00:00Z')
  service.start(second.id, 'session-a'); service.finish(second.id, 'session-a', 'failed')
  assert.equal(startsOnShanghaiDay(db, 'dog-a', '2026-11-17T15:59:59Z'), 2)
  at('2026-11-17T15:59:59Z')
  assert.throws(() => service.create('dog-a', 'session-a', 'auto'), isConflict)
  at('2026-11-17T16:00:00Z')
  assert.equal(startsOnShanghaiDay(db, 'dog-a', '2026-11-17T16:00:00Z'), 0)
  service.start(service.create('dog-a', 'session-a', 'auto').id, 'session-a')
})

test('pending created yesterday consumes no quota; midnight finish belongs to start day', t => {
  const { service, db, at } = setup(t)
  at('2026-11-16T15:00:00Z')
  const trip = service.create('dog-a', 'session-a', 'friend')
  at('2026-11-17T15:59:00Z')
  service.start(trip.id, 'session-a')
  at('2026-11-17T16:30:00Z')
  service.finish(trip.id, 'session-a', 'done')
  assert.equal(startsOnShanghaiDay(db, 'dog-a', '2026-11-16T15:00:00Z'), 0)
  assert.equal(startsOnShanghaiDay(db, 'dog-a', '2026-11-17T15:59:00Z'), 1)
  assert.equal(startsOnShanghaiDay(db, 'dog-a', '2026-11-17T16:30:00Z'), 0)
})

test('start rechecks quota inside its transaction for pre-created pending tasks', t => {
  const { service, db } = setup(t)
  const pending = service.create('dog-a', 'session-a', 'auto')
  // Simulate previously imported history after this pending task was created.
  for (const [seq, time] of [[2, '2026-11-16T16:00:00Z'], [3, '2026-11-16T22:00:00Z']]) {
    db.prepare(`INSERT INTO trip(id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
      VALUES(?,'dog-a',?,'done','auto',?,?,?)`).run(`history-${seq}`, seq, time, time, time)
  }
  assert.throws(() => service.start(pending.id, 'session-a'), isConflict)
  assert.equal(service.get(pending.id, 'session-a').startedAt, null)
})

test('all service operations isolate sessions; invalid input and backwards clock reject', t => {
  const { service, at } = setup(t)
  const trip = service.create('dog-a', 'session-a', 'auto')
  for (const op of [() => service.get(trip.id, 'session-b'), () => service.start(trip.id, 'session-b'),
    () => service.finish(trip.id, 'session-b', 'done'), () => service.list('dog-a', 'session-b'),
    () => service.create('dog-a', 'session-b', 'auto'), () => service.get('missing', 'session-a')]) assert.throws(op, isMissing)
  assert.throws(() => service.create('dog-b', 'session-b', 'bad'), isConflict)
  assert.throws(() => service.finish(trip.id, 'session-a', 'pending'), isConflict)
  for (const limit of [0, 101, 1.5, NaN]) assert.throws(() => service.list('dog-a', 'session-a', limit), isConflict)
  at('2026-11-16T00:00:00Z')
  assert.throws(() => service.start(trip.id, 'session-a'), isConflict)
  at('2026-11-17T00:00:00Z'); service.start(trip.id, 'session-a')
  at('2026-11-16T00:00:00Z')
  assert.throws(() => service.finish(trip.id, 'session-a', 'done'), isConflict)
})

test('existing finds only, assetPath and fixture mode preserved; restart retains state', t => {
  const { service, db, path } = setup(t)
  const trip = service.create('dog-a', 'session-a', 'wish')
  service.start(trip.id, 'session-a')
  db.prepare(`INSERT INTO find(id,trip_id,kind,title,source_url,source_mode,asset_path,created_at)
    VALUES('fixture-find',?,'zhihu','fixture','https://www.zhihu.com/question/1','fixture',NULL,?)`).run(trip.id, trip.createdAt)
  const finished = service.finish(trip.id, 'session-a', 'done')
  assert.equal(finished.finds.length, 1); assert.equal(finished.finds[0].assetPath, null)
  assert.equal(finished.finds[0].sourceMode, 'fixture'); assert.equal(finished.message, null)
  db.close()
  const reopened = openDatabase(path)
  try { assert.deepEqual(createTripService(reopened).get(trip.id, 'session-a'), finished.trip) }
  finally { reopened.close() }
})

test('timeout duration is disabled by default; injected threshold and timestamp are deterministic', t => {
  const { service, at } = setup(t)
  const trip = service.create('dog-a', 'session-a', 'auto')
  service.start(trip.id, 'session-a')
  at('2026-11-17T00:01:00Z')
  assert.equal(service.timeoutIfDue(trip.id, 'session-a'), null)
  assert.equal(service.timeoutIfDue(trip.id, 'session-a', 60001), null)
  assert.throws(() => service.timeoutIfDue(trip.id, 'session-a', 0), /positive integer/)
  const result = service.timeoutIfDue(trip.id, 'session-a', 60000)
  assert.equal(result.trip.status, 'timeout'); assert.equal(result.trip.endedAt, '2026-11-17T00:01:00.000Z')
  at('2026-11-17T00:02:00Z')
  assert.equal(service.timeoutIfDue(trip.id, 'session-a', 60000), null)
  assert.equal(service.get(trip.id, 'session-a').endedAt, result.trip.endedAt)
})

test('two processes contend on SQLite: exactly one creates an active trip', { timeout: 15000 }, async t => {
  const { db, path } = setup(t)
  const workers = [0, 1].map(() => fork(new URL('./helpers/trip-worker.mjs', import.meta.url), [path],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true }))
  t.after(() => workers.forEach(worker => { if (worker.exitCode === null) worker.kill() }))
  const exits = workers.map(worker => once(worker, 'exit'))
  await Promise.all(workers.map(async worker => assert.equal((await once(worker, 'message'))[0], 'ready')))
  const responses = workers.map(worker => once(worker, 'message'))
  workers.forEach(worker => worker.send('go'))
  const results = await Promise.all(responses)
  assert.deepEqual(results.map(([result]) => result.status).sort(), ['CONFLICT', 'ok'])
  await Promise.all(exits)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM trip WHERE status IN ('pending','running')").get().n, 1)
})

test('anonymous helper issues opaque cookie, hashes stored ID, rotates unknown and reuses owned session', t => {
  const { db } = setup(t)
  const request = new Request('http://localhost/')
  const first = ensureAnonymousSession(request, db, true)
  assert.match(first.setCookie, /^__Host-zhihu_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure$/)
  assert.ok(!first.setCookie.includes(first.sessionId))
  const cookie = first.setCookie.split(';')[0]
  const owned = new Request('http://localhost/', { headers: { cookie } })
  assert.equal(readSessionId(owned, true), first.sessionId)
  assert.notEqual(ensureAnonymousSession(owned, db, true).sessionId, first.sessionId)
  dog(db, 'adopted', first.sessionId)
  assert.deepEqual(ensureAnonymousSession(owned, db, true), { sessionId: first.sessionId, setCookie: null })
  assert.equal(readSessionId(new Request('http://localhost/', { headers: { cookie: `${cookie}; ${cookie}` } }), true), null)
  assert.equal(readSessionId(new Request('http://localhost/', { headers: { cookie: '__Host-zhihu_session=bad' } }), true), null)
})

test('HTTP lifecycle: ownership, JSON whitelist, error shape, no-store and read-only GET', async t => {
  const { db } = setup(t)
  const session = ensureAnonymousSession(new Request('http://localhost/'), db)
  dog(db, 'http-dog', session.sessionId)
  const cookie = session.setCookie.split(';')[0]
  async function call(action, id, body, query = '', extra = {}) {
    const request = new Request(`http://localhost/api/test${query}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return handleTripRequest(request, action, id, () => db)
  }
  assert.deepEqual(await (await call('list', 'http-dog')).json(), { trips: [] })
  for (const query of ['?limit=0', '?limit=101', '?limit=1.2', '?limit=1&limit=2', '?session_id=session-a']) {
    assert.equal((await call('list', 'http-dog', undefined, query)).status, 409)
  }
  assert.equal((await call('create', 'http-dog', { trigger: 'auto', session_id: 'session-a' })).status, 409)
  assert.equal((await call('create', 'http-dog', { trigger: 'auto' }, '', { origin: 'http://attacker.test' })).status, 409)
  assert.equal((await call('create', 'http-dog', { trigger: 'auto' }, '', { 'content-type': 'text/plain' })).status, 409)
  assert.equal((await call('create', 'dog-a', { trigger: 'auto' })).status, 404)
  const created = await call('create', 'http-dog', { trigger: 'wish' })
  assert.equal(created.status, 200); assert.equal(created.headers.get('cache-control'), 'no-store')
  const { trip } = await created.json()
  const before = db.prepare('SELECT total_changes() n').get().n
  assert.equal((await (await call('get', trip.id)).json()).trip.status, 'pending')
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before)
  assert.equal((await call('get', trip.id, undefined, '', { cookie: '' })).status, 404)
  assert.equal((await call('start', trip.id, { started_at: '2030-01-01' })).status, 409)
  assert.equal((await call('start', trip.id, {})).status, 200)
  assert.equal((await call('finish', trip.id, { status: 'timeout' })).status, 200)
  const conflict = await call('finish', trip.id, { status: 'done' })
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'CONFLICT')
  const unavailable = await handleTripRequest(new Request('http://localhost/', { headers: { cookie } }), 'get', trip.id,
    () => { throw new Error('private/database/path') })
  assert.equal(unavailable.status, 503)
  assert.ok(!(await unavailable.text()).includes('private'))
})
