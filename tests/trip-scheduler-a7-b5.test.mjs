import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { createB5TripScheduler } from '../lib/trips/b5-scheduler.ts'
import { createTripExecutor } from '../lib/trips/executor.ts'
import { mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'
import { request } from './helpers/trip-return-fixtures.mjs'

const at = '2026-11-28T04:00:00.000Z'
const now = () => new Date(at)
const observations = ({ trip }) => ['a', 'b', 'c'].map(id => ({
  id, dogId: trip.dogId, tripId: trip.id, kind: 'scene',
  title: '联合观察' + id, happenedAt: trip.startedAt, topics: [], excerpt: null,
}))

test('A7 and C11 offline coexist without a provider or cache call', async t => {
  const { db } = mailboxDatabase(t)
  const owner = ownedDog(db, 'offline-a7')
  let calls = 0
  const forbidden = () => { calls++; throw new Error('offline search I/O') }
  const result = await createTripExecutor(db, {
    now, experience: true, offline: true, ownerObservations: observations,
    provider: forbidden, cache: { read: forbidden, write: forbidden },
  }).owner({ action: 'create', dogId: owner.id, request: request(owner.cookie) })
  assert.equal(calls, 0)
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.reasons, ['NO_REAL_ZHIHU'])
  assert.equal(result.finds.length, 3)
  assert.ok(result.finds.every(find => find.kind === 'scene'))
})

test('C11 with A7 and default B5 confirms all title boundaries and cold-replays without I/O', async t => {
  const { db, path } = mailboxDatabase(t)
  const runInputs = []
  const messages = []
  for (const [index, title] of ['观察文章', '观察文章呀', '特别特别长的知乎文章标题用于联合回归'].entries()) {
    const owner = ownedDog(db, 'a7-b5-owner-' + index)
    db.prepare('UPDATE dog SET personality_tags=? WHERE id=?').run('["寡言","看物","直给"]', owner.id)
    // Two local observations and one verified source make the original three-member batch.
    let calls = 0
    const scheduler = createB5TripScheduler(db, { now, generationTimeoutMs: 1000,
      executor: { experience: true, ownerObservations: context => observations(context).slice(0, 2),
        provider: async (_query, count) => {
          calls++
          assert.equal(count, 6)
          return { ok: true, httpStatus: 200, fetchedAt: at, items: [{
            title, excerpt: null, sourceMode: 'live', authorityLevel: null, voteUpCount: null,
            sourceUrl: 'https://www.zhihu.com/question/' + (900 + index),
          }] }
        } } })
    const intentId = 'a7-b5-intent-' + index
    const result = await scheduler.owner({ dogId: owner.id, request: request(owner.cookie), intentId })
    assert.equal(calls, 1)
    assert.equal(result.discovery.status, 'complete')
    assert.equal(result.return.status, 'confirmed')
    assert.equal(result.return.trip.status, 'done')
    assert.equal([...result.return.message.text].length, 15)
    assert.equal(result.return.message.mentionsFindId, result.discovery.finds.find(f => f.kind === 'zhihu').id)
    messages.push(result.return.message)
    runInputs.push({ dogId: owner.id, cookie: owner.cookie, intentId })
  }
  const receiptRows = () => db.prepare('SELECT * FROM trip_discovery_receipt ORDER BY trip_id').all()
  const findRows = () => db.prepare('SELECT * FROM find ORDER BY id').all()
  const before = JSON.stringify([receiptRows(), findRows()])
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { openDatabase } from './lib/db/bootstrap.ts';
    import { createB5TripScheduler } from './lib/trips/b5-scheduler.ts';
    const [path, inputs] = JSON.parse(process.argv[1]);
    const db = openDatabase(path);
    let calls = 0;
    const fail = () => { calls++; throw Error('unexpected external I/O'); };
    try {
      const scheduler = createB5TripScheduler(db, {generationTimeoutMs:1000, compose:fail,
        executor:{experience:true, provider:fail, cache:{read:fail, write:fail}}});
      const results = [];
      for (const {dogId, cookie, intentId} of inputs) {
        const request = new Request('https://local.test/trips', {headers:{cookie}});
        results.push((await scheduler.owner({dogId, request, intentId, retryDiscovery:true})).return);
      }
      console.log(JSON.stringify({calls,results}));
    } finally { db.close(); }
  `, JSON.stringify([path, runInputs])], { encoding: 'utf8', windowsHide: true })
  const { calls, results } = JSON.parse(stdout)
  assert.equal(calls, 0)
  assert.ok(results.every(result => result.status === 'confirmed' && result.replayed))
  assert.deepEqual(results.map(result => result.message), messages)
  assert.equal(db.prepare('SELECT count(*) AS n FROM message').get().n, 3)
  assert.equal(JSON.stringify([receiptRows(), findRows()]), before)
})
