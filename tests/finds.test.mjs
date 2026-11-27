import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { createFindStore, handleFindsRequest } from '../lib/trips/finds.ts'
import { createTripService } from '../lib/trips/service.ts'
import { fixtureSession } from './helpers/owner-session.mjs'

// Explicit fixture material; no env file, credentials, search client or network calls.
const fixture = { sourceMode: 'fixture', title: 'C6 fixture snow material', excerpt: 'fixture excerpt',
  sourceUrl: 'https://www.zhihu.com/question/123/answer/456', authorityLevel: 2, voteUpCount: 7 }
const at = '2026-11-19T00:01:00.000Z'
const root = resolve('.local/c6-tests')
mkdirSync(root, { recursive: true })
function setup(t) {
  const directory = mkdtempSync(join(root, 'database-'))
  const path = join(directory, 'app.sqlite')
  const db = openDatabase(path)
  t.after(() => {
    if (db.isOpen) db.close()
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  const session = fixtureSession(db)
  const dog = id => db.prepare(`INSERT INTO dog(id,session_id,owner_id,personality_tags,assembly,created_at)
    VALUES(?,?,?,'["好奇","看物","直给"]','{"outfit":null,"cloth":"S02-leaf-cape","accessory":null,"face":"F01-neutral"}',?)`)
    .run(id, session.sessionId, session.sessionId, '2026-11-19T00:00:00Z')
  dog('fixture-owner')
  function trip(id, status = 'running', dogId = 'fixture-owner') {
    const seq = Number(db.prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM trip WHERE dog_id=?').get(dogId).n)
    db.prepare(`INSERT INTO trip(id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
      VALUES(?,?,?,?,'auto',?,?,?)`).run(id, dogId, seq, status, '2026-11-19T00:00:00Z',
        status === 'pending' ? null : '2026-11-19T00:00:00Z',
        ['done', 'failed', 'timeout'].includes(status) ? at : null)
  }
  trip('fixture-trip')
  const store = createFindStore(db, { now: () => new Date(at) })
  const data = (extra = {}) => ({ tripId: 'fixture-trip', kind: 'zhihu', ...fixture, assetPath: null, ...extra })
  return { db, path, session: session.sessionId, cookie: session.setCookie.split(';')[0], store, data, trip }
}
const conflict = { code: 'CONFLICT' }, missing = { code: 'NOT_FOUND' }
function snapshot(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all()])
}

test('running trip writes all Find fields, server ID/time and camelCase mapping, then survives reopen', t => {
  const { db, path, store, data, session } = setup(t)
  const input = data({ assetPath: '/assets/gen/fixture.webp' })
  const saved = store.write(input, session)
  assert.match(saved.id, /^find_[a-f0-9]{64}$/)
  assert.equal(saved.createdAt, at)
  assert.deepEqual(saved, { id: saved.id, ...input, createdAt: at })
  assert.deepEqual(store.list(input.tripId, session), [saved])
  assert.ok(!Object.keys(saved).some(key => key.includes('_') || key === 'sessionId'))
  db.close()
  const reopened = openDatabase(path)
  try { assert.deepEqual(createFindStore(reopened).list(input.tripId, session), [saved]) }
  finally { reopened.close() }
})

test('duplicate source uses stable ID and preserves first values/time; inconsistent retries conflict', t => {
  const { db, store, data, session } = setup(t)
  const first = store.write(data(), session)
  const changes = db.prepare('SELECT total_changes() n').get().n
  const retry = createFindStore(db, { now: () => new Date('2099-01-01T00:00:00Z') })
  assert.deepEqual(retry.write(data({ sourceUrl: fixture.sourceUrl + '/?utm_source=test#comment' }), session), first)
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changes)
  assert.equal(store.list('fixture-trip', session).length, 1)
  for (const extra of [{ title: 'changed fixture' }, { excerpt: 'changed fixture' }, { assetPath: '/assets/other.webp' }]) {
    assert.throws(() => retry.write(data(extra), session), conflict)
  }
  assert.deepEqual(store.list('fixture-trip', session), [first])
})

test('same URL in different trips stays separate; distinct answers/articles remain distinct', t => {
  const { store, data, session, trip } = setup(t)
  trip('fixture-trip-2')
  const first = store.write(data(), session)
  const second = store.write(data({ tripId: 'fixture-trip-2' }), session)
  assert.notEqual(first.id, second.id)
  for (const sourceUrl of [fixture.sourceUrl.replace('456', '457'), 'https://zhuanlan.zhihu.com/p/456']) {
    assert.notEqual(store.write(data({ sourceUrl }), session).id, first.id)
  }
  assert.equal(store.list('fixture-trip', session).length, 3)
  assert.deepEqual(store.list('fixture-trip-2', session), [second])
})

test('preexisting source row and a conflicting ID cannot be overwritten or claimed across trips', t => {
  const { db, store, data, session, trip } = setup(t)
  const first = store.write(data(), session)
  db.prepare('UPDATE find SET id=? WHERE id=?').run('legacy-fixture-id', first.id)
  assert.equal(store.write(data(), session).id, 'legacy-fixture-id')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM find').get().n, 1)
  trip('other-trip')
  db.prepare('UPDATE find SET id=?,trip_id=? WHERE id=?').run(first.id, 'other-trip', 'legacy-fixture-id')
  const before = snapshot(db)
  assert.throws(() => store.write(data(), session), conflict)
  assert.deepEqual(snapshot(db), before)
})

test('scene/moment require stable internal sourceKey and null mode; fixture markers do not enter these modes', t => {
  const { store, data, session } = setup(t)
  for (const kind of ['scene', 'moment']) {
    const input = data({ kind, sourceUrl: null, sourceMode: null, sourceKey: 'fixture-origin', authorityLevel: null, voteUpCount: null })
    const first = store.write(input, session)
    assert.equal(first.sourceMode, null)
    assert.deepEqual(store.write(input, session), first)
    assert.ok(!('sourceKey' in first))
    assert.throws(() => store.write({ ...input, sourceKey: undefined }, session), conflict)
    assert.throws(() => store.write({ ...input, sourceMode: 'fixture' }, session), conflict)
    assert.throws(() => store.write({ ...input, sourceMode: 'live' }, session), conflict)
  }
})

test('URL appearance is not live evidence; cache/live modes are reserved for a later verified integration', t => {
  const { store, data, session } = setup(t)
  for (const sourceMode of ['live', 'cache', null, 'unknown']) {
    assert.throws(() => store.write(data({ sourceMode }), session), conflict)
  }
  assert.deepEqual(store.list('fixture-trip', session), [])
})

test('invalid source URL, content, metadata, path, and caller-controlled ID/time are rejected atomically', t => {
  const { db, store, data, session } = setup(t)
  const invalid = [null, 'javascript:alert(1)', 'http://www.zhihu.com/question/1', 'https://evil.test/question/1',
    'https://www.zhihu.com.evil.test/question/1', 'https://user@www.zhihu.com/question/1',
    'https://www.zhihu.com/people/owner', 'https://www.zhihu.com/question/123/answer/not-an-id']
    .map(sourceUrl => ({ sourceUrl }))
  invalid.push({ title: '' }, { title: '  ' }, { excerpt: 5 }, { authorityLevel: 5 }, { authorityLevel: '4' },
    { voteUpCount: -1 }, { voteUpCount: 1.5 }, { assetPath: 'javascript:fixture' }, { assetPath: '/assets/../private' },
    { assetPath: '//external.test/a' }, { kind: 'made-up' }, { id: 'client-id' }, { createdAt: at }, { session_id: session })
  const before = snapshot(db)
  for (const extra of invalid) assert.throws(() => store.write(data(extra), session), conflict)
  assert.deepEqual(snapshot(db), before)
})

test('only running trips accept writes; missing/foreign sessions cannot read or write', t => {
  const { db, store, data, session, trip } = setup(t)
  for (const status of ['pending', 'done', 'failed', 'timeout']) {
    trip(status, status)
    assert.throws(() => store.write(data({ tripId: status }), session), conflict)
    assert.deepEqual(store.list(status, session), [])
  }
  for (const foreign of ['', 'wrong-session']) {
    assert.throws(() => store.write(data(), foreign), missing)
    assert.throws(() => store.list('fixture-trip', foreign), missing)
  }
  assert.throws(() => store.write(data({ tripId: 'missing' }), session), missing)
  assert.throws(() => store.list('missing', session), missing)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM find').get().n, 0)
})

test('insertion failure rolls back, releases write lock, and preserves unrelated facts', t => {
  const { db, store, data, session } = setup(t)
  const before = snapshot(db)
  db.exec("CREATE TRIGGER fail_find_insert BEFORE INSERT ON find BEGIN SELECT RAISE(ABORT,'injected failure'); END")
  assert.throws(() => store.write(data(), session), /injected failure/)
  assert.deepEqual(snapshot(db), before)
  db.exec('DROP TRIGGER fail_find_insert')
  assert.equal(store.write(data(), session).sourceMode, 'fixture')
})

test('GET handler enforces cookies/parameters, returns no-store empty/full collections and changes no business facts', async t => {
  const { db, store, data, session, cookie } = setup(t)
  const get = (id = 'fixture-trip', query = '', token = cookie, method = 'GET', getDb = () => db) =>
    handleFindsRequest(new Request(`http://localhost/api/trips/${id}/finds${query}`, { method, headers: { cookie: token } }), id, getDb)
  const beforeEmpty = snapshot(db)
  assert.deepEqual(await get().json(), { finds: [] })
  assert.deepEqual(snapshot(db), beforeEmpty)
  const saved = store.write(data(), session)
  const before = snapshot(db), changes = db.prepare('SELECT total_changes() n').get().n
  const response = get()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('vary'), 'Cookie')
  assert.deepEqual(await response.json(), { finds: [saved] })
  assert.deepEqual(snapshot(db), before)
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changes)
  for (const result of [get('missing'), get('', ''), get('fixture-trip', '?session_id=spoof'),
    get('fixture-trip', '', ''), get('fixture-trip', '', 'zhihu_session=bad'),
    get('fixture-trip', '', cookie + '; ' + cookie), get('fixture-trip', '', cookie, 'POST')]) {
    assert.equal(result.status, 404)
    assert.equal((await result.json()).code, 'NOT_FOUND')
    assert.equal(result.headers.get('cache-control'), 'no-store')
  }
  const foreign = fixtureSession(db).setCookie.split(';')[0]
  assert.equal(get('fixture-trip', '', foreign).status, 404)
  const down = get('fixture-trip', '', cookie, 'GET', () => { throw new Error('private/path fixture') })
  assert.equal(down.status, 503)
  assert.ok(!(await down.text()).includes('private/path'))
})

test('terminal history remains readable and existing finish response sees persisted finds without changing C4', t => {
  const { db, store, data, session } = setup(t)
  const saved = store.write(data(), session)
  const service = createTripService(db, { now: () => new Date(at) })
  const finished = service.finish('fixture-trip', session, 'done')
  assert.deepEqual(finished.finds.map(row => ({ ...row })), [saved])
  assert.deepEqual(store.list('fixture-trip', session), [saved])
  assert.throws(() => store.write(data(), session), conflict)
})

test('route exposes GET only with Node runtime/dynamic data; no public POST can submit live', () => {
  const code = readFileSync('app/api/trips/[id]/finds/route.ts', 'utf8')
  assert.match(code, /export const runtime = 'nodejs'/)
  assert.match(code, /export const dynamic = 'force-dynamic'/)
  assert.match(code, /export async function GET/)
  assert.doesNotMatch(code, /export (?:async )?function (?:POST|PATCH|PUT|DELETE)/)
})

test('concurrent processes write one identical fixture source once', async t => {
  const { db, path, data, session, store } = setup(t)
  const bootstrap = new URL('../lib/db/bootstrap.ts', import.meta.url).href
  const module = new URL('../lib/trips/finds.ts', import.meta.url).href
  const run = () => new Promise((resolveChild, reject) => {
    const script = `import {openDatabase} from ${JSON.stringify(bootstrap)};import {createFindStore} from ${JSON.stringify(module)};
      const db=openDatabase(${JSON.stringify(path)});try{console.log(createFindStore(db,{now:()=>new Date(${JSON.stringify(at)})})
      .write(${JSON.stringify(data())},${JSON.stringify(session)}).id)}finally{db.close()}`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true })
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolveChild(output.trim()) : reject(new Error(errors)))
  })
  const ids = await Promise.all([run(), run()])
  assert.equal(ids[0], ids[1])
  assert.equal(store.list('fixture-trip', session).length, 1)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})
