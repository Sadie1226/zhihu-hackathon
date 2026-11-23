import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { EXCLUSIVE_PAIRS } from '../../contracts/types.ts'
import { selectForPersonality } from '../../lib/adoption/a6-selection.ts'
import { openDatabase } from '../../lib/db/bootstrap.ts'
import { createTripService } from '../../lib/trips/service.ts'
import { createFindStore, handleFindsRequest } from '../../lib/trips/finds.ts'
import { handleMessageReadRequest } from '../../lib/messages/read.ts'
import { createMessageStore } from '../../app/(b)/b5-share.ts'
import { fixtureSession } from './owner-session.mjs'

// Entirely synthetic fixture review. These URLs are protocol-shaped test identities,
// not fetched articles. No provider, credential, LLM or browser is used.
export const a6Candidates = [
  { id: 'https://www.zhihu.com/question/123/answer/456', title: '秋天：银杏叶为什么变黄', excerpt: '观察叶脉与纹理' },
  { id: 'https://www.zhihu.com/question/123/answer/457', title: '秋天：树下摊主的故事', excerpt: '采访一位居民' },
]

export async function runA6FixtureReview() {
  const root = resolve('.local/a6/databases')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'review-'))
  const path = join(directory, 'app.sqlite')
  let db = openDatabase(path)
  const at = '2026-11-23T06:00:00.000Z'
  const [exploration, , , attention, expression] = EXCLUSIVE_PAIRS
  const entries = []
  try {
    for (const [index, tag] of attention.entries()) {
      const dogId = `a6-fixture-dog-${index}`
      const session = fixtureSession(db, `a6-fixture-subject-${index}`)
      const tags = [exploration[0], tag, expression[0]]
      db.prepare(`INSERT INTO dog(id,session_id,owner_id,personality_tags,interest_categories,assembly,created_at)
        VALUES(?,?,?,?,'["自然风景","人与故事"]','{"cloth":"hoodie","hat":null,"glasses":null,"face":"hopeful"}',?)`)
        .run(dogId, session.sessionId, session.sessionId, JSON.stringify(tags), at)
      db.prepare('INSERT INTO wish(id,dog_id,text,category,created_at) VALUES(?,?,?,?,?)')
        .run(`a6-fixture-wish-${index}`, dogId, '想看看秋天', '自然风景', at)
      const trips = createTripService(db, { now: () => new Date(at), newId: () => `a6-fixture-trip-${index}` })
      const trip = trips.create(dogId, session.sessionId, 'wish')
      trips.start(trip.id, session.sessionId)
      const selection = selectForPersonality(a6Candidates, { dogId, tags, blockedTopics: [] })
      const selected = a6Candidates[selection.selectedIndex]
      const input = { tripId: trip.id, kind: 'zhihu', title: selected.title, excerpt: selected.excerpt,
        sourceUrl: selected.id, sourceMode: 'fixture', authorityLevel: null, voteUpCount: null, assetPath: null }
      const store = createFindStore(db, { now: () => new Date(at) })
      assert.throws(() => store.write({ ...input, sourceMode: 'live' }, session.sessionId), { code: 'CONFLICT' })
      assert.throws(() => store.writeVerified({ verifiedSearch: true }, session.sessionId), { code: 'CONFLICT' })
      const saved = store.write(input, session.sessionId)
      assert.deepEqual(store.write(input, session.sessionId), saved)
      const finish = trips.finish(trip.id, session.sessionId, 'done')
      assert.deepEqual(finish.finds.map(f => ({ ...f })), [saved])
      const message = createMessageStore(db, { now: () => new Date(at), newId: () => `a6-fixture-message-${index}` })
        .write(trip.id, { text: `我带回了${index === 0 ? '银杏叶的纹理' : '树下摊主的故事'}。`, mentionsFindId: saved.id }, session.sessionId)
      entries.push({ dogId, tags, tripId: trip.id, selection, saved, message,
        sessionId: session.sessionId, cookie: session.setCookie.split(';')[0] })
    }
    assert.notEqual(entries[0].saved.sourceUrl, entries[1].saved.sourceUrl)
    assert.equal(db.prepare('SELECT count(*) n FROM find').get().n, 2)
    assert.equal(db.prepare('SELECT count(*) n FROM message').get().n, 2)
    const first = entries[0], second = entries[1]
    assert.throws(() => createMessageStore(db).write(first.tripId,
      { text: '不属于这一趟的引用', mentionsFindId: second.saved.id }, first.sessionId), { code: 'CONFLICT' })
    db.close()
    db = openDatabase(path)
    for (const entry of entries) {
      const request = path => new Request(`http://localhost/api/trips/${entry.tripId}/${path}`, { headers: { cookie: entry.cookie } })
      const finds = handleFindsRequest(request('finds'), entry.tripId, () => db)
      const message = handleMessageReadRequest(request('message'), entry.tripId, () => db)
      assert.equal(finds.status, 200)
      assert.equal(message.status, 200)
      assert.deepEqual(await finds.json(), { finds: [entry.saved] })
      assert.deepEqual(await message.json(), { message: entry.message })
      const foreign = new Request('http://localhost/api/trips/foreign/finds', { headers: { cookie: second.cookie } })
      if (entry === first) {
        assert.equal(handleFindsRequest(foreign, entry.tripId, () => db).status, 404)
        assert.equal(handleMessageReadRequest(foreign, entry.tripId, () => db).status, 404)
      }
    }
    return {
      mode: 'fixture', policyVersion: entries[0].selection.version,
      baseline: 'dd5f53e', theme: '想看看秋天', candidates: a6Candidates,
      results: entries.map(({ dogId, tags, tripId, selection, saved, message }) => ({ dogId, tags, tripId,
        selectedCandidateId: selection.selectedId, reasons: selection.decisions[selection.selectedIndex].reasons,
        find: saved, message })),
      checks: { distinctSelectedSources: true, fixtureOnly: true, findRetryIdempotent: true,
        finishContainsSelectedFind: true, reopenedFindAndMessageGet: true, foreignOwnerGetRejected: true,
        foreignFindReferenceRejected: true, forgedLiveAndProofRejected: true },
      limits: ['Synthetic fixture candidates and manual Message; no real search or generation',
        'HTTP handlers invoked in process; no listening server or browser',
        'Temporary SQLite database deleted after review; reproduce with the script'],
    }
  } finally {
    if (db.isOpen) db.close()
    const target = resolve(directory)
    assert.ok(target.startsWith(root + sep), 'cleanup stays under fixture root')
    rmSync(target, { recursive: true, force: true })
  }
}
