import assert from 'node:assert/strict'
import { createTripExecutor } from '../../lib/trips/executor.ts'
import { createTripReturn } from '../../lib/trips/return.ts'

export const at = '2026-11-27T02:00:00.000Z'
export const endedAt = '2026-11-27T02:10:00.000Z'
export const now = () => new Date(at)
export const end = () => new Date(endedAt)
export const request = cookie => new Request('https://local.test/trips', { headers: { cookie } })

const scenes = count => ({ trip }) => Array.from({ length: count }, (_, index) => ({
  id: 'scene-' + index, tripId: trip.id, dogId: trip.dogId, kind: 'scene',
  happenedAt: trip.startedAt, title: '观察材料 ' + index, excerpt: null, topics: ['街景'],
}))

export function discovery(db) {
  return createTripExecutor(db, {
    now, ownerObservations: scenes(2), seedObservations: scenes(3),
    provider: async () => ({ ok: true, fetchedAt: at, httpStatus: 200, items: [{
      title: '观察文章', excerpt: null, sourceUrl: 'https://www.zhihu.com/question/121',
      sourceMode: 'live', authorityLevel: null, voteUpCount: null,
    }] }),
  })
}

// Synthetic B5 port. C owns transaction coordination; production policy belongs to B.
export function writeFixture(db, target, draft) {
  assert.equal(db.isTransaction, true)
  assert.equal(db.prepare('SELECT status FROM trip WHERE id=?').get(target.tripId).status, 'done')
  db.prepare('INSERT INTO message(id,trip_id,text,mentions_find_id,created_at) VALUES (?,?,?,?,?)')
    .run(target.id, target.tripId, draft.text, draft.mentionsFindId ?? null, target.createdAt)
}

export const draftFor = ({ finds }) => ({ text: '今日路上见闻', mentionsFindId: finds[0].id })

export function returns(db, overrides = {}) {
  return createTripReturn(db, {
    now: end, generationTimeoutMs: 1000, writeMessageInTransaction: writeFixture,
    generate: async input => { assert.equal(db.isTransaction, false); return draftFor(input) },
    ...overrides,
  })
}
