import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readExperienceHistory } from '../lib/adoption/a7-history.ts'
import { revokeSession } from '../lib/auth/session.ts'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { createTripExecutor } from '../lib/trips/executor.ts'
import { createTripService } from '../lib/trips/service.ts'
import { mailboxDatabase, ownedDog, insertExchange } from './helpers/mailbox-fixtures.mjs'

const day = n => new Date(Date.UTC(2026, 10, 10 + n, 2)).toISOString()
const request = owner => new Request('https://local.test/history', { headers: { cookie: owner.cookie } })
const article = (id, title = '器物与叶片') => ({ title, excerpt: '一片叶子的纹理',
  sourceUrl: `https://www.zhihu.com/question/${id}`, sourceMode: 'live', authorityLevel: null, voteUpCount: null })

async function travel(db, owner, n, { finish = 'done', item = article(100 + n) } = {}) {
  const now = () => new Date(day(n))
  const result = await createTripExecutor(db, { now,
    provider: async () => ({ ok: true, fetchedAt: day(n), httpStatus: 200, items: [item] }),
    ownerObservations: ({ trip }) => [0, 1].map(i => ({ id: 'scene-' + i, tripId: trip.id, dogId: owner.id,
      kind: 'scene', happenedAt: trip.startedAt, title: '路边风景 ' + i, excerpt: null, topics: [] })),
  }).owner({ action: 'create', dogId: owner.id, request: request(owner) })
  assert.equal(result.status, 'complete')
  if (finish) createTripService(db, { now }).finish(result.trip.id, owner.sessionId, finish)
  return result
}

function start(db, owner, n) {
  const trips = createTripService(db, { now: () => new Date(day(n)) })
  return trips.start(trips.create(owner.id, owner.sessionId, 'auto').id, owner.sessionId).trip
}

test('A7 history reads real done receipts, isolates dogs and is stable across connection reopen', async t => {
  const { db, path } = mailboxDatabase(t)
  const owner = ownedDog(db, 'history-owner')
  const other = ownedDog(db, 'history-other')
  await travel(db, other, 0, { item: article(999, '另一只狗的材料') })
  const prior = await travel(db, owner, 0)
  await travel(db, owner, 1)
  const current = start(db, owner, 2)
  const history = readExperienceHistory(db, current.id, request(owner))
  assert.equal(history.dogId, owner.id)
  assert.equal(history.beforeSeq, 3)
  assert.equal(history.entries.length, 2)
  assert.ok(history.entries.every(entry => entry.kind === 'trip' && entry.category === '自然风景'))
  assert.ok(history.entries.some(entry => entry.id === prior.finds.find(row => row.kind === 'zhihu').id))
  assert.ok(history.entries.every(entry => !entry.sourceId.endsWith('/999')))
  assert.deepEqual(readExperienceHistory(db, current.id, owner.sessionId), history)
  db.exec('BEGIN')
  assert.deepEqual(readExperienceHistory(db, current.id, request(owner)), history)
  assert.equal(db.isTransaction, true)
  db.exec('ROLLBACK')
  const reopened = openDatabase(path)
  try { assert.deepEqual(readExperienceHistory(reopened, current.id, request(owner)), history) }
  finally { reopened.close() }
  assert.throws(() => readExperienceHistory(db, current.id, request(other)), { code: 'NOT_FOUND' })
  revokeSession(request(owner), db)
  assert.throws(() => readExperienceHistory(db, current.id, request(owner)), { code: 'NOT_FOUND' })
  assert.equal(db.isTransaction, false)
})

test('A7 history excludes failed, timeout, unconfirmed, fixture and corrupt content', async t => {
  const { db } = mailboxDatabase(t)
  const owner = ownedDog(db, 'history-invalid')
  const valid = await travel(db, owner, 0)
  const corrupted = await travel(db, owner, 1)
  await travel(db, owner, 2, { finish: 'failed' })
  await travel(db, owner, 3, { finish: 'timeout' })
  const noReceipt = start(db, owner, 4)
  createTripService(db, { now: () => new Date(day(4)) }).finish(noReceipt.id, owner.sessionId, 'done')
  const fixture = await travel(db, owner, 5)
  db.prepare("UPDATE find SET source_mode='fixture' WHERE trip_id=? AND kind='zhihu'").run(fixture.trip.id)
  db.prepare("UPDATE find SET title='被修改的材料' WHERE trip_id=? AND kind='zhihu'").run(corrupted.trip.id)
  const current = start(db, owner, 6)
  const history = readExperienceHistory(db, current.id, request(owner))
  assert.equal(history.entries.length, 1)
  assert.equal(history.entries[0].tripId, valid.trip.id)
})

test('A7 history uses a six-sequence window rather than searching backwards for valid trips', async t => {
  const { db } = mailboxDatabase(t)
  const owner = ownedDog(db, 'history-window')
  await travel(db, owner, 0)
  for (let n = 1; n <= 6; n++) await travel(db, owner, n, { finish: 'failed' })
  const current = start(db, owner, 7)
  assert.equal(readExperienceHistory(db, current.id, request(owner)).entries.length, 0)
})

test('A7 history applies current blocked topics and ignores history finishing after departure', async t => {
  const { db } = mailboxDatabase(t)
  const owner = ownedDog(db, 'history-blocked')
  const prior = await travel(db, owner, 0)
  const current = start(db, owner, 1)
  const initial = readExperienceHistory(db, current.id, request(owner))
  assert.equal(initial.entries.length, 1)
  db.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run(JSON.stringify(['叶片']), owner.id)
  const hidden = readExperienceHistory(db, current.id, request(owner))
  assert.equal(hidden.entries.length, 0)
  assert.notEqual(hidden.fingerprint, initial.fingerprint)
  db.prepare("UPDATE dog SET blocked_topics='[]' WHERE id=?").run(owner.id)
  db.prepare('UPDATE trip SET ended_at=? WHERE id=?').run(day(2), prior.trip.id)
  assert.equal(readExperienceHistory(db, current.id, request(owner)).entries.length, 0)
})

test('A7 history needs a running departure and never changes stored facts', async t => {
  const { db } = mailboxDatabase(t)
  const owner = ownedDog(db, 'history-readonly')
  await travel(db, owner, 0)
  const service = createTripService(db, { now: () => new Date(day(1)) })
  const pending = service.create(owner.id, owner.sessionId, 'auto')
  assert.throws(() => readExperienceHistory(db, pending.id, request(owner)), { code: 'CONFLICT' })
  service.start(pending.id, owner.sessionId)
  const before = ['trip', 'find', 'message', 'trip_discovery_receipt', 'snapshot', 'exchange']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all())
  const changes = db.prepare('SELECT total_changes() n').get().n
  readExperienceHistory(db, pending.id, request(owner))
  readExperienceHistory(db, pending.id, request(owner))
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changes)
  const after = ['trip', 'find', 'message', 'trip_discovery_receipt', 'snapshot', 'exchange']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all())
  assert.deepEqual(after, before)
})

test('A7 learns only delivered shared Find with matching source, not private messages or gifts', async t => {
  const { db } = mailboxDatabase(t)
  const sender = ownedDog(db, 'history-sender')
  const receiver = ownedDog(db, 'history-receiver')
  const source = await travel(db, sender, 0, { item: article(500, '摊主讲述陶器') })
  const row = source.finds.find(find => find.kind === 'zhihu')
  const payload = { kind: 'find', sourceFindId: row.id, sourceMode: row.sourceMode,
    sourceUrl: row.sourceUrl, findTitle: row.title, findExcerpt: row.excerpt }
  insertExchange(db, 'shared', sender.id, receiver.id, 1, payload, day(0))
  insertExchange(db, 'not-arrived', sender.id, receiver.id, 10, payload, day(0))
  insertExchange(db, 'private', sender.id, receiver.id, 1,
    { kind: 'co_owner_message', message: '私人原话', fromOwnerOf: sender.id }, day(0))
  insertExchange(db, 'gift-source', sender.id, receiver.id, 1,
    { kind: 'gift', giftName: '杯子', note: null, imagePath: null, sourceFindId: row.id, sourceMode: row.sourceMode }, day(0))
  await travel(db, receiver, 1, { item: article(501) })
  const current = start(db, receiver, 2)
  const initial = readExperienceHistory(db, current.id, request(receiver))
  const shared = initial.entries.filter(entry => entry.kind === 'exchange')
  assert.equal(shared.length, 1)
  assert.equal(shared[0].id, 'shared')
  assert.equal(shared[0].seq, 1)
  assert.equal(shared[0].title, row.title)
  assert.equal(shared[0].sourceId, row.sourceUrl)
  const changed = { ...payload, findTitle: '伪造的新标题' }
  db.prepare('UPDATE exchange SET payload=? WHERE id=?').run(JSON.stringify(changed), 'shared')
  assert.equal(readExperienceHistory(db, current.id, request(receiver)).entries.filter(e => e.kind === 'exchange').length, 0)
  db.prepare('UPDATE exchange SET payload=? WHERE id=?').run(JSON.stringify(payload), 'shared')
  const [a, b] = [sender.id, receiver.id].sort()
  db.prepare(`INSERT INTO relation(id,dog_a,dog_b,first_met_at,last_met_at,is_blocked,blocked_at)
    VALUES('blocked',?,?,?,?,1,?)`).run(a, b, day(0), day(0), day(1))
  assert.equal(readExperienceHistory(db, current.id, request(receiver)).entries.filter(e => e.kind === 'exchange').length, 0)
})
