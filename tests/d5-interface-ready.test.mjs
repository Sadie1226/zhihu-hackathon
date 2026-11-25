import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { initializeDatabase, openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { d5InterfaceMigrations, openD5InterfaceDatabase } from '../lib/db/d5-interface.ts'
import { readOccurrenceFact } from '../lib/trips/occurrence-facts.ts'
import { deriveSnapshot, toFixedSnapshot } from '../lib/social/snapshot-derive.ts'
import { createTripService } from '../lib/trips/service.ts'
import { createTripEventSelector } from '../lib/events/select.ts'
import { ownedDog } from './helpers/mailbox-fixtures.mjs'

const at = '2026-11-24T03:00:00.000Z'
const now = () => new Date(at)
function pathFor(t) {
  const root = resolve('.local/d5-interface-tests')
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'db-'))
  t.after(() => { assert.ok(dir.startsWith(root + sep)); rmSync(dir, { recursive: true }) })
  return join(dir, 'app.sqlite')
}
const objects = db => db.prepare(`SELECT type,name,sql FROM sqlite_schema
  WHERE name LIKE '%v7%' OR name IN ('trip_event_fact','trip_snapshot','v_trip_event_history')
  ORDER BY type,name`).all().map(row => ({ ...row }))

test('interface opener never falls back to the default application database', () => {
  for (const path of [undefined, null, '', ' ', ':memory:', 1]) {
    assert.throws(() => openD5InterfaceDatabase(path), /explicit persistent validation path/)
  }
})

test('interface registry uses real v6 -> v7 for fresh/legacy databases, preserving seeds and rolling back failures', t => {
  assert.equal(d5InterfaceMigrations, migrations)
  assert.deepEqual(d5InterfaceMigrations.map(m => m.version), [2, 3, 4, 5, 6, 7])
  const path = pathFor(t)
  let db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys=ON')
  initializeDatabase(db, () => readFileSync('tests/fixtures/schema-v1.sql', 'utf8'), migrations.filter(m => m.version <= 5))
  db.exec(readFileSync('team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql', 'utf8'))
  const before = db.prepare('SELECT id,assembly FROM dog ORDER BY id').all()
  db.exec(`INSERT INTO trip(id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
    VALUES('legacy','dog_seed_07',1,'done','auto','${at}','${at}','${at}');
    INSERT INTO event(id,code,text,season,weather,time_of_day) VALUES('legacy-event','legacy','现在的模板','any','any','any');
    INSERT INTO trip_event VALUES('legacy','legacy-event','dog_seed_07','${at}');`)
  db.close()
  const bad = [...migrations.slice(0, -1), { ...migrations.at(-1), sql: migrations.at(-1).sql + '; INVALID SQL;' }]
  assert.throws(() => openDatabase(path, bad), /syntax error/)
  db = new DatabaseSync(path)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5)
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='trip_event_fact'").get(), undefined)
  db.close()
  db = openDatabase(path)
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7)
    assert.deepEqual(db.prepare('SELECT id,assembly FROM dog ORDER BY id').all(), before)
    assert.equal(readOccurrenceFact(db, 'legacy', 'dog_seed_07'), null)
    assert.equal(readOccurrenceFact(db, 'legacy', 'dog_seed_01'), null)
    const result = deriveSnapshot(db, 'dog_seed_07', { occurrenceFacts: readOccurrenceFact })
    assert.deepEqual(result.body.recentTrips, [])
    assert.equal(result.evidence.historyFixed, false)
    assert.throws(() => toFixedSnapshot(result, { dogId: 'dog_seed_07', version: 1, createdAt: at }), /HISTORY_UNVERIFIABLE/)
    const fresh = openD5InterfaceDatabase(pathFor(t))
    try { assert.deepEqual(objects(db), objects(fresh)) } finally { fresh.close() }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const prior = objects(db)
    db.close()
    db = openD5InterfaceDatabase(path)
    assert.deepEqual(objects(db), prior)
  } finally { db.close() }
})

test('real C7 selection captures a fixed fact consumed read-only by D across template edits', t => {
  let db
  t.after(() => { if (db?.isOpen) db.close() })
  db = openD5InterfaceDatabase(pathFor(t))
  const owner = ownedDog(db, 'interface-owner')
  db.exec(readFileSync('team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql', 'utf8'))
  db.exec("UPDATE event SET enabled=CASE WHEN code='any_shop_cat' THEN 1 ELSE 0 END")
  const trips = createTripService(db, { now })
  const trip = trips.create(owner.id, owner.sessionId, 'auto')
  trips.start(trip.id, owner.sessionId)
  const selected = createTripEventSelector(db, { now, random: () => 0 })({
    dogId: owner.id, tripId: trip.id, sessionId: owner.sessionId,
    conditions: { sceneFile: 'scenes/nantou.png', season: 'spring', weather: 'clear', timeOfDay: 'morning' },
  })
  assert.ok(selected)
  trips.finish(trip.id, owner.sessionId, 'done')
  const fact = readOccurrenceFact(db, trip.id, owner.id)
  assert.ok(fact)
  assert.equal(fact.capturedAt, selected.happenedAt)
  assert.equal(fact.sourceId, `trip_event_fact:${JSON.stringify([trip.id, selected.eventId])}`)
  const before = toFixedSnapshot(deriveSnapshot(db, owner.id, { occurrenceFacts: readOccurrenceFact }),
    { dogId: owner.id, version: 1, createdAt: at })
  db.exec("UPDATE event SET text='今天改过的文案',code='edited_code' WHERE id='" + selected.eventId + "'")
  const changes = db.prepare('SELECT total_changes() n').get().n
  const result = deriveSnapshot(db, owner.id, { occurrenceFacts: readOccurrenceFact })
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changes)
  assert.deepEqual(readOccurrenceFact(db, trip.id, owner.id), fact)
  assert.deepEqual(toFixedSnapshot(result, { dogId: owner.id, version: 2, createdAt: at }).recentTrips, before.recentTrips)
  assert.equal(result.evidence.historyFixed, true)
})

test('reader chooses earliest occurrence chronologically and never skips an unverifiable earlier fact', t => {
  let db
  t.after(() => { if (db?.isOpen) db.close() })
  const path = pathFor(t)
  db = openDatabase(path, migrations.slice(0, -1))
  const owner = ownedDog(db, 'ordered-owner')
  db.exec(`INSERT INTO trip(id,dog_id,seq,status,trigger,created_at,started_at,ended_at)
    VALUES('ordered','${owner.id}',1,'done','auto','${at}','${at}','${at}');
    INSERT INTO event(id,code,text,season,weather,time_of_day) VALUES('old','old','今天的旧模板','any','any','any');
    INSERT INTO trip_event VALUES('ordered','old','${owner.id}','2026-11-24T03:00:00Z');`)
  db.close()
  db = openD5InterfaceDatabase(path)
  // There is an older unverifiable occurrence. Do not silently select a later frozen fact.
  db.exec(`UPDATE trip SET status='running', ended_at=NULL WHERE id='ordered';
    INSERT INTO event(id,code,text,season,weather,time_of_day) VALUES('new','new','较晚固定的摘要','any','any','any');
    INSERT INTO trip_event VALUES('ordered','new','${owner.id}','2026-11-24T03:00:00.100Z');`)
  assert.equal(readOccurrenceFact(db, 'ordered', owner.id), null)
})
