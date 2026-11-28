import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'
import { request } from './helpers/trip-return-fixtures.mjs'

const schedulerUrl = new URL('../lib/trips/b5-scheduler.ts', import.meta.url)
const hasC11Scheduler = existsSync(schedulerUrl)
const at = '2026-11-27T04:00:00.000Z'
const now = () => new Date(at)
const observations = ({ trip }) => ['a', 'b'].map(id => ({
  id, tripId: trip.id, dogId: trip.dogId, kind: 'scene', title: '长标题观察 ' + id,
  happenedAt: trip.startedAt, excerpt: null, topics: [],
}))
const providerFor = title => async () => ({ ok: true, httpStatus: 200, fetchedAt: at, items: [{
  title, sourceUrl: 'https://www.zhihu.com/question/1127', sourceMode: 'live',
  excerpt: null, authorityLevel: null, voteUpCount: null,
}] })

test('C11 to C10 to default B5 keeps quiet long-title returns within 8-15 characters',
  { skip: !hasC11Scheduler && 'C11 scheduler is owned by C; run this test on a C11/B5 combination tree' },
  async t => {
    const { createB5TripScheduler } = await import(schedulerUrl.href)
    for (const [index, [title, expected]] of [
      ['观察文章', '看到了观察文章，心里亮了一下。'],
      ['观察文章呀', '看到了观察文…，心里亮了一下。'],
      ['这是一段特别特别长的知乎文章标题用于回归', '看到了这是一…，心里亮了一下。'],
    ].entries()) {
      const { db } = mailboxDatabase(t)
      const owner = ownedDog(db, 'long-title-owner-' + index)
      db.prepare('UPDATE dog SET personality_tags=? WHERE id=?')
        .run(JSON.stringify(['寡言', '看物', '直给']), owner.id)
      const scope = { dogId: owner.id, request: request(owner.cookie), intentId: 'long-title-intent-' + index }
      const result = await createB5TripScheduler(db, { now, generationTimeoutMs: 1000,
        executor: { provider: providerFor(title), ownerObservations: observations } }).owner(scope)
      assert.equal(result.discovery.status, 'complete')
      assert.equal(result.return.status, 'confirmed')
      assert.equal(result.return.trip.status, 'done')
      assert.equal(result.return.message.text, expected)
      assert.equal([...result.return.message.text].length, 15)
      assert.equal(result.return.message.createdAt, result.return.trip.endedAt)
      assert.equal(result.return.message.mentionsFindId, result.discovery.finds[0].id)
      assert.equal(db.prepare('SELECT count(*) n FROM message').get().n, 1)

      let calls = 0
      const fail = () => { calls++; throw new Error('unexpected provider or composer call') }
      const replay = await createB5TripScheduler(db, { generationTimeoutMs: 1000,
        executor: { provider: fail }, compose: fail }).owner(scope)
      assert.equal(calls, 0)
      assert.equal(replay.return.replayed, true)
      assert.deepEqual(replay.return.message, result.return.message)
    }
  })
