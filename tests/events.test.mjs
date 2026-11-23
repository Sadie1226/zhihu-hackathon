import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initializeDatabase, openDatabase, APPLICATION_ID } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { INTEREST_CATEGORIES } from '../contracts/types.ts'

const schema = readFileSync('contracts/schema.sql', 'utf8')
const oldSchema = readFileSync(new URL('./fixtures/schema-v1.sql', import.meta.url), 'utf8')
const fixture = name => JSON.parse(readFileSync(`contracts/fixtures/${name}.json`, 'utf8'))
const columns = ['id', 'code', 'text', 'season', 'weather', 'time_of_day', 'place_tags', 'match_tags',
  'weight', 'cooldown_days', 'asset_refs', 'enabled']
const root = resolve('.local/event-tests')
mkdirSync(root, { recursive: true })
function temporary(t) {
  const directory = mkdtempSync(join(root, 'database-'))
  t.after(() => {
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  return join(directory, 'app.sqlite')
}
function memory(t) {
  const db = new DatabaseSync(':memory:')
  db.exec(schema)
  t.after(() => db.close())
  return db
}
function insertEvent(db, overrides = {}) {
  const row = { id: 'test-event', code: 'test-event', text: '测试夹具', season: 'any', weather: 'any',
    time_of_day: 'any', ...overrides }
  const keys = Object.keys(row)
  db.prepare(`INSERT INTO event (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row))
}
function fixtureData(db, dogFixture = 'dog') {
  for (const [table, key] of [['dog', 'dogs'], ['trip', 'trips'], ['exchange', 'exchanges']]) {
    const data = fixture(table === 'dog' ? dogFixture : table)
    assert.equal(data.sourceMode, 'fixture')
    for (const row of data[key]) {
      const values = Object.values(row).map(value => value === null ? null
        : typeof value === 'object' ? JSON.stringify(value) : typeof value === 'boolean' ? Number(value) : value)
      db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${values.map(() => '?').join(',')})`).run(...values)
    }
  }
}
function existingData(db) {
  return ['dog', 'trip', 'exchange'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
}
function legacy(path) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  initializeDatabase(db, () => oldSchema, [])
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table'").get().n, 10)
  fixtureData(db)
  return db
}

test('event has exactly 12 columns, trip_event exactly 4, defaults and indexes are correct', t => {
  const db = memory(t)
  assert.deepEqual(db.prepare("PRAGMA table_info('event')").all().map(c => c.name), columns)
  assert.deepEqual(db.prepare("PRAGMA table_info('trip_event')").all().map(c => c.name),
    ['trip_id', 'event_id', 'dog_id', 'happened_at'])
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table'").get().n, 15)
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='view' ORDER BY name").all().map(row => row.name),
    ['v_invitation_state', 'v_wish_active'])
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.deepEqual(db.prepare("PRAGMA index_info('idx_trip_event_dog')").all().map(c => c.name), ['dog_id', 'happened_at'])
  assert.deepEqual(db.prepare("PRAGMA table_info('trip_event')").all().filter(c => c.pk).map(c => [c.name, c.pk]),
    [['trip_id', 1], ['event_id', 2]])
  insertEvent(db)
  const row = db.prepare('SELECT * FROM event').get()
  assert.deepEqual([row.weight, row.cooldown_days, row.asset_refs, row.enabled, row.place_tags, row.match_tags],
    [30, 7, '{}', 1, '[]', '[]'])
})

test('event SQL enums and TypeScript aliases agree; Event uses exactly the mapped 12 fields', t => {
  const db = memory(t)
  const types = readFileSync('contracts/types.ts', 'utf8')
  const enums = {
    Season: ['season', ['spring', 'summer', 'autumn', 'winter', 'any']],
    EventWeather: ['weather', ['any', 'clear', 'rain', 'snow']],
    TimeOfDay: ['time_of_day', ['any', 'morning', 'dusk', 'night']],
    PlaceTag: ['place_tags', ['street', 'stall', 'riverside', 'bookstore']],
  }
  for (const [alias, [column, values]] of Object.entries(enums)) {
    const declaration = types.match(new RegExp(`export type ${alias} = ([^\\r\\n]+)`))?.[1]
    assert.ok(declaration)
    assert.deepEqual([...declaration.matchAll(/'([^']+)'/g)].map(m => m[1]), values)
    for (const value of values) {
      insertEvent(db, { [column]: column === 'place_tags' ? JSON.stringify([value]) : value })
      db.exec('DELETE FROM event')
    }
  }
  for (const value of INTEREST_CATEGORIES) {
    insertEvent(db, { match_tags: JSON.stringify([value]) }); db.exec('DELETE FROM event')
  }
  const body = types.match(/export interface Event \{([\s\S]*?)\n\}/)?.[1]
  assert.ok(body)
  assert.deepEqual([...body.matchAll(/^\s*(\w+):/gm)].map(m => m[1]),
    ['id', 'code', 'text', 'season', 'weather', 'timeOfDay', 'placeTags', 'matchTags', 'weight', 'cooldownDays', 'assetRefs', 'enabled'])
  assert.match(body, /matchTags: InterestCategory\[\]/)
  assert.match(body, /enabled: boolean/)
  assert.match(body, /assetRefs: Record<string, unknown>/)
})

const invalidFields = {
  season: ['monsoon', '', null], weather: ['storm', '', null], time_of_day: ['noon', '', null],
  text: ['', '   ', '字'.repeat(41), ' ' + '字'.repeat(40), null],
  place_tags: ['[', '{}', 'null', '"street"', '["forest"]', '[null]', '[1]', '[true]', '[{}]', '[["street"]]', '["street",null]', null],
  match_tags: ['[', '{}', 'null', '"冷知识"', '["unknown"]', '[null]', '[1]', '[false]', '[{}]', '[["冷知识"]]', '["冷知识",null]', null],
  asset_refs: ['{', '[]', 'null', '"scene"', '1', 'true', null],
  weight: [0, -1, 'invalid', null], cooldown_days: [-1, 'invalid', null], enabled: [-1, 2, 'invalid', null],
}
for (const [column, values] of Object.entries(invalidFields)) {
  test(`invalid ${column} values reject INSERT and UPDATE without changing stored content`, t => {
    const db = memory(t)
    insertEvent(db)
    const before = db.prepare('SELECT * FROM event').get()
    for (const value of values) {
      assert.throws(() => insertEvent(db, { id: 'new', code: 'new', [column]: value }), /constraint|invalid (place tag|interest category)/i,
        `${column} INSERT ${JSON.stringify(value)}`)
      assert.throws(() => db.prepare(`UPDATE event SET ${column} = ?`).run(value), /constraint|invalid (place tag|interest category)/i,
        `${column} UPDATE ${JSON.stringify(value)}`)
      assert.deepEqual(db.prepare('SELECT * FROM event').all(), [before])
    }
  })
}

test('valid boundaries: 1 and 40 characters, empty/multiple tags, JSON object, numeric weight and cooldown zero', t => {
  const db = memory(t)
  for (const text of ['字', '字'.repeat(40), '🌱'.repeat(40)]) {
    insertEvent(db, { text, cooldown_days: 0, enabled: 0, weight: 0.5,
      place_tags: '["street","stall"]', match_tags: JSON.stringify(INTEREST_CATEGORIES), asset_refs: '{"scene":"fixture-scene"}' })
    db.exec('DELETE FROM event')
  }
  insertEvent(db, { weight: 30.5, cooldown_days: 0.5 })
  assert.equal(db.prepare('SELECT weight FROM event').get().weight, 30.5)
})

test('event id primary key and code unique hold on insert/update; null ids are rejected', t => {
  const db = memory(t)
  insertEvent(db)
  assert.throws(() => insertEvent(db, { code: 'different' }), /UNIQUE constraint/)
  assert.throws(() => insertEvent(db, { id: 'different' }), /UNIQUE constraint/)
  assert.throws(() => insertEvent(db, { id: null, code: 'null-id' }), /NOT NULL/)
  assert.throws(() => insertEvent(db, { id: 'null-code', code: null }), /NOT NULL/)
  insertEvent(db, { id: 'other', code: 'other' })
  assert.throws(() => db.exec("UPDATE event SET code='test-event' WHERE id='other'"), /UNIQUE constraint/)
  assert.throws(() => db.exec("UPDATE event SET id='test-event' WHERE id='other'"), /UNIQUE constraint/)
})

test('trip_event foreign keys and compound primary key protect history, without cascading deletion', t => {
  const db = memory(t)
  fixtureData(db, 'dog-v6')
  insertEvent(db); insertEvent(db, { id: 'other', code: 'other' })
  const trip = db.prepare('SELECT * FROM trip ORDER BY seq LIMIT 1').get()
  const row = [trip.id, 'test-event', trip.dog_id, '2026-11-18T00:00:00Z']
  const insert = values => db.prepare('INSERT INTO trip_event VALUES(?,?,?,?)').run(...values)
  for (const index of [0, 1, 2]) {
    const bad = [...row]; bad[index] = 'missing'
    assert.throws(() => insert(bad), /FOREIGN KEY constraint/)
  }
  for (const index of [0, 1, 2, 3]) {
    const bad = [...row]; bad[index] = null
    assert.throws(() => insert(bad), /NOT NULL/)
  }
  insert(row)
  assert.throws(() => insert(row), /UNIQUE constraint/)
  insert([trip.id, 'other', trip.dog_id, row[3]])
  assert.throws(() => db.exec("DELETE FROM event WHERE id='test-event'"), /FOREIGN KEY constraint/)
  assert.throws(() => db.prepare('DELETE FROM trip WHERE id=?').run(trip.id), /FOREIGN KEY constraint/)
  for (const column of ['trip_id', 'event_id', 'dog_id']) {
    assert.throws(() => db.prepare(`UPDATE trip_event SET ${column} = ? WHERE event_id='test-event'`).run('missing'), /FOREIGN KEY constraint/)
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('empty event fixture explicitly declares fixture mode and no invented history', () => {
  const sample = fixture('event')
  assert.equal(sample.sourceMode, 'fixture')
  assert.equal(typeof sample.note, 'string')
  assert.deepEqual(sample.events, [])
})

test('real version-1 database upgrades to 2, preserves every dog/trip/exchange column and survives reopen', t => {
  const path = temporary(t)
  let db = legacy(path)
  const before = existingData(db)
  const originalObjects = db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
  db.close()
  db = openDatabase(path, migrations.slice(0, 1))
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(db.prepare('PRAGMA application_id').get().application_id, APPLICATION_ID)
    assert.deepEqual(existingData(db), before)
    for (const object of originalObjects) {
      assert.equal(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(object.name).sql, object.sql)
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(db.prepare('SELECT COUNT(*) n FROM event').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM trip_event').get().n, 0)
    insertEvent(db)
    const trip = before[1][0]
    db.prepare('INSERT INTO trip_event VALUES(?,?,?,?)').run(trip.id, 'test-event', trip.dog_id, '2026-11-18T00:00:00Z')
    const content = db.prepare('SELECT * FROM event').all()
    const history = db.prepare('SELECT * FROM trip_event').all()
    const changes = db.prepare('SELECT total_changes() n').get().n
    initializeDatabase(db, () => { throw new Error('existing DB must not read schema.sql') }, migrations.slice(0, 1))
    assert.equal(db.prepare('SELECT total_changes() n').get().n, changes)
    db.close(); db = openDatabase(path, migrations.slice(0, 1))
    assert.deepEqual(existingData(db), before)
    assert.deepEqual(db.prepare('SELECT * FROM event').all(), content)
    assert.deepEqual(db.prepare('SELECT * FROM trip_event').all(), history)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})

test('fresh initialization and version-1 migration produce identical event tables, triggers and indexes', t => {
  const fresh = openDatabase(temporary(t))
  const path = temporary(t)
  legacy(path).close()
  const upgraded = openDatabase(path)
  try {
    const objects = db => db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
      WHERE tbl_name IN ('event','trip_event') ORDER BY type,name`).all()
      .map(row => ({ ...row, sql: row.sql?.replace(/\r\n/g, '\n') ?? null }))
    assert.deepEqual(objects(upgraded), objects(fresh))
    assert.equal(fresh.prepare('PRAGMA user_version').get().user_version, 6)
    assert.equal(upgraded.prepare("SELECT COUNT(*) n FROM pragma_table_info('event')").get().n, 12)
    assert.throws(() => insertEvent(upgraded, { place_tags: '["unknown"]' }), /invalid place tag/)
    assert.throws(() => insertEvent(upgraded, { match_tags: '[null]' }), /invalid interest category/)
  } finally { fresh.close(); upgraded.close() }
})

test('failed event migration rolls back both new tables, triggers, indexes and version; retry preserves old data', t => {
  const db = legacy(temporary(t))
  try {
    const before = existingData(db)
    const objects = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()
    const broken = [{ ...migrations[0], sql: migrations[0].sql + '\nINVALID SQL;' }]
    assert.throws(() => initializeDatabase(db, () => '', broken), /syntax error/)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
    assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), objects)
    assert.deepEqual(existingData(db), before)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    initializeDatabase(db, () => { throw new Error('must not rebuild') }, migrations.slice(0, 1))
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
    assert.deepEqual(existingData(db), before)
  } finally { db.close() }
})
