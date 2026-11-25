import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { initializeDatabase, openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { CHAT_MESSAGE_V9_SQL, chatMessageMigration } from '../lib/db/migrations/009-chat-message.ts'
import { insertDog, mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'

const freshSchema = readFileSync('contracts/schema.sql', 'utf8')
const freshIncrement = readFileSync('contracts/schema-v9-chat.sql', 'utf8')
const clean = sql => sql.replace(/\r\n/g, '\n').trim()
const schemaV1 = readFileSync('tests/fixtures/schema-v1.sql', 'utf8')
const v8 = migrations.filter(migration => migration.version <= 8)
const hasV8 = v8.at(-1)?.version === 8
const needsV8 = hasV8 ? false : '需要已审 v8 的隔离组合工作树'
const candidate = [...v8, chatMessageMigration]
const at = '2026-11-25T02:00:00.000Z'
const version = db => db.prepare('PRAGMA user_version').get().user_version
const objects = db => db.prepare(`SELECT type, name, sql FROM sqlite_schema
  WHERE tbl_name = 'chat_message' ORDER BY type, name`).all().map(row => ({
  ...row, sql: row.sql === null ? null : clean(row.sql),
}))
const histories = db => ['owner', 'owner_session', 'dog', 'trip', 'trip_event', 'trip_event_fact', 'snapshot',
  'trip_snapshot', 'exchange', 'find', 'message', 'reply', 'invitation', 'wish', 'relation']
  .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
const receipts = db => db.prepare('SELECT * FROM trip_discovery_receipt ORDER BY trip_id').all()

function check(db) {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
}

async function seedHistory(db, includeReceipt) {
  const [{ createTripService }, { createTripEventSelector }, { createTripDiscoveryComposer },
    { createTripDiscoverySearch }, { createZhihuSearchClient }] = await Promise.all([
    import('../lib/trips/service.ts'), import('../lib/events/select.ts'), import('../lib/trips/composer.ts'),
    import('../lib/trips/discover.ts'), import('../lib/zhihu/client.ts'),
  ])
  const owner = ownedDog(db, 'migration-owner-dog')
  insertDog(db, 'migration-sample-dog', 'sample-local', 1)
  db.prepare(`INSERT INTO exchange(id, from_dog, to_dog, kind, payload, deliver_after_trip_seq, created_at)
    VALUES (?, ?, ?, 'greeting', ?, 1, ?)`).run('fixture-exchange', 'migration-sample-dog', owner.id,
    JSON.stringify({ kind: 'greeting', line: '出发验证', weather: null }), at)
  const now = () => new Date(at)
  const trips = createTripService(db, { now })
  const trip = trips.create(owner.id, owner.sessionId, 'auto')
  const started = trips.start(trip.id, owner.sessionId)
  assert.deepEqual(started.delivered.map(row => row.id), ['fixture-exchange'])
  assert.equal(db.prepare('SELECT snapshot_version FROM trip_snapshot WHERE trip_id = ?').get(trip.id).snapshot_version, 1)
  db.exec(readFileSync('team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql', 'utf8'))
  db.exec("UPDATE event SET enabled = (code = 'any_shop_cat')")
  const occurrence = createTripEventSelector(db, { now, random: () => 0 })({
    dogId: owner.id, tripId: trip.id, sessionId: owner.sessionId,
    conditions: { sceneFile: 'scenes/nantou.png', season: 'spring', weather: 'clear', timeOfDay: 'morning' },
  })
  assert.ok(occurrence)
  assert.equal(db.prepare('SELECT history_status FROM v_trip_event_history WHERE trip_id = ?').get(trip.id).history_status, 'frozen')

  const request = new Request('http://localhost/api/trips/test/finds', { headers: { cookie: owner.cookie } })
  const intentId = 'chat-v9-receipt-preservation'
  let findIds = []
  if (includeReceipt) {
    const provider = createZhihuSearchClient({ accessSecret: 'synthetic-test-credential', now: () => Date.parse(at),
      fetch: async () => Response.json({ Code: 0, Data: { Items: [{
        Title: '隔离库搜索材料', Url: 'https://www.zhihu.com/question/123/answer/902',
      }] } }) })
    const result = await createTripDiscoverySearch(db, provider, { now })(trip.id, request, intentId)
    assert.equal(result.ok, true)
    const composition = createTripDiscoveryComposer(db, { now })(trip.id, request, {
      intentId, searchProofs: result.proofs, observations: [{
        id: 'schema-test-scene', tripId: trip.id, dogId: owner.id, kind: 'scene',
        happenedAt: at, title: '隔离库场景', excerpt: null, topics: [],
      }],
    })
    assert.equal(composition.status, 'complete')
    assert.equal(receipts(db).length, 1)
    findIds = composition.finds.map(find => find.id)
  } else {
    trips.finish(trip.id, owner.sessionId, 'done')
  }
  return { tripId: trip.id, request, intentId, findIds }
}

test('fresh schema increment and migration DDL match after newline normalization', () => {
  assert.equal(clean(freshIncrement.replace(/^--[^\n]*\n/, '')), clean(CHAT_MESSAGE_V9_SQL))
  assert.equal(chatMessageMigration.version, 9)
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(freshSchema + '\n' + freshIncrement)
    const prior = objects(db)
    db.exec(CHAT_MESSAGE_V9_SQL)
    assert.deepEqual(objects(db), prior)
    assert.deepEqual(prior.map(row => row.type), ['index', 'index', 'table', 'trigger'])
    check(db)
  } finally { db.close() }
})

test('fresh final schema and v8/v7 upgrades agree; genuine receipts and G3 history survive restart',
  { skip: needsV8 }, async t => {
    const fresh = new DatabaseSync(':memory:')
    try {
      initializeDatabase(fresh, () => freshSchema + '\n' + freshIncrement, candidate)
      assert.equal(version(fresh), 9)
      check(fresh)
      for (const from of [7, 8]) {
        const { db, path } = mailboxDatabase(t, v8.filter(migration => migration.version <= from), schemaV1)
        assert.equal(version(db), from)
        assert.deepEqual(objects(db), [])
        const { tripId, request, intentId, findIds } = await seedHistory(db, from === 8)
        const prior = histories(db)
        const priorReceipts = from === 8 ? receipts(db) : []
        db.close()
        for (let opening = 0; opening < 2; opening++) {
          const upgraded = openDatabase(path, candidate)
          try {
            assert.equal(version(upgraded), 9)
            assert.deepEqual(objects(upgraded), objects(fresh))
            assert.deepEqual(histories(upgraded), prior)
            assert.deepEqual(receipts(upgraded), priorReceipts)
            if (from === 8) {
              const { createTripDiscoverySearch } = await import('../lib/trips/discover.ts')
              const replay = await createTripDiscoverySearch(upgraded, undefined, { now: () => new Date(at) })(tripId, request, intentId)
              assert.equal(replay.ok, true)
              assert.equal(replay.replay.confirmation.replayed, true)
              assert.deepEqual(replay.replay.finds.map(find => find.id), findIds)
              assert.equal(replay.proofs.length, 0)
            }
            assert.equal(upgraded.prepare('SELECT count(*) AS n FROM chat_message').get().n, 0)
            check(upgraded)
          } finally { upgraded.close() }
        }
      }
    } finally { fresh.close() }
  })

test('v9 DDL failure rolls back schema, rows and version, including v8 on a v7-to-v9 upgrade',
  { skip: needsV8 }, async t => {
    for (const from of [7, 8]) {
      const { db, path } = mailboxDatabase(t, v8.filter(migration => migration.version <= from), schemaV1)
      await seedHistory(db, from === 8)
      const prior = histories(db)
      const schema = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()
      const priorReceipts = from === 8 ? receipts(db) : []
      db.close()
      const broken = [...v8, { ...chatMessageMigration, sql: CHAT_MESSAGE_V9_SQL + '\n INVALID SQL;' }]
      assert.throws(() => openDatabase(path, broken), /syntax error/)
      const unchanged = new DatabaseSync(path, { readOnly: true })
      try {
        assert.equal(version(unchanged), from)
        assert.deepEqual(unchanged.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), schema)
        assert.deepEqual(histories(unchanged), prior)
        assert.deepEqual(objects(unchanged), [])
        if (from === 8) assert.deepEqual(receipts(unchanged), priorReceipts)
        check(unchanged)
      } finally { unchanged.close() }
      const upgraded = openDatabase(path, candidate)
      try {
        assert.equal(version(upgraded), 9)
        assert.deepEqual(histories(upgraded), prior)
        assert.deepEqual(receipts(upgraded), priorReceipts)
        check(upgraded)
      } finally { upgraded.close() }
    }
  })
