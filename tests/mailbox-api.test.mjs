import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { handleMailboxRequest } from '../lib/mailbox/http.ts'
import { gift, mailboxDatabase, raceMailboxWorkers, seedMailbox } from './helpers/mailbox-fixtures.mjs'

function get(db, target, query, cookie) {
  return handleMailboxRequest(new Request(`http://localhost/api/mailbox${query}`, { headers: { cookie } }),
    target, () => db)
}

function patch(db, id, cookie, { body = '{}', query = '', headers = {} } = {}) {
  return handleMailboxRequest(new Request(`http://localhost/api/exchanges/${id}/read${query}`, {
    method: 'PATCH', body, headers: { cookie, 'content-type': 'application/json', ...headers },
  }), { action: 'read', id }, () => db)
}

async function responseBody(response, status, code) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('vary'), 'Cookie')
  assert.equal(response.headers.get('set-cookie'), null)
  const body = await response.json()
  if (code) {
    assert.deepEqual(Object.keys(body).sort(), ['code', 'detail', 'retriable'])
    assert.equal(body.code, code)
    assert.equal(body.retriable, status === 503)
  }
  return body
}

test('owner inbox and outbox preserve all four kinds, times and provenance without writing or exposing private data', async t => {
  const { db } = mailboxDatabase(t)
  const { owner, other, otherTrip, empty } = seedMailbox(db)
  // Even legacy JSON with an extra field must not expose session data.
  db.prepare('UPDATE exchange SET payload = ? WHERE id = ?')
    .run(JSON.stringify({ ...gift, sessionId: other.sessionId }), 'ex_legacy')
  const before = db.prepare('SELECT total_changes() n').get().n
  const inbox = { action: 'inbox', id: owner.id }
  const query = filter => get(db, inbox, filter, owner.cookie)
  const { exchanges } = await responseBody(await query('?filter=all'), 200)
  assert.deepEqual(await responseBody(await query(''), 200), { exchanges })
  assert.deepEqual(new Set(exchanges.map(row => row.kind)), new Set(['find', 'greeting', 'gift', 'co_owner_message']))
  assert.ok(exchanges.every(row => row.toDog === owner.id))
  const arrived = await responseBody(await query('?filter=arrived'), 200)
  assert.deepEqual(arrived.exchanges, exchanges.filter(row => row.deliveredAt !== null))
  assert.ok(arrived.exchanges.some(row => row.readAt && !row.repliedAt))
  assert.ok(arrived.exchanges.some(row => row.repliedAt && !row.readAt))
  assert.deepEqual((await responseBody(await query('?filter=onTheWay'), 200)).exchanges.map(row => row.id), ['ex_greeting'])
  assert.deepEqual(exchanges.find(x => x.id === 'ex_legacy').payload, gift)
  assert.deepEqual(exchanges.find(x => x.id === 'ex_find'), {
    id: 'ex_find', fromDog: other.id, toDog: owner.id, kind: 'find',
    payload: { kind: 'find', findTitle: '一盏灯', findExcerpt: null, sourceUrl: 'https://www.zhihu.com/question/1',
      sourceFindId: 'find_source', sourceMode: 'live' },
    deliverAfterTripSeq: 1, createdAt: '2026-11-21T00:00:00Z',
    deliveredAt: '2026-11-21T01:00:00.000Z', repliedAt: null, readAt: null,
  })
  const outbox = await responseBody(await get(db, { action: 'outbox' }, '?from_dog=dog_owner', owner.cookie), 200)
  assert.deepEqual(outbox.exchanges.map(row => row.id), ['ex_sent_z', 'ex_sent_a', 'ex_sent_old'])
  assert.ok(outbox.exchanges.every(row => row.fromDog === owner.id))
  assert.deepEqual(outbox.exchanges[0].payload, { ...gift, sourceFindId: null, sourceMode: null })
  const serialized = JSON.stringify({ exchanges, outbox })
  for (const secret of [owner.sessionId, other.sessionId, owner.cookie, other.cookie, otherTrip.id,
    'sessionId', 'Private find title', 'Private find excerpt']) assert.ok(!serialized.includes(secret))
  assert.deepEqual(await responseBody(await get(db, { action: 'inbox', id: empty.id }, '?filter=all', empty.cookie), 200),
    { exchanges: [] })
  assert.deepEqual(await responseBody(await get(db, { action: 'outbox' }, '?from_dog=dog%20empty', empty.cookie), 200),
    { exchanges: [] })
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before)
})

test('GET validates query strings strictly and hides unknown or foreign dogs', async t => {
  const { db } = mailboxDatabase(t)
  const { owner, other } = seedMailbox(db)
  const inbox = { action: 'inbox', id: owner.id }
  const outbox = { action: 'outbox' }
  for (const query of ['?filter=read', '?filter=', '?filter=all&filter=arrived', '?sessionId=forged',
    '?filter=all&unknown=1', '?filter[]=all', '?filter=%ZZ']) {
    await responseBody(await get(db, inbox, query, owner.cookie), 409, 'CONFLICT')
  }
  for (const query of ['', '?from_dog=', '?from_dog=%20', '?from_dog=%00', '?from_dog=dog_owner&from_dog=dog_owner',
    '?to_dog=dog_owner', '?from_dog=dog_owner&to_dog=dog_other', '?from_dog[]=dog_owner', '?from_dog=%FF']) {
    await responseBody(await get(db, outbox, query, owner.cookie), 409, 'CONFLICT')
  }
  for (const cookie of ['', other.cookie, 'zhihu_session=malformed', `${owner.cookie}; ${owner.cookie}`]) {
    await responseBody(await get(db, inbox, '?filter=all', cookie), 404, 'NOT_FOUND')
    await responseBody(await get(db, outbox, '?from_dog=dog_owner', cookie), 404, 'NOT_FOUND')
  }
  await responseBody(await get(db, { action: 'inbox', id: 'missing' }, '', owner.cookie), 404, 'NOT_FOUND')
  await responseBody(await get(db, outbox, '?from_dog=missing', owner.cookie), 404, 'NOT_FOUND')
})

test('PATCH permits an explicit read of an arrived row and preserves delivery and reply times', async t => {
  const { db, path } = mailboxDatabase(t)
  const { owner, other } = seedMailbox(db)
  const before = db.prepare('SELECT total_changes() n').get().n
  await responseBody(await patch(db, 'ex_message', other.cookie), 404, 'NOT_FOUND')
  await responseBody(await patch(db, 'ex_message', ''), 404, 'NOT_FOUND')
  await responseBody(await patch(db, 'missing', owner.cookie), 404, 'NOT_FOUND')
  await responseBody(await patch(db, 'ex_greeting', owner.cookie), 409, 'CONFLICT')
  for (const input of [
    { body: '{"readAt":"2030-01-01"}' }, { body: '{"sessionId":"forged"}' }, { body: 'null' },
    { body: '[]' }, { body: '{' }, { query: '?sessionId=forged' }, { headers: { origin: 'https://foreign.example' } },
    { headers: { 'content-type': 'text/plain' } }, { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { host: 'localhost', 'x-forwarded-host': 'foreign.example', origin: 'http://foreign.example' } },
  ]) await responseBody(await patch(db, 'ex_message', owner.cookie, input), 409, 'CONFLICT')
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before)
  const first = await responseBody(await patch(db, 'ex_message', owner.cookie, {
    headers: { host: 'mailbox.example', origin: 'http://mailbox.example', 'sec-fetch-site': 'same-origin' },
  }), 200)
  assert.ok(Number.isFinite(Date.parse(first.exchange.readAt)))
  assert.equal(first.exchange.deliveredAt, '2026-11-21T01:00:00.000Z')
  assert.equal(first.exchange.repliedAt, '2026-11-21T01:10:00Z')
  assert.equal(first.exchange.payload.kind, 'co_owner_message')
  assert.deepEqual(await responseBody(await patch(db, 'ex_message', owner.cookie), 200), first)
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before + 1)
  db.close()
  const reopened = openDatabase(path)
  try {
    assert.deepEqual(await responseBody(await patch(reopened, 'ex_message', owner.cookie), 200), first)
    const { exchanges } = await responseBody(await get(reopened, { action: 'inbox', id: owner.id }, '', owner.cookie), 200)
    assert.deepEqual(exchanges.find(row => row.id === 'ex_message'), first.exchange)
  } finally { reopened.close() }
})

test('concurrent read actions on two SQLite connections store one timestamp', { timeout: 15000 }, async t => {
  const { db, path } = mailboxDatabase(t)
  const { owner } = seedMailbox(db)
  db.exec(`CREATE TABLE read_audit(at TEXT);
    CREATE TRIGGER audit_read AFTER UPDATE OF read_at ON exchange BEGIN
      INSERT INTO read_audit(at) VALUES (NEW.read_at);
    END`)
  const [first, second] = await raceMailboxWorkers(t, path, 'read', 'ex_legacy', owner.sessionId)
  assert.deepEqual(first, second)
  assert.deepEqual(db.prepare('SELECT at FROM read_audit').all().map(row => row.at), [first.readAt])
})

test('database failures remain errors and a corrupt payload cannot partially mark a row read', async t => {
  const { db } = mailboxDatabase(t)
  const { owner } = seedMailbox(db)
  const request = new Request('http://localhost/api/exchanges?from_dog=dog_owner', { headers: { cookie: owner.cookie } })
  const response = await handleMailboxRequest(request, { action: 'outbox' }, () => { throw new Error('private/db/path') })
  const error = await responseBody(response, 503, 'NETWORK')
  assert.ok(!error.detail.includes('private/db/path'))
  db.prepare("UPDATE exchange SET payload = '[]' WHERE id = ?").run('ex_legacy')
  await responseBody(await get(db, { action: 'inbox', id: owner.id }, '?filter=all', owner.cookie), 503, 'NETWORK')
  await responseBody(await patch(db, 'ex_legacy', owner.cookie), 503, 'NETWORK')
  assert.equal(db.prepare('SELECT read_at FROM exchange WHERE id = ?').get('ex_legacy').read_at, null)
})
