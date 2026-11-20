import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { ensureAnonymousSession } from '../lib/auth/session.ts'
import { handleMessageReadRequest, readTripMessage } from '../lib/messages/read.ts'

// All records are explicit fixtures; no B5 generation, OAuth, secrets or network.
const at = '2026-11-20T00:00:00Z'
function setup(t) {
  const root = resolve('.local/message-read-tests'); mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'case-')), path = join(directory, 'app.sqlite')
  const db = openDatabase(path)
  t.after(() => { if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }) })
  const session = ensureAnonymousSession(new Request('http://localhost'), db, false)
  const other = ensureAnonymousSession(new Request('http://localhost'), db, false)
  for (const [id, owner] of [['fixture-dog', session.sessionId], ['other-dog', other.sessionId]]) {
    db.prepare(`INSERT INTO dog(id,session_id,personality_tags,assembly,created_at)
      VALUES(?,?,'["好奇","看物","直给"]','{"cloth":"hoodie","hat":null,"glasses":null,"face":"hopeful"}',?)`).run(id, owner, at)
  }
  function trip(id, status = 'done', dog = 'fixture-dog') {
    const seq = Number(db.prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM trip WHERE dog_id=?').get(dog).n)
    db.prepare(`INSERT INTO trip(id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
      VALUES(?,?,?,?,'auto',?,?,?)`).run(id, dog, seq, status, at, status === 'pending' ? null : at,
        ['done', 'failed', 'timeout'].includes(status) ? at : null)
  }
  trip('fixture-trip'); trip('other-trip', 'done', 'other-dog')
  const message = (id = 'fixture-message', tripId = 'fixture-trip', time = at, find = null) => {
    db.prepare('INSERT INTO message(id,trip_id,text,mentions_find_id,created_at) VALUES(?,?,?,?,?)')
      .run(id, tripId, 'fixture 归来分享', find, time)
    return { id, tripId, text: 'fixture 归来分享', mentionsFindId: find, createdAt: time }
  }
  const cookie = session.setCookie.split(';')[0]
  const get = (id = 'fixture-trip', token = cookie, query = '', getDb = () => db) =>
    handleMessageReadRequest(new Request(`http://localhost/api/trips/${id}/message${query}`,
      { headers: { cookie: token } }), id, getDb)
  return { db, path, session: session.sessionId, cookie, other, trip, message, get }
}
function facts(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all()])
}

test('owned trip returns only camelCase Message DTO; null is an actual missing Message', async t => {
  const { db, session, message, get } = setup(t)
  assert.equal(readTripMessage(db, 'fixture-trip', session), null)
  assert.deepEqual(await get().json(), { message: null })
  const expected = message()
  assert.deepEqual(readTripMessage(db, 'fixture-trip', session), expected)
  const result = get(); assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { message: expected })
  assert.deepEqual(Object.keys(expected).sort(), ['id', 'tripId', 'text', 'mentionsFindId', 'createdAt'].sort())
})

test('missing/invalid trip and unauthorized sessions are NOT_FOUND, never empty success', async t => {
  const { db, session, message, get, other } = setup(t)
  message(); message('private-other-message', 'other-trip')
  for (const result of [get('missing'), get('other-trip'), get('', ''), get('fixture-trip', ''),
    get('fixture-trip', 'zhihu_session=bad'), get('fixture-trip', other.setCookie.split(';')[0]),
    get('fixture-trip', '', '?session_id=spoof')]) {
    assert.equal(result.status, 404); assert.equal((await result.json()).code, 'NOT_FOUND')
  }
  for (const id of ['', ' bad ', 'missing', 'other-trip', "fixture-trip' OR 1=1 --"]) {
    assert.throws(() => readTripMessage(db, id, session), { code: 'NOT_FOUND' })
  }
})

test('latest Message uses actual chronological order then ID DESC for equivalent timestamps', t => {
  const { db, session, message } = setup(t)
  message('older-z', 'fixture-trip', '2026-11-19T23:59:59Z')
  message('a', 'fixture-trip', '2026-11-20T00:00:00Z')
  const expected = message('z', 'fixture-trip', '2026-11-20T00:00:00.000Z')
  for (let n = 0; n < 3; n++) assert.deepEqual(readTripMessage(db, 'fixture-trip', session), expected)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM message').get().n, 3)
})

test('same-trip Find reference is readable; cross-trip references fail closed even for same owner', async t => {
  const { db, message, trip, get } = setup(t)
  trip('same-owner-other-trip')
  for (const [id, tripId] of [['own-find', 'fixture-trip'], ['same-owner-find', 'same-owner-other-trip'], ['foreign-find', 'other-trip']]) {
    db.prepare(`INSERT INTO find(id,trip_id,kind,title,source_mode,created_at) VALUES(?,?,'moment','fixture',NULL,?)`).run(id, tripId, at)
  }
  const expected = message('safe', 'fixture-trip', at, 'own-find')
  assert.deepEqual(await get().json(), { message: expected })
  for (const id of ['same-owner-find', 'foreign-find']) {
    db.prepare('UPDATE message SET mentions_find_id=? WHERE id=?').run(id, 'safe')
    const response = get(); assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.code, 'NETWORK'); assert.equal(body.retriable, true)
    assert.ok(!('message' in body)); assert.ok(!JSON.stringify(body).includes(id))
  }
})

test('a broken latest reference does not fall back to an older Message or mutate either', async t => {
  const { db, message, get } = setup(t)
  message('older')
  db.exec('PRAGMA foreign_keys=OFF')
  message('latest', 'fixture-trip', '2026-11-20T01:00:00Z', 'missing-fixture-find')
  db.exec('PRAGMA foreign_keys=ON')
  const before = facts(db)
  assert.equal(get().status, 503); assert.deepEqual(facts(db), before)
})

test('all trip statuses preserve existing read-only content and empty results', async t => {
  const { trip, message, get } = setup(t)
  for (const status of ['pending', 'running', 'done', 'failed', 'timeout']) {
    const id = 'fixture-' + status; trip(id, status)
    assert.deepEqual(await get(id).json(), { message: null })
    const expected = message('msg-' + status, id)
    assert.deepEqual(await get(id).json(), { message: expected })
  }
})

test('GET never changes any business fact, schema version or total_changes; works on read-only DB', async t => {
  const { db, path, session, message, get } = setup(t)
  const expected = message(), before = facts(db)
  const changes = db.prepare('SELECT total_changes() n').get().n
  const version = db.prepare('PRAGMA user_version').get().user_version
  for (let n = 0; n < 3; n++) assert.deepEqual(await get().json(), { message: expected })
  assert.deepEqual(facts(db), before); assert.equal(db.prepare('SELECT total_changes() n').get().n, changes)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, version)
  const { DatabaseSync } = await import('node:sqlite')
  const readOnly = new DatabaseSync(path, { readOnly: true })
  try { assert.deepEqual(readTripMessage(readOnly, 'fixture-trip', session), expected) }
  finally { readOnly.close() }
})

test('database restart preserves historical Message fields', t => {
  const { db, path, session, message } = setup(t), expected = message()
  db.close(); const reopened = openDatabase(path)
  try { assert.deepEqual(readTripMessage(reopened, 'fixture-trip', session), expected) }
  finally { reopened.close() }
})

test('all handler outcomes are no-store/Vary Cookie and failures never masquerade as null', async t => {
  const { db, cookie, get } = setup(t)
  for (const result of [get(), get('missing'), get('fixture-trip', cookie, '', () => { throw new Error('secret SQL C:/private.sqlite') })]) {
    assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('vary'), 'Cookie')
  }
  const down = get('fixture-trip', cookie, '', () => { throw new Error('secret SQL C:/private.sqlite') })
  assert.equal(down.status, 503)
  assert.deepEqual(await down.json(), { code: 'NETWORK', detail: '这次没连上，可以再试一次', retriable: true })
  db.exec('DROP TABLE message')
  const sqlFailure = get(); assert.equal(sqlFailure.status, 503)
  assert.ok(!JSON.stringify(await sqlFailure.json()).includes('SQLITE'))
})

test('duplicate cookies and query overrides rejected before DB access; route exports GET only', async t => {
  const { cookie, get } = setup(t)
  const unavailable = () => { throw new Error('must not access DB') }
  for (const result of [get('fixture-trip', cookie + '; ' + cookie, '', unavailable),
    get('fixture-trip', cookie, '?sessionId=spoof', unavailable)]) assert.equal(result.status, 404)
  const code = readFileSync('app/api/trips/[id]/message/route.ts', 'utf8')
  assert.match(code, /runtime = 'nodejs'/); assert.match(code, /dynamic = 'force-dynamic'/)
  assert.match(code, /export async function GET/)
  assert.doesNotMatch(code, /export (?:async )?function (?:POST|PATCH|PUT|DELETE)/)
})
