import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { fixtureSession } from './helpers/owner-session.mjs'
import { createZhihuSearchClient } from '../lib/zhihu/client.ts'
import { createTripDiscoverer } from '../lib/trips/discover.ts'
import { createFindStore, handleFindsRequest } from '../lib/trips/finds.ts'
import { createTripService } from '../lib/trips/service.ts'
import { searchForTrip } from '../lib/trips/search-proof.ts'
import { revokeSession } from '../lib/auth/session.ts'

// Every provider response here is synthetic fixture input. No .env, secrets or network.
const at = '2026-11-20T00:01:00Z'
const item = { Title: 'synthetic fixture snow', ContentText: 'synthetic fixture excerpt',
  Url: 'https://www.zhihu.com/question/123/answer/456', AuthorityLevel: '4', VoteUpCount: 9 }
const envelope = items => ({ Code: 0, Data: { Items: items } })
function provider(handler = () => Response.json(envelope([item]))) {
  let calls = 0
  const queries = []
  const search = createZhihuSearchClient({ accessSecret: 'synthetic-fixture-token',
    now: () => Date.parse(at), fetch: async (url, init) => {
      calls++; queries.push(url.searchParams.get('Query')); return handler(url, init)
    } })
  return { search, queries, get calls() { return calls } }
}
function setup(t, legacy = false) {
  const root = resolve('.local/c6-wire-tests'); mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'case-')), path = join(directory, 'app.sqlite')
  const db = openDatabase(path)
  t.after(() => { if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }) })
  const session = legacy ? { sessionId: 'fixture-internal', setCookie: '' } : fixtureSession(db)
  db.prepare(`INSERT INTO dog(id,session_id,owner_id,personality_tags,interest_categories,assembly,created_at)
    VALUES('fixture-dog',?,?,'["好奇","看物","直给"]','["自然风景","冷知识"]',
    '{"outfit":null,"cloth":"S02-leaf-cape","accessory":null,"face":"F01-neutral"}',?)`).run(session.sessionId, legacy ? null : session.sessionId, at)
  db.prepare(`INSERT INTO wish(id,dog_id,text,category,created_at) VALUES('fixture-wish','fixture-dog','想看雪','自然风景',?)`).run(at)
  const service = createTripService(db, { now: () => new Date(at), newId: () => 'fixture-trip' })
  service.create('fixture-dog', session.sessionId, 'wish'); service.start('fixture-trip', session.sessionId)
  const cookie = session.setCookie.split(';')[0]
  const request = new Request('http://localhost', { headers: { cookie } })
  const execute = p => createTripDiscoverer(db, { provider: p, now: () => new Date(at) })('fixture-trip', request)
  const rows = () => db.prepare('SELECT * FROM find').all()
  return { db, path, session: session.sessionId, cookie, request, service, execute, rows }
}

test('C4 start -> C5 protocol -> verified store -> authenticated GET -> finish -> restart history', async t => {
  const { db, path, session, cookie, service, execute } = setup(t), p = provider()
  const result = await execute(p.search)
  assert.equal(result.ok, true); assert.equal(result.httpStatus, 200); assert.equal(result.finds.length, 1)
  assert.deepEqual(p.queries, ['想看雪'])
  const saved = result.finds[0]
  assert.equal(saved.sourceMode, 'live') // synthetic protocol-path assertion, not a real live test
  assert.equal(saved.authorityLevel, 4); assert.equal(saved.assetPath, null)
  assert.equal(saved.sourceUrl, item.Url)
  const changes = db.prepare('SELECT total_changes() n').get().n
  const response = handleFindsRequest(new Request('http://localhost/api/trips/fixture-trip/finds',
    { headers: { cookie } }), 'fixture-trip', () => db)
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('vary'), 'Cookie'); assert.deepEqual(await response.json(), { finds: [saved] })
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changes)
  const finished = service.finish('fixture-trip', session, 'done')
  assert.deepEqual(finished.finds.map(x => ({ ...x })), [saved]); assert.equal(finished.message, null)
  db.close(); const reopened = openDatabase(path)
  try { assert.deepEqual(createFindStore(reopened).list('fixture-trip', session), [saved]) }
  finally { reopened.close() }
})

test('identical concurrent retries insert once and retain first timestamp; changed metadata cannot overwrite', async t => {
  const { execute, rows } = setup(t), p = provider()
  const [a, b] = await Promise.all([execute(p.search), execute(p.search)])
  assert.deepEqual(a.finds, b.finds); assert.equal(rows().length, 1)
  const changed = provider(() => Response.json(envelope([{ ...item, Title: 'changed fixture' }])))
  await assert.rejects(execute(changed.search), { code: 'CONFLICT' })
  assert.equal(rows()[0].title, item.Title)
})

test('blocked wish/category never reaches provider and blocked result is not stored', async t => {
  const { db, execute, rows } = setup(t), p = provider()
  for (const topic of ['雪', '自然风景']) {
    db.prepare('UPDATE dog SET blocked_topics=?').run(JSON.stringify([topic]))
    assert.deepEqual((await execute(p.search)).finds, []); assert.equal(p.calls, 0)
  }
  db.exec(`UPDATE dog SET blocked_topics='["fixture snow"]'`)
  assert.deepEqual((await execute(p.search)).finds, []); assert.equal(p.calls, 1); assert.equal(rows().length, 0)
})

test('invalid wish is rejected before provider; category fallback uses existing keywords and skips blocked terms', async t => {
  const { db, execute } = setup(t), p = provider()
  db.prepare('UPDATE wish SET text=?').run('\n') // SQLite trim() differs from JS trim(); valid legacy DB shape
  await assert.rejects(execute(p.search), { code: 'CONFLICT' }); assert.equal(p.calls, 0)
  // auto/friend have no friend-selection implementation here: contract category fallback only.
  db.exec("UPDATE trip SET trigger='auto'; UPDATE dog SET blocked_topics='[\"下雪\"]'")
  await execute(p.search); assert.deepEqual(p.queries, ['秋天的树'])
})

test('selection keeps the start-time wish rather than replacing it with a newer wish', async t => {
  const { db, execute } = setup(t), p = provider()
  db.prepare(`INSERT INTO wish(id,dog_id,text,category,created_at) VALUES('new','fixture-dog','另一个主题','冷知识',?)`).run(at)
  await execute(p.search); assert.deepEqual(p.queries, ['想看雪'])
  assert.equal(db.prepare('SELECT wish_id FROM trip').get().wish_id, 'fixture-wish')
})

for (const [status, expected] of [[401, 'AUTH'], [429, 'RATE_LIMITED']]) {
  test(`provider ${expected} cache miss yields an empty result with internal metadata and no retry`, async t => {
    const { execute, rows } = setup(t), p = provider(() => Response.json({}, { status }))
    const result = await execute(p.search)
    assert.equal(result.ok, true); assert.deepEqual(result.finds, [])
    assert.deepEqual(result.degradation, { code: expected, alert: expected === 'AUTH' })
    assert.equal(p.calls, 1); assert.equal(rows().length, 0)
  })
}

test('ordinary server failure stays NETWORK and does not initiate a fallback or retry', async t => {
  const { execute, rows } = setup(t), p = provider(() => Response.json({}, { status: 503 }))
  const result = await execute(p.search)
  assert.equal(result.ok, false); assert.equal(result.error.code, 'NETWORK')
  assert.equal(result.error.retriable, true); assert.equal(result.fallback, null)
  assert.equal(p.calls, 1); assert.equal(rows().length, 0)
})

test('network exception and successful empty response never fabricate findings', async t => {
  const { execute, rows } = setup(t)
  const p = provider(() => { throw new Error('synthetic private transport detail') })
  const failed = await execute(p.search)
  assert.equal(failed.error.code, 'NETWORK'); assert.ok(!JSON.stringify(failed).includes('private'))
  const empty = await execute(provider(() => Response.json(envelope([]))).search)
  assert.equal(empty.ok, true); assert.deepEqual(empty.finds, []); assert.equal(rows().length, 0)
})

test('invalid provider URL/metadata/mode is rejected even when a trusted injected operation returns ok', async t => {
  const { execute, rows } = setup(t)
  const valid = { title: 'synthetic fixture', excerpt: null, sourceUrl: item.Url, sourceMode: 'live', authorityLevel: 4, voteUpCount: 0 }
  for (const patch of [{ sourceUrl: 'https://evil.test/p/1' }, { sourceUrl: 'https://www.zhihu.com:443/question/123' },
    { sourceMode: 'cache' }, { sourceMode: 'fixture' }, { voteUpCount: -1 }, { authorityLevel: 9 }, { title: '' }]) {
    const result = await execute(async () => ({ ok: true, items: [{ ...valid, ...patch }], httpStatus: 200, fetchedAt: at }))
    assert.equal(result.ok, false); assert.equal(result.error.code, 'NETWORK')
  }
  assert.equal(rows().length, 0)
})

test('forged/cloned proofs and plain sourceMode=live cannot authorize storage', async t => {
  const { db, session, rows } = setup(t), store = createFindStore(db)
  for (const fake of [{ verifiedSearch: true }, {}, null, { sourceMode: 'live', tripId: 'fixture-trip' }]) {
    assert.throws(() => store.writeVerified(fake, session), { code: 'CONFLICT' })
  }
  const result = await searchForTrip({ tripId: 'fixture-trip', dogId: 'fixture-dog', ownerId: session,
    query: '想看雪', category: '自然风景', blockedTopics: [] }, provider().search)
  assert.throws(() => store.writeVerified(JSON.parse(JSON.stringify(result.proof)), session), { code: 'CONFLICT' })
  assert.throws(() => store.write({ tripId: 'fixture-trip', kind: 'zhihu', title: 'fixture', excerpt: null,
    sourceUrl: item.Url, sourceMode: 'live', authorityLevel: null, voteUpCount: null, assetPath: null }, session), { code: 'CONFLICT' })
  assert.equal(rows().length, 0)
})

test('trip finishing during network request prevents commit and network holds no SQLite write lock', async t => {
  const { db, path, session, execute, rows } = setup(t)
  const second = openDatabase(path)
  try {
    const p = provider(() => {
      second.exec('BEGIN IMMEDIATE'); second.exec('COMMIT') // would fail if network spanned a write transaction
      createTripService(second, { now: () => new Date(at) }).finish('fixture-trip', session, 'done')
      return Response.json(envelope([item]))
    })
    await assert.rejects(execute(p.search), { code: 'CONFLICT' }); assert.equal(rows().length, 0)
    assert.equal(db.prepare('SELECT status FROM trip').get().status, 'done')
  } finally { second.close() }
})

test('ownership and latest blocked topics are rechecked when committing', async t => {
  const { db, execute, request, rows } = setup(t)
  const p = provider(() => {
    db.exec(`UPDATE dog SET blocked_topics='["雪"]'`)
    return Response.json(envelope([item]))
  })
  await assert.rejects(execute(p.search), { code: 'CONFLICT' }); assert.equal(rows().length, 0)
  db.exec("UPDATE dog SET blocked_topics='[]'")
  const revokedOwner = provider(() => {
    revokeSession(request, db)
    return Response.json(envelope([item]))
  })
  await assert.rejects(execute(revokedOwner.search), { code: 'NOT_FOUND' }); assert.equal(rows().length, 0)
})

test('cross-owner, missing session and terminal trips fail before search; historical GET still works', async t => {
  const { db, session, cookie, service, execute } = setup(t), p = provider()
  const discover = createTripDiscoverer(db, { provider: p.search })
  for (const other of ['', 'fixture-other']) await assert.rejects(discover('fixture-trip', other), { code: 'NOT_FOUND' })
  await assert.rejects(discover('missing', session), { code: 'NOT_FOUND' })
  service.finish('fixture-trip', session, 'timeout')
  await assert.rejects(execute(p.search), { code: 'CONFLICT' }); assert.equal(p.calls, 0)
  const response = handleFindsRequest(new Request('http://localhost/api/trips/fixture-trip/finds',
    { headers: { cookie } }), 'fixture-trip', () => db)
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { finds: [] })
  assert.equal(handleFindsRequest(new Request('http://localhost'), 'fixture-trip', () => db).status, 404)
})

test('legacy and sample ownership keys never reach live search', async t => {
  const { db, session, rows } = setup(t, true), p = provider()
  const discover = createTripDiscoverer(db, { provider: p.search })
  await assert.rejects(discover('fixture-trip', session), { code: 'NOT_FOUND' })
  db.exec('UPDATE dog SET is_sample=1')
  await assert.rejects(discover('fixture-trip', session), { code: 'NOT_FOUND' })
  assert.equal(p.calls, 0)
  assert.equal(rows().length, 0)
})

test('verified insertion rollback is atomic and an existing fixture is never promoted to live', async t => {
  const { db, session, execute, rows } = setup(t)
  db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON find BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  await assert.rejects(execute(provider().search), /fixture failure/); assert.equal(rows().length, 0)
  db.exec('DROP TRIGGER fixture_fail')
  createFindStore(db, { now: () => new Date(at) }).write({ tripId: 'fixture-trip', kind: 'zhihu',
    title: item.Title, excerpt: item.ContentText, sourceUrl: item.Url, sourceMode: 'fixture',
    authorityLevel: 4, voteUpCount: 9, assetPath: null }, session)
  await assert.rejects(execute(provider().search), { code: 'CONFLICT' })
  assert.equal(rows().length, 1); assert.equal(rows()[0].source_mode, 'fixture')
})
