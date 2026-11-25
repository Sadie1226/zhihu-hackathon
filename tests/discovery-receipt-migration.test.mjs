import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { DISCOVERY_RECEIPT_V8_SQL } from '../lib/db/migrations/008-discovery-receipt.ts'
import { createTripEventSelector } from '../lib/events/select.ts'
import { createTripDiscoveryComposer } from '../lib/trips/composer.ts'
import { createTripService } from '../lib/trips/service.ts'
import { mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'

const v7 = migrations.filter(migration => migration.version <= 7)
const at = '2026-11-25T02:00:00.000Z'
const now = () => new Date(at)
const schemaV1 = () => readFileSync('tests/fixtures/schema-v1.sql', 'utf8')
const objects = db => db.prepare(`SELECT type,name,sql FROM sqlite_schema
  WHERE name LIKE 'trip_discovery_receipt%' ORDER BY type,name`).all()
const version = db => db.prepare('PRAGMA user_version').get().user_version
const seedRecord = db => {
  const owner = ownedDog(db, 'migration-dog')
  const service = createTripService(db, { now })
  const { id } = service.create(owner.id, owner.sessionId, 'auto')
  service.start(id, owner.sessionId)
  db.exec(readFileSync('team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql', 'utf8'))
  db.exec("UPDATE event SET enabled = (code = 'any_shop_cat')")
  const selected = createTripEventSelector(db, { now, random: () => 0 })({
    tripId: id, dogId: owner.id, sessionId: owner.sessionId,
    conditions: { sceneFile: 'scenes/nantou.png', season: 'spring', weather: 'clear', timeOfDay: 'morning' },
  })
  assert.equal(selected.eventId, 'ev_any_shop_cat')
  const eventText = db.prepare('SELECT text FROM event WHERE id=?').get(selected.eventId).text
  const insert = db.prepare(`INSERT INTO find(id,trip_id,kind,title,source_mode,source_url,created_at)
    VALUES(?,?,'zhihu','旧记录','live',?,?)`)
  for (const source of [1, 2, 3]) insert.run(`old-${source}`, id, `https://www.zhihu.com/question/${source}`, at)
  return { owner, id, eventText }
}
const history = db => ['trip', 'snapshot', 'trip_snapshot', 'trip_event', 'trip_event_fact', 'find']
  .map(table => db.prepare(`SELECT * FROM ${table}`).all())

test('fresh schema and migrated v7 have identical v8 objects; reopen does not infer receipts', t => {
  const { db: fresh } = mailboxDatabase(t)
  const { db: legacy, path } = mailboxDatabase(t, v7, schemaV1())
  assert.equal(version(fresh), 8)
  assert.equal(version(legacy), 7)
  assert.deepEqual(objects(legacy), [])
  const { id, owner, eventText } = seedRecord(legacy)
  const before = history(legacy)
  legacy.close()

  const migrated = openDatabase(path)
  try {
    assert.equal(version(migrated), 8)
    assert.equal(objects(migrated).length, 4)
    assert.deepEqual(objects(migrated), objects(fresh))
    assert.deepEqual(history(migrated), before)
    assert.equal(migrated.prepare('SELECT count(*) n FROM trip_discovery_receipt').get().n, 0)
    assert.throws(() => migrated.exec("UPDATE trip_event_fact SET public_text_at_occurrence='改写'"), /immutable/)
    assert.throws(() => migrated.exec("UPDATE trip_snapshot SET snapshot_version=3"), /immutable/)
    const partial = createTripDiscoveryComposer(migrated, { now })(id, owner.sessionId)
    assert.equal(partial.status, 'partial')
    assert.deepEqual(partial.finds.map(row => row.title), [eventText])
    assert.equal(migrated.prepare('SELECT count(*) n FROM trip_discovery_receipt').get().n, 0)
    assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { migrated.close() }
  const reopened = openDatabase(path)
  try {
    assert.equal(version(reopened), 8)
    assert.deepEqual(objects(reopened), objects(fresh))
    assert.equal(reopened.prepare('SELECT count(*) n FROM trip_discovery_receipt').get().n, 0)
  } finally { reopened.close() }
})

test('an error after v8 DDL rolls back objects and version and allows a clean upgrade', t => {
  const { db, path } = mailboxDatabase(t, v7, schemaV1())
  seedRecord(db)
  const before = history(db)
  db.close()
  const broken = [...v7, { ...migrations.find(migration => migration.version === 8),
    sql: DISCOVERY_RECEIPT_V8_SQL + '\n INVALID SQL;' }]
  assert.throws(() => openDatabase(path, broken), /syntax error/)
  const unchanged = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(version(unchanged), 7)
    assert.deepEqual(objects(unchanged), [])
    assert.deepEqual(history(unchanged), before)
  } finally { unchanged.close() }
  const upgraded = openDatabase(path)
  try {
    assert.equal(version(upgraded), 8)
    assert.deepEqual(history(upgraded), before)
  } finally { upgraded.close() }
})

test('receipt schema enforces foreign keys, valid envelope, unique Trip and immutable rows', t => {
  const { db } = mailboxDatabase(t)
  const { owner, id } = seedRecord(db)
  const insert = db.prepare('INSERT INTO trip_discovery_receipt VALUES (?,?,?,?,?,?,?,?)')
  const valid = [id, owner.id, owner.sessionId, 'migration-test', at, 1, '[1,2,3]', 'a'.repeat(64)]
  for (const [field, bad] of [[1, 'foreign-dog'], [2, null], [3, '-bad'], [4, 'bad'],
    [5, 2], [6, '[1,2]'], [6, '{'], [6, '{}'], [7, 'g'.repeat(64)]]) {
    const values = [...valid]
    values[field] = bad
    assert.throws(() => insert.run(...values), /constraint|requires matching running scope/)
  }
  db.exec('BEGIN; DROP TRIGGER trip_discovery_receipt_v8_insert_guard')
  try { assert.throws(() => insert.run('missing-trip', ...valid.slice(1)), /FOREIGN KEY/) }
  finally { db.exec('ROLLBACK') }

  insert.run(...valid)
  assert.throws(() => insert.run(...valid), /already exists/)
  assert.throws(() => db.prepare('INSERT OR REPLACE INTO trip_discovery_receipt VALUES (?,?,?,?,?,?,?,?)')
    .run(...valid), /already exists/)
  assert.throws(() => db.exec("UPDATE trip_discovery_receipt SET intent_id='new'"), /immutable/)
  assert.throws(() => db.exec('DELETE FROM trip_discovery_receipt'), /immutable/)
  assert.equal(db.prepare('SELECT count(*) n FROM trip_discovery_receipt').get().n, 1)
})
