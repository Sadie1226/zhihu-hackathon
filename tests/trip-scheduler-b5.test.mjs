import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { composeReturnMessage } from '../lib/messages/return-adapter.ts'
import { createB5TripScheduler } from '../lib/trips/b5-scheduler.ts'
import { mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'
import { request } from './helpers/trip-return-fixtures.mjs'

const run = promisify(execFile)
const at = '2026-11-27T03:00:00.000Z'
const now = () => new Date(at)
const readMessageCount = db => db.prepare('SELECT count(*) n FROM message').get().n
const observations = ({ trip }) => ['a', 'b'].map(id => ({
  id, tripId: trip.id, dogId: trip.dogId, kind: 'scene', title: '联调观察 ' + id,
  happenedAt: trip.startedAt, excerpt: null, topics: [],
}))
const provider = async () => ({ ok: true, httpStatus: 200, fetchedAt: at, items: [{
  title: '联调资料', sourceUrl: 'https://www.zhihu.com/question/612', sourceMode: 'live',
  excerpt: null, authorityLevel: null, voteUpCount: null,
}] })

test('B5 production adapter with default local composer confirms done, then cold process replays without calling either provider', async t => {
  const { db, path } = mailboxDatabase(t)
  const owner = ownedDog(db, 'joint-owner')
  const scope = { dogId: owner.id, request: request(owner.cookie), intentId: 'joint-intent' }
  const result = await createB5TripScheduler(db, { now, generationTimeoutMs: 1000,
    executor: { provider, ownerObservations: observations } }).owner(scope)
  assert.equal(result.discovery.status, 'complete')
  assert.equal(result.return.status, 'confirmed')
  assert.equal(result.return.trip.status, 'done')
  assert.match(result.return.message.text, /联调资料/)
  assert.equal(result.return.message.createdAt, result.return.trip.endedAt)
  assert.equal(readMessageCount(db), 1)
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
    import { openDatabase } from './lib/db/bootstrap.ts'
    import { createB5TripScheduler } from './lib/trips/b5-scheduler.ts'
    const [path, cookie, dogId] = JSON.parse(process.argv[1])
    const db = openDatabase(path)
    let calls = 0
    const fail = () => { calls++; throw new Error('unexpected generation/search') }
    try {
      const actual = await createB5TripScheduler(db, { generationTimeoutMs: 1000,
        executor: { provider: fail }, compose: fail }).owner({
        dogId, intentId: 'joint-intent', request: new Request('https://local.test/trips', { headers: {cookie} })
      })
      console.log(JSON.stringify({ actual, calls }))
    } finally { db.close() }
  `, JSON.stringify([path, owner.cookie, owner.id])], { windowsHide: true })
  const cold = JSON.parse(stdout)
  assert.equal(cold.calls, 0)
  assert.equal(cold.actual.return.replayed, true)
  assert.deepEqual(cold.actual.return.message, result.return.message)
})

test('B5 adapter rechecks personality change during generation; same intent resumes without new discovery', async t => {
  const { db, path } = mailboxDatabase(t)
  const owner = ownedDog(db, 'profile-owner')
  const other = openDatabase(path)
  const scope = { dogId: owner.id, request: request(owner.cookie), intentId: 'profile-intent' }
  let calls = 0
  try {
    const scheduler = createB5TripScheduler(db, { now, generationTimeoutMs: 1000,
      executor: { provider: async () => { calls++; return provider() }, ownerObservations: observations },
      compose(actual, signal) {
        assert.equal(db.isTransaction, false)
        // Alter the content dependency even though neither profile changes the ordinary length limits.
        other.prepare('UPDATE dog SET personality_tags=? WHERE id=?')
          .run(JSON.stringify([...actual.personalityTags].reverse()), owner.id)
        return composeReturnMessage(actual, signal)
      } })
    await assert.rejects(scheduler.owner(scope), { code: 'CONFLICT' })
    assert.equal(readMessageCount(db), 0)
    assert.equal(db.prepare('SELECT status FROM trip').get().status, 'running')
    const recovered = await createB5TripScheduler(db, { now, generationTimeoutMs: 1000,
      executor: { provider: async () => { calls++; return provider() } } }).owner(scope)
    assert.equal(recovered.return.status, 'confirmed')
    assert.equal(recovered.discovery.confirmation.replayed, true)
    assert.equal(calls, 1)
    assert.equal(readMessageCount(db), 1)
  } finally { other.close() }
})
