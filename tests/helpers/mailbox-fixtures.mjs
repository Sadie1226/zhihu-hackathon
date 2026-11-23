import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fixtureSession } from './owner-session.mjs'
import { openDatabase } from '../../lib/db/bootstrap.ts'
import { createTripService } from '../../lib/trips/service.ts'

export const createdAt = '2026-11-21T00:00:00Z'
export const gift = { kind: 'gift', giftName: '小纸船', note: null, imagePath: null }

export function mailboxDatabase(t) {
  const root = resolve(tmpdir())
  const directory = mkdtempSync(join(root, 'c8-mailbox-'))
  const path = join(directory, 'mailbox.sqlite')
  const db = openDatabase(path)
  t.after(() => {
    if (db.isOpen) db.close()
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  return { db, path }
}

export function insertDog(db, id, sessionId, isSample = 0) {
  const owner = db.prepare('SELECT id FROM owner WHERE id = ?').get(sessionId)
  db.prepare(`INSERT INTO dog(id, session_id, owner_id, personality_tags, assembly, is_sample, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, sessionId, owner ? sessionId : null, '["好奇","看物","直给"]',
    '{"cloth":"hoodie","hat":"beanie","glasses":null,"face":"hopeful"}', isSample, createdAt)
}

export function insertExchange(db, id, fromDog, toDog, seq, payload = gift, at = createdAt) {
  db.prepare(`INSERT INTO exchange(id, from_dog, to_dog, kind, payload, deliver_after_trip_seq, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, fromDog, toDog, payload.kind, JSON.stringify(payload), seq, at)
}

export function ownedDog(db, id, production) {
  const { sessionId, setCookie } = fixtureSession(db, undefined, production)
  insertDog(db, id, sessionId)
  return { id, sessionId, cookie: setCookie.split(';', 1)[0] }
}

export function seedMailbox(db, production) {
  const owner = ownedDog(db, 'dog_owner', production)
  const other = ownedDog(db, 'dog_other', production)
  const empty = ownedDog(db, 'dog empty', production)
  const trips = createTripService(db, { now: () => new Date('2026-11-21T01:00:00Z') })
  const otherTrip = trips.create(other.id, other.sessionId, 'auto')
  db.prepare(`INSERT INTO find (id,trip_id,kind,title,excerpt,source_url,source_mode,created_at)
    VALUES ('find_source',?,'zhihu','Private find title','Private find excerpt',
      'https://www.zhihu.com/question/1','live',?)`).run(otherTrip.id, createdAt)
  insertExchange(db, 'ex_legacy', other.id, owner.id, 1)
  insertExchange(db, 'ex_read', other.id, owner.id, 1)
  insertExchange(db, 'ex_find', other.id, owner.id, 1, {
    kind: 'find', findTitle: '一盏灯', findExcerpt: null, sourceUrl: 'https://www.zhihu.com/question/1',
    sourceFindId: 'find_source', sourceMode: 'live',
  })
  insertExchange(db, 'ex_greeting', other.id, owner.id, 2, { kind: 'greeting', line: '今天有风', weather: null })
  const message = { kind: 'co_owner_message', message: '桂花开了', fromOwnerOf: other.id }
  insertExchange(db, 'ex_message', other.id, owner.id, 1, message)
  insertExchange(db, 'ex_sent_a', owner.id, other.id, 2, { ...message, fromOwnerOf: owner.id })
  insertExchange(db, 'ex_sent_z', owner.id, other.id, 1, { ...gift, sourceFindId: null, sourceMode: null })
  insertExchange(db, 'ex_sent_old', owner.id, other.id, 2, gift, '2026-11-20T23:00:00Z')

  trips.start(trips.create(owner.id, owner.sessionId, 'auto').id, owner.sessionId)
  trips.start(otherTrip.id, other.sessionId)
  // Previously stored timestamps from the corresponding owners.
  db.prepare('UPDATE exchange SET replied_at = ? WHERE id = ?').run('2026-11-21T01:10:00Z', 'ex_message')
  db.prepare('UPDATE exchange SET read_at = ? WHERE id = ?').run('2026-11-21T01:12:00Z', 'ex_read')
  return { owner, other, empty, otherTrip }
}

export async function raceMailboxWorkers(t, path, action, id, sessionId) {
  const workers = ['2026-11-21T08:00:00Z', '2026-11-21T08:00:01Z'].map(at => {
    const worker = new Worker(new URL('./mailbox-worker.mjs', import.meta.url), {
      workerData: { path, action, id, sessionId, at },
    })
    t.after(() => worker.terminate())
    return { worker, ready: once(worker, 'message'), exit: once(worker, 'exit') }
  })
  const readiness = await Promise.all(workers.map(item => item.ready))
  assert.deepEqual(readiness, [['ready'], ['ready']])
  const replies = workers.map(({ worker }) => once(worker, 'message'))
  for (const { worker } of workers) worker.postMessage('go')
  const results = await Promise.all(replies)
  for (const { exit } of workers) assert.deepEqual(await exit, [0])
  return results.map(([result]) => result)
}
