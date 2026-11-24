import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { deriveSnapshot, toFixedSnapshot } from '../lib/social/snapshot-derive.ts'
import { insertDog } from './helpers/mailbox-fixtures.mjs'

const dogId = 'dog_seed_07'
const meta = { dogId, version: 100, createdAt: '2026-11-24T02:00:00Z' }
function database(t, withEvent = true) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(readFileSync('contracts/schema.sql', 'utf8'))
  insertDog(db, dogId, 'seed', 1)
  db.exec(`INSERT INTO trip(id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
    VALUES('history_trip','${dogId}',1,'done','auto','2026-11-24T00:00:00Z','2026-11-24T00:00:00Z','2026-11-24T01:00:00Z')`)
  if (withEvent) {
    db.exec(`INSERT INTO event(id,code,text,season,weather,time_of_day,place_tags)
      VALUES('history_event','history_test','今天的模板','any','any','any','[]')`)
    db.exec(`INSERT INTO trip_event(trip_id,event_id,dog_id,happened_at)
      VALUES('history_trip','history_event','${dogId}','2026-11-24T00:30:00Z')`)
  }
  return db
}

test('explicit missing historical fact omits current template and rejects formal conversion', t => {
  const db = database(t)
  const result = deriveSnapshot(db, dogId, { occurrenceFacts: () => null })
  assert.deepEqual(result.body.recentTrips, [])
  assert.equal(result.evidence.trips[0].summary, null)
  assert.equal(result.evidence.trips[0].textSource, 'unverifiable')
  assert.equal(result.evidence.historyFixed, false)
  assert.throws(() => toFixedSnapshot(result, meta), /HISTORY_UNVERIFIABLE/)
  db.exec("UPDATE event SET text='又改过的模板'")
  assert.deepEqual(deriveSnapshot(db, dogId, { occurrenceFacts: () => null }).body.recentTrips, [])
})

test('diagnostic template mode remains identifiable and cannot become a formal snapshot', t => {
  const db = database(t)
  const diagnostic = deriveSnapshot(db, dogId)
  assert.deepEqual(diagnostic.body.recentTrips, ['今天的模板'])
  assert.equal(diagnostic.evidence.textMutable, true)
  assert.throws(() => toFixedSnapshot(diagnostic, meta), /HISTORY_UNVERIFIABLE/)
  const before = db.prepare('SELECT COUNT(*) n FROM snapshot').get().n
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec("UPDATE event SET text='事务内临时改动' WHERE id='history_event'")
    toFixedSnapshot(diagnostic, meta)
    assert.fail('unfixed history must reject before persistence')
  } catch (error) {
    db.exec('ROLLBACK')
    assert.match(String(error), /HISTORY_UNVERIFIABLE/)
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshot').get().n, before)
  assert.equal(db.prepare("SELECT text FROM event WHERE id='history_event'").get().text, '今天的模板')
})

test('occurrence fact remains stable after template edits and preserves source identity', t => {
  const db = database(t)
  const fact = { text: '当时的风吹翻了梧桐叶。', sourceId: 'occurrence:history_trip', capturedAt: '2026-11-24T00:30:00Z' }
  const opts = { occurrenceFacts: () => fact }
  const first = toFixedSnapshot(deriveSnapshot(db, dogId, opts), meta)
  db.exec("UPDATE event SET text='后来完全不同的模板'")
  const later = deriveSnapshot(db, dogId, opts)
  assert.deepEqual(toFixedSnapshot(later, { ...meta, version: 101 }).recentTrips, first.recentTrips)
  assert.deepEqual(first.recentTrips, [fact.text])
  assert.equal(later.evidence.trips[0].factSourceId, fact.sourceId)
  assert.throws(() => toFixedSnapshot(later, { ...meta, dogId: 'dog_seed_05' }), /SNAPSHOT_DOG_MISMATCH/)
})

test('eventless trip remains valid without inventing a historical fact', t => {
  const db = database(t, false)
  let calls = 0
  const result = deriveSnapshot(db, dogId, { occurrenceFacts: () => { calls++; return null } })
  assert.equal(calls, 0)
  assert.equal(result.evidence.historyFixed, true)
  assert.equal(result.evidence.trips[0].textSource, 'none')
  assert.deepEqual(toFixedSnapshot(result, meta).recentTrips, [])
})
