import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTripReturn } from '../lib/trips/return.ts'
import { createMessageStore } from '../app/(b)/b5-share.ts'
import { createTripService } from '../lib/trips/service.ts'
import {
  AUTOMATIC_RETURN_ID_PATTERN, createB5ReturnPorts, createReturnMessageGenerator,
  isAutomaticReturnMessageId, readAutomaticReturnMessageById, writeMessageInTransaction,
} from '../lib/messages/return-adapter.ts'
import { mailboxDatabase, ownedDog, insertDog } from './helpers/mailbox-fixtures.mjs'
import { end, endedAt, discovery, request } from './helpers/trip-return-fixtures.mjs'

const conflict = { code: 'CONFLICT' }
const notFound = { code: 'NOT_FOUND' }
const autoId = 'msg_auto_return_v1_' + 'a'.repeat(64)

async function ownerFixture(t) {
  const { db, path } = mailboxDatabase(t)
  const owner = ownedDog(db, 'b5-owner')
  const input = { action: 'create', dogId: owner.id, request: request(owner.cookie) }
  const complete = await discovery(db).owner(input)
  assert.equal(complete.status, 'complete')
  return { db, path, owner, complete, input: { ...input, tripId: complete.trip.id } }
}

function returnService(db, overrides = {}) {
  return createTripReturn(db, {
    now: end, generationTimeoutMs: 1000,
    ...createB5ReturnPorts(db), ...overrides,
  })
}

test('B5 production ports confirm, replay by exact ID and leave ordinary history untouched', async t => {
  const f = await ownerFixture(t)
  let calls = 0
  const service = returnService(f.db, { generate: async input => {
    calls++
    assert.equal(f.db.isTransaction, false)
    assert.equal(input.scope, 'owner')
    return { text: '这次看到一条老街，心里记下了。', mentionsFindId: input.finds[0].id }
  } })
  const result = await service.owner(f.input)
  assert.equal(result.status, 'confirmed')
  assert.equal(result.replayed, false)
  assert.equal(result.trip.endedAt, endedAt)
  assert.match(result.message.id, AUTOMATIC_RETURN_ID_PATTERN)
  assert.ok(isAutomaticReturnMessageId(result.message.id))
  assert.deepEqual(readAutomaticReturnMessageById(f.db, result.message.id), result.message)
  assert.equal(readAutomaticReturnMessageById(f.db, 'msg_auto_return_v1_' + 'b'.repeat(64)), null)

  f.db.exec('BEGIN IMMEDIATE')
  f.db.prepare('INSERT INTO message(id,trip_id,text,created_at) VALUES(?,?,?,?)')
    .run('msg_ordinary_old', f.input.tripId, '普通历史旧话', '2026-11-27T01:00:00.000Z')
  f.db.prepare('INSERT INTO message(id,trip_id,text,created_at) VALUES(?,?,?,?)')
    .run('msg_ordinary_latest', f.input.tripId, '普通历史新话', '2026-11-27T23:00:00.000Z')
  f.db.exec('COMMIT')
  const latest = createMessageStore(f.db).get(f.input.tripId, f.owner.sessionId)
  assert.equal(latest.id, 'msg_ordinary_latest')
  assert.deepEqual(readAutomaticReturnMessageById(f.db, result.message.id), result.message)

  const retry = returnService(f.db, { generate: async () => {
    calls++
    throw new Error('confirmed return must not regenerate')
  } })
  const replay = await retry.owner(f.input)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.message, result.message)
  assert.equal(calls, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM message').get().n, 3)
})

test('B5 generation uses only confirmed visible finds and current personality contract', async t => {
  const f = await ownerFixture(t)
  for (const [tag, min, max] of [['寡言', 8, 15], ['话痨', 20, 35]]) {
    const one = await ownerFixture(t)
    one.db.prepare('UPDATE dog SET personality_tags=? WHERE id=?')
      .run(JSON.stringify([tag, '看物', '直给']), one.owner.id)
    const result = await returnService(one.db).owner(one.input)
    assert.equal(result.status, 'confirmed')
    const length = [...result.message.text].length
    assert.ok(length >= min && length <= max, `${tag} length ${length}`)
  }
  f.db.prepare('UPDATE dog SET blocked_topics=? WHERE id=?')
    .run(JSON.stringify(['心里']), f.owner.id)
  const generate = createReturnMessageGenerator(f.db)
  await assert.rejects(generate({ scope: 'owner', finds: f.complete.finds }, new AbortController().signal), conflict)
  f.db.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run('[]', f.owner.id)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM message').get().n, 0)
  assert.equal(f.db.prepare('SELECT status FROM trip WHERE id=?').get(f.input.tripId).status, 'running')
})

test('B5 generator rejects untrusted shapes and cross-owner or cross-trip inputs', async t => {
  const f = await ownerFixture(t)
  const generate = createReturnMessageGenerator(f.db)
  const controller = new AbortController()
  await assert.rejects(generate({ scope: 'owner', finds: f.complete.finds, request: f.input.request },
    controller.signal), conflict)
  const other = await ownerFixture(t)
  await assert.rejects(generate({ scope: 'owner',
    finds: [f.complete.finds[0], other.complete.finds[0]] }, controller.signal), conflict)
  const sample = createReturnMessageGenerator(f.db)
  await assert.rejects(sample({ scope: 'seed', finds: f.complete.finds }, controller.signal), notFound)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(generate({ scope: 'owner', finds: f.complete.finds }, aborted.signal), /aborted/)
})

test('B5 seed path uses sample scope only and writes no invitation or reply', async t => {
  const { db } = mailboxDatabase(t)
  insertDog(db, 'seed-b5', 'seed-fixture', 1)
  const complete = await discovery(db).seed({ action: 'create', dogId: 'seed-b5', intentId: 'sample-b5' })
  assert.equal(complete.status, 'complete')
  const input = { tripId: complete.trip.id, dogId: 'seed-b5', intentId: 'sample-b5' }
  const service = returnService(db)
  await assert.rejects(service.seed({ ...input, intentId: 'wrong' }), notFound)
  const owner = ownedDog(db, 'seed-intruder')
  await assert.rejects(service.owner({ ...input, request: request(owner.cookie) }), notFound)
  let calls = 0
  const checked = returnService(db, { generate: async evidence => {
    calls++
    assert.equal(evidence.scope, 'seed')
    assert.ok(evidence.finds.every(find => find.sourceMode === null))
    return { text: '这趟看到一点光，心里记下了。', mentionsFindId: evidence.finds[0].id }
  } })
  const result = await checked.seed(input)
  assert.equal(result.status, 'confirmed')
  assert.equal(result.message.tripId, input.tripId)
  assert.equal((await checked.seed(input)).replayed, true)
  assert.equal(calls, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invitation').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reply').get().n, 0)
})

test('B5 writer requires C transaction and rejects foreign IDs, drafts and changed policy', async t => {
  const f = await ownerFixture(t)
  const finished = createTripService(f.db, { now: end }).finish(f.input.tripId, f.owner.sessionId, 'done')
  const done = finished.trip
  const target = { id: autoId, tripId: f.input.tripId, createdAt: done.endedAt,
    allowedFindIds: f.complete.finds.map(find => find.id) }
  const draft = { text: '这次看到一条老街，心里记下了。', mentionsFindId: f.complete.finds[0].id }
  assert.throws(() => writeMessageInTransaction(f.db, target, draft), /existing C transaction/)

  const attempt = (nextTarget, nextDraft, mutate) => {
    mutate?.()
    f.db.exec('BEGIN IMMEDIATE')
    try {
      const after = writeMessageInTransaction(f.db, nextTarget, nextDraft)
      assert.equal(after, undefined)
      assert.equal(f.db.isTransaction, true)
      return undefined
    } catch (error) {
      return error
    } finally {
      f.db.exec('ROLLBACK')
    }
  }
  assert.ok(attempt({ ...target, id: 'msg_random' }, draft)?.code === 'CONFLICT')
  assert.ok(attempt(target, { ...draft, mentionsFindId: 'find_foreign' })?.code === 'CONFLICT')
  assert.ok(attempt(target, { ...draft, ownerId: f.owner.sessionId })?.code === 'CONFLICT')
  assert.ok(attempt({ ...target, allowedFindIds: [f.complete.finds[0].id, 'find_foreign'] }, draft)?.code === 'CONFLICT')
  const blocked = attempt(target, draft, () => f.db.prepare('UPDATE dog SET blocked_topics=? WHERE id=?')
    .run(JSON.stringify(['老街']), f.owner.id))
  assert.ok(blocked?.code === 'CONFLICT')
  f.db.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run('[]', f.owner.id)
  const verbose = attempt(target, { text: '太短。', mentionsFindId: f.complete.finds[0].id }, () =>
    f.db.prepare('UPDATE dog SET personality_tags=? WHERE id=?')
      .run(JSON.stringify(['话痨', '看物', '直给']), f.owner.id))
  assert.ok(verbose?.code === 'CONFLICT')
  f.db.prepare('UPDATE dog SET personality_tags=? WHERE id=?')
    .run('["好奇","看物","直给"]', f.owner.id)
  assert.equal(attempt(target, draft), undefined)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM message').get().n, 0)
  f.db.exec('BEGIN IMMEDIATE')
  f.db.prepare('INSERT INTO message(id,trip_id,text,mentions_find_id,created_at) VALUES(?,?,?,?,?)')
    .run(autoId, f.input.tripId, '占用自动主键', f.complete.finds[0].id, done.endedAt)
  let collision
  try { writeMessageInTransaction(f.db, target, draft) } catch (error) { collision = error }
  finally { f.db.exec('ROLLBACK') }
  assert.ok(collision?.code === 'CONFLICT')
})
