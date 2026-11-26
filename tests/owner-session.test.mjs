import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { recordAdoption } from '../lib/auth/adoption.ts'
import { assertOwnedDog, assertOwnedTrip, issueOwnerSession, resolveAuthContext, sessionCookieName } from '../lib/auth/session.ts'
import { handleAdoptionRequest } from '../lib/adoption/http.ts'
import { initializeDatabase, openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { handleTripRequest } from '../lib/trips/http.ts'

const at = '2026-11-22T00:00:00Z'
const dogV6Sql = `INSERT INTO dog(id,session_id,personality_tags,assembly,created_at,is_sample)
  VALUES (?,?,'["好奇","看物","直给"]','{"outfit":null,"cloth":"S02-leaf-cape","accessory":null,"face":"F01-neutral"}',?,?)`
const cookieOf = session => session.setCookie.split(';', 1)[0]
const request = (cookie = '', method = 'GET') => new Request('http://localhost/api/session', { method, headers: { cookie } })
const sha256 = input => createHash('sha256').update(input).digest('hex')
const issue = (db, subject) => issueOwnerSession(db, { provider: 'zhihu', subject })

function workdir(t) {
  const root = resolve('.local/owner-session-tests')
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'fixture-'))
  t.after(() => { assert.ok(dir.startsWith(root + sep)); rmSync(dir, { recursive: true, force: true }) })
  return dir
}

function claimDog(db, ownerId, id = 'receipt-1', content = 'fixture draft') {
  return recordAdoption(db, ownerId, { id, hash: sha256(content) }, (dogId, createdAt) => {
    db.prepare(`INSERT INTO dog (id,session_id,owner_id,personality_tags,assembly,created_at)
      VALUES (?,?,?,'["好奇","看物","直给"]','{"outfit":null,"cloth":"S02-leaf-cape","accessory":null,"face":"F01-neutral"}',?)`)
      .run(dogId, ownerId, ownerId, createdAt)
  })
}

test('same verified UID on two devices sees one stable owner and dog; another UID is isolated', async t => {
  const db = openDatabase(join(workdir(t), 'formal.sqlite'))
  try {
    // Opaque mock provider subject exceeds the safe integer range.
    const subject = '90071992547409931234'
    const first = issue(db, subject), second = issue(db, subject), foreign = issue(db, '90071992547409931235')
    assert.equal(first.ownerId, second.ownerId)
    assert.notEqual(first.ownerId, foreign.ownerId)
    assert.notEqual(cookieOf(first), cookieOf(second))
    assert.equal(db.prepare('SELECT count(*) AS n FROM owner').get().n, 2)
    assert.equal(db.prepare('SELECT provider_subject FROM owner WHERE id=?').get(first.ownerId).provider_subject, subject)
    assert.deepEqual(db.prepare('SELECT token_hash FROM owner_session WHERE owner_id=? ORDER BY token_hash').all(first.ownerId)
      .map(row => row.token_hash), [first, second].map(s => sha256(cookieOf(s).split('=')[1])).sort())
    const dogId = claimDog(db, first.ownerId)
    assert.equal(claimDog(db, second.ownerId), dogId)
    assert.throws(() => claimDog(db, second.ownerId, 'receipt-1', 'new draft'), error => error.reason === 'changed')
    assert.throws(() => claimDog(db, second.ownerId, 'receipt-2'), error => error.reason === 'already-owned')
    assert.throws(() => db.prepare('INSERT INTO adoption_receipt VALUES (?,?,?,?,?)')
      .run(foreign.ownerId, 'receipt-3', sha256('fake'), dogId, at), /FOREIGN KEY/)
    assert.throws(() => db.prepare(`INSERT INTO dog
      SELECT 'duplicate', name, session_id, personality_tags, interest_categories, assembly, is_sample,
        blocked_topics, created_at, owner_id FROM dog WHERE id=?`).run(dogId), /UNIQUE/)

    const auth = resolveAuthContext(request(cookieOf(second)), db)
    assertOwnedDog(db, dogId, auth)
    db.prepare("INSERT INTO trip(id,dog_id,seq,status,trigger,created_at) VALUES ('trip-owned',?,1,'pending','auto',?)")
      .run(dogId, at)
    assertOwnedTrip(db, 'trip-owned', auth)
    const foreignAuth = resolveAuthContext(request(cookieOf(foreign)), db)
    assert.throws(() => assertOwnedDog(db, dogId, foreignAuth), { code: 'NOT_FOUND' })
    assert.throws(() => assertOwnedTrip(db, 'trip-owned', foreignAuth), { code: 'NOT_FOUND' })
    const views = await Promise.all([first, second].map(s =>
      handleAdoptionRequest(request(cookieOf(s)), 'session', () => db).then(r => r.json())))
    assert.deepEqual(views[0], views[1])
    assert.equal(views[0].dog.id, dogId)
    assert.equal(views[0].provider, 'zhihu')
    assert.doesNotMatch(JSON.stringify(views), /ownerId|sessionId|providerSubject|tokenHash/)
    for (const value of [first.ownerId, subject, cookieOf(first).split('=')[1]]) {
      assert.ok(!JSON.stringify(views).includes(value))
    }
  } finally { db.close() }
})

test('expired, unknown, duplicate and legacy cookies fail; logout revokes only the current device', async t => {
  const db = openDatabase(join(workdir(t), 'formal.sqlite'))
  try {
    const first = issue(db, 'mock-uid'), second = issue(db, 'mock-uid'), expiring = issue(db, 'mock-uid')
    const dogId = claimDog(db, first.ownerId)
    const firstCookie = cookieOf(first)
    const unknown = `${sessionCookieName()}=${randomBytes(32).toString('base64url')}`
    db.prepare(dogV6Sql).run('legacy', `anon_${sha256(unknown.split('=')[1])}`, at, 0)
    for (const credential of [unknown, firstCookie + '; ' + firstCookie]) {
      assert.equal(resolveAuthContext(request(credential), db), null)
    }
    db.prepare('UPDATE owner_session SET created_at=1, expires_at=2 WHERE token_hash=?')
      .run(sha256(cookieOf(expiring).split('=')[1]))
    assert.equal(resolveAuthContext(request(cookieOf(expiring)), db), null)
    const logout = await handleAdoptionRequest(request(firstCookie, 'POST'), 'logout', () => db)
    assert.deepEqual(await logout.json(), { ok: true })
    assert.match(logout.headers.get('set-cookie'), /HttpOnly.*Max-Age=0/)
    assert.ok(db.prepare('SELECT revoked_at FROM owner_session WHERE token_hash=?')
      .get(sha256(firstCookie.split('=')[1])).revoked_at)
    assert.equal(resolveAuthContext(request(firstCookie), db), null)
    assert.equal((await handleTripRequest(request(firstCookie), 'list', dogId, () => db)).status, 404)
    assert.equal((await handleTripRequest(request(cookieOf(second)), 'list', dogId, () => db)).status, 200)
  } finally { db.close() }
})

test('development requires the actual isolated database, opt-in and a non-production process', t => {
  const dir = workdir(t)
  const dev = openDatabase(join(dir, 'a5-development-owner.sqlite'))
  const formal = openDatabase(join(dir, 'formal.sqlite'))
  const { NODE_ENV, APP_IDENTITY_PROVIDER, DATABASE_PATH } = process.env
  try {
    delete process.env.APP_IDENTITY_PROVIDER
    process.env.NODE_ENV = 'development'
    const zhihu = issue(formal, 'one-uid')
    process.env.APP_IDENTITY_PROVIDER = 'development'
    process.env.DATABASE_PATH = dev.location()
    const session = issueOwnerSession(dev, { provider: 'development', subject: 'one-uid' })
    assert.notEqual(session.ownerId, zhihu.ownerId)
    assert.equal(resolveAuthContext(request(cookieOf(session)), dev)?.namespace, 'development')
    assert.equal(resolveAuthContext(request(cookieOf(zhihu)), formal), null)
    assert.throws(() => issue(dev, 'one-uid'), /namespace/)
    assert.throws(() => issueOwnerSession(formal, { provider: 'development', subject: 'one-uid' }), /namespace/)
    process.env.NODE_ENV = 'production'
    // Use the production Cookie name to exercise the namespace check separately.
    const renamed = cookieOf(session).replace(/^zhihu_session=/, '__Host-zhihu_session=')
    assert.equal(resolveAuthContext(request(renamed), dev), null)
    delete process.env.APP_IDENTITY_PROVIDER
    assert.equal(resolveAuthContext(request(renamed), dev), null)
    assert.match(issue(formal, 'one-uid').setCookie, /^__Host-zhihu_session=.*HttpOnly.*SameSite=Lax.*Secure$/)
  } finally {
    for (const [key, value] of Object.entries({ NODE_ENV, APP_IDENTITY_PROVIDER, DATABASE_PATH })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    formal.close()
    dev.close()
  }
})


const dogSql = `INSERT INTO dog(id,session_id,personality_tags,assembly,created_at,is_sample)
  VALUES (?,?,'["好奇","看物","直给"]','{"cloth":"hoodie","hat":null,"glasses":null,"face":"hopeful"}',?,?)`

test('v4 to v5 is additive, rolls back failed DDL and preserves seed and legacy histories on reopen', t => {
  const path = join(workdir(t), 'historical.sqlite')
  let db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys=ON')
    initializeDatabase(db, () => readFileSync('tests/fixtures/schema-v1.sql', 'utf8'), migrations.slice(0, 3))
    db.prepare(dogSql).run('seed', 'seed-history', at, 1)
    db.prepare(dogSql).run('legacy', 'old-anonymous-key', at, 0)
    db.prepare("INSERT INTO trip(id,dog_id,seq,status,trigger,created_at) VALUES ('history','seed',1,'pending','auto',?)").run(at)
    const before = db.prepare('SELECT id,session_id,is_sample,created_at FROM dog ORDER BY id').all()
    const history = db.prepare('SELECT * FROM trip').all()
    const fail = [...migrations.slice(0, 3), { ...migrations[3], sql: connection => {
      migrations[3].sql(connection)
      return 'INVALID SQL'
    } }]
    assert.throws(() => initializeDatabase(db, () => '', fail))
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4)
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='owner'").get(), undefined)
    assert.equal(db.prepare("SELECT name FROM pragma_table_info('dog') WHERE name='owner_id'").get(), undefined)
    assert.deepEqual(db.prepare('SELECT * FROM trip').all(), history)
    db.close()
    db = openDatabase(path)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9)
    assert.deepEqual(db.prepare('SELECT id,session_id,is_sample,created_at FROM dog ORDER BY id').all(), before)
    assert.deepEqual(db.prepare('SELECT * FROM trip').all(), history)
    assert.equal(db.prepare('SELECT count(*) n FROM owner').get().n, 0)
    const { ownerId } = issue(db, 'mock-new-owner')
    assert.throws(() => db.prepare("UPDATE dog SET owner_id=?,session_id=? WHERE id='seed'").run(ownerId, ownerId), /invalid owner/)
    assert.equal(db.prepare('SELECT count(*) n FROM dog WHERE owner_id IS NULL').get().n, 2)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    db.close()
    db = openDatabase(path)
    assert.equal(db.prepare('SELECT count(*) n FROM owner').get().n, 1)
    assert.deepEqual(db.prepare('SELECT * FROM trip').all(), history)
  } finally { if (db.isOpen) db.close() }
})
