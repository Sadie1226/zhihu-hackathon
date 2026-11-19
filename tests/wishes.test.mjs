import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { initializeDatabase, openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { WISH_SCHEMA_V3_SQL } from '../lib/db/migrations/003-wishes.ts'
import { canonicalZhihuContentUrl, ownerWishFields, collectionWishFields,
  selectActiveWish, revokeWish, readTripWish } from '../lib/wishes/contract.ts'
import { createTripService } from '../lib/trips/service.ts'

const read = path => readFileSync(path, 'utf8')
const fixture = name => JSON.parse(read(`contracts/fixtures/${name}.json`))
const root = resolve('.local/wish-tests')
mkdirSync(root, { recursive: true })
function temporary(t, beforeRemove = () => {}) {
  const directory = mkdtempSync(join(root, 'database-'))
  t.after(() => {
    beforeRemove()
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  return join(directory, 'app.sqlite')
}
function insert(db, table, row) {
  const keys = Object.keys(row)
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row).map(value => typeof value === 'boolean' ? Number(value)
      : value && typeof value === 'object' ? JSON.stringify(value) : value))
}
function dogs(db) {
  for (const dog of fixture('dog').dogs) insert(db, 'dog', dog)
}
function setup(t) {
  let db
  const path = temporary(t, () => { if (db?.isOpen) db.close() })
  db = openDatabase(path)
  dogs(db)
  return { db, path }
}
const owner = 'dog_owner', session = 's_demo_001'
function wish(db, overrides = {}) {
  const row = { id: 'w1', dog_id: owner, text: 'fixture wish', category: fixture('wish').wishes[0].category,
    created_at: '2026-11-18T00:00:00Z', source: 'owner', source_url: null, ...overrides }
  insert(db, 'wish', row)
  return row
}
const missing = { code: 'NOT_FOUND' }, conflict = { code: 'CONFLICT' }
const url = 'https://www.zhihu.com/question/123/answer/456'

test('fresh schema and migration share v3 views, indexes and triggers; default legacy source is owner', t => {
  const { db } = setup(t)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4)
  const block = read('contracts/schema.sql').split('-- c3-wish-v3: begin')[1].split('-- c3-wish-v3: end')[0]
  assert.equal(block.replaceAll('\r\n', '\n').trim(), WISH_SCHEMA_V3_SQL.trim())
  db.prepare('INSERT INTO wish(id,dog_id,text,category,created_at) VALUES(?,?,?,?,?)')
    .run('legacy-owner', owner, 'fixture', fixture('wish').wishes[0].category, '2026-11-18T00:00:00Z')
  const row = db.prepare("SELECT source,source_url FROM wish WHERE id='legacy-owner'").get()
  assert.deepEqual({ ...row }, { source: 'owner', source_url: null })
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('canonical URLs preserve content identities and strip query/fragment/trailing slash noise', () => {
  assert.equal(canonicalZhihuContentUrl('HTTPS://ZHIHU.COM/question/123/answer/456/?utm_source=share#comment'), url)
  assert.equal(canonicalZhihuContentUrl('https://www.zhihu.com/question/123?utm=fixture'), 'https://www.zhihu.com/question/123')
  assert.equal(canonicalZhihuContentUrl('https://zhuanlan.zhihu.com/p/789/?utm=fixture#x'), 'https://zhuanlan.zhihu.com/p/789')
  assert.notEqual(canonicalZhihuContentUrl(url), canonicalZhihuContentUrl(url.replace('456', '457')))
  assert.notEqual(canonicalZhihuContentUrl(url), canonicalZhihuContentUrl('https://www.zhihu.com/question/123'))
  assert.notEqual(canonicalZhihuContentUrl('https://zhuanlan.zhihu.com/p/456'), canonicalZhihuContentUrl(url))
  for (const input of [null, '', 5, 'http://www.zhihu.com/question/1', 'javascript:alert(1)',
    '//www.zhihu.com/question/1', 'https://evil.test/question/1', 'https://www.zhihu.com.evil.test/question/1',
    'https://www.zhihu.com@evil.test/question/1', 'https://user@www.zhihu.com/question/1',
    'https://www.zhihu.com:443/question/1', 'https://www.zhihu.com./question/1',
    'https://www%2ezhihu.com/question/1', 'https://link.zhihu.com/?target=https://evil.test',
    'https://www.zhihu.com/people/abc', 'https://www.zhihu.com/collection/1',
    'https://www.zhihu.com/answer/456', 'https://zhuanlan.zhihu.com/question/1',
    'https://www.zhihu.com/question/01', 'https://www.zhihu.com/question/0',
    'https://www.zhihu.com/question/%31', 'https://www.zhihu.com/a/../question/1',
    'https://www.zhihu.com/question/1\\', ' https://www.zhihu.com/question/1',
    'https://www.zhihu.com/question/1\n', 'https://www.zhihu.com/question/1?x=\n',
    'https://www.zhihu.com/question/1?x=\u0000']) {
    assert.throws(() => canonicalZhihuContentUrl(input), conflict, String(input))
  }
})

test('public fields cannot supply source, ownership, URL or revocation; collection boundary checks session', t => {
  const { db } = setup(t)
  const input = { text: 'fixture', category: fixture('wish').wishes[0].category }
  assert.deepEqual(ownerWishFields(input), { ...input, source: 'owner', sourceUrl: null })
  for (const key of ['source', 'sourceUrl', 'source_url', 'session_id', 'sessionId', 'dog_id', 'revokedAt']) {
    assert.throws(() => ownerWishFields({ ...input, [key]: 'spoof' }), conflict)
  }
  assert.deepEqual(collectionWishFields(db, owner, session, url + '?tracking=1'), { source: 'collection', sourceUrl: url })
  assert.throws(() => collectionWishFields(db, owner, 'wrong', url), missing)
  assert.throws(() => collectionWishFields(db, 'missing', session, url), missing)
})

test('database rejects invalid source combinations and noncanonical content URLs', t => {
  const { db } = setup(t)
  for (const fields of [{ source: null }, { source: 'other' }, { source_url: url },
    ...[null, '', 'https://evil.test/p/1', url + '#x', url + '?utm=1', url + '/',
      url.replace('456', '0456'), 'https://www.zhihu.com/question/123/answer/456/answer/789']
      .map(source_url => ({ source: 'collection', source_url }))]) {
    assert.throws(() => wish(db, fields), /constraint|canonical/i)
  }
  for (const source_url of [url, 'https://zhuanlan.zhihu.com/p/789', 'https://www.zhihu.com/question/123']) {
    wish(db, { id: source_url, source: 'collection', source_url, revoked_at: '2026-11-18T00:01:00Z' })
  }
})

test('active view excludes withdrawn wishes; guarded retries preserve first timestamp and all rows', t => {
  const { db } = setup(t)
  wish(db)
  const first = revokeWish(db, 'w1', session, '2026-11-18T00:01:00Z')
  assert.deepEqual(revokeWish(db, 'w1', session, '2099-01-01T00:00:00Z'), first)
  assert.equal(selectActiveWish(db, owner, session), null)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM wish').get().n, 1)
  assert.throws(() => db.exec("UPDATE wish SET revoked_at = NULL"), /first revocation/)
  assert.throws(() => db.exec("UPDATE wish SET revoked_at = '2099-01-01T00:00:00Z'"), /first revocation/)
  assert.throws(() => db.exec('DELETE FROM wish'), /revoke instead of delete/)
})

test('same canonical collection content stays deduplicated after revoke, with one active slot per dog', t => {
  const { db } = setup(t)
  wish(db, { source: 'collection', source_url: canonicalZhihuContentUrl(url + '?utm_source=share#x') })
  assert.throws(() => wish(db, { id: 'w2', source: 'collection', source_url: url.replace('456', '457') }), /UNIQUE/)
  revokeWish(db, 'w1', session, '2026-11-18T00:01:00Z')
  assert.throws(() => wish(db, { id: 'w2', source: 'collection', source_url: url }), /UNIQUE/)
  wish(db, { id: 'w3', source: 'collection', source_url: url.replace('456', '457') })
  wish(db, { id: 'other-dog', dog_id: 'dog_seed_07', source: 'collection', source_url: url })
  assert.throws(() => db.prepare('UPDATE wish SET source_url=? WHERE id=?').run(url.replace('456', '999'), 'w1'), /provenance/)
  assert.throws(() => db.exec("UPDATE wish SET source='owner',source_url=NULL WHERE id='w1'"), /provenance/)
})

test('owner wishes precede newer collection wishes; revoke exposes next eligible candidate', t => {
  const { db } = setup(t)
  wish(db)
  wish(db, { id: 'collection', source: 'collection', source_url: url, created_at: '2026-11-19T00:00:00Z' })
  assert.equal(selectActiveWish(db, owner, session).id, 'w1')
  revokeWish(db, 'w1', session, '2026-11-19T00:00:00Z')
  assert.equal(selectActiveWish(db, owner, session).id, 'collection')
})

test('pending revocation is rechecked at start; history retains source/association after later withdrawal and restart', t => {
  const { db, path } = setup(t)
  wish(db)
  wish(db, { id: 'collection', source: 'collection', source_url: url })
  const trips = createTripService(db, { now: () => new Date('2026-11-19T00:00:00Z') })
  const pending = trips.create(owner, session, 'wish')
  assert.equal(pending.wishId, null)
  revokeWish(db, 'w1', session, '2026-11-18T23:00:00Z')
  const running = trips.start(pending.id, session).trip
  assert.equal(running.wishId, 'collection')
  const history = readTripWish(db, pending.id, session)
  revokeWish(db, 'collection', session, '2026-11-19T00:01:00Z')
  assert.equal(trips.start(pending.id, session).trip.wishId, 'collection')
  assert.equal(trips.finish(pending.id, session, 'done').trip.wishId, 'collection')
  assert.throws(() => db.prepare('UPDATE trip SET wish_id=NULL WHERE id=?').run(pending.id), /association is immutable/)
  assert.equal(selectActiveWish(db, owner, session), null)
  db.close()
  const reopened = openDatabase(path)
  try {
    const after = readTripWish(reopened, pending.id, session)
    for (const key of ['id', 'source', 'sourceUrl', 'text', 'category']) assert.equal(after[key], history[key])
    assert.equal(createTripService(reopened).get(pending.id, session).wishId, 'collection')
  } finally { reopened.close() }
})

test('no active wish leaves null provenance without changing lifecycle; foreign wish/session access rejected', t => {
  const { db } = setup(t)
  wish(db)
  const trips = createTripService(db, { now: () => new Date('2026-11-19T00:00:00Z') })
  const trip = trips.create(owner, session, 'wish')
  for (const unauthorized of ['wrong', '']) {
    assert.throws(() => selectActiveWish(db, owner, unauthorized), missing)
    assert.throws(() => revokeWish(db, 'w1', unauthorized, '2026-11-18T01:00:00Z'), missing)
    assert.throws(() => readTripWish(db, trip.id, unauthorized), missing)
    assert.throws(() => trips.start(trip.id, unauthorized), missing)
  }
  wish(db, { id: 'foreign-wish', dog_id: 'dog_seed_07' })
  assert.throws(() => db.prepare('UPDATE trip SET wish_id=? WHERE id=?').run('foreign-wish', trip.id), /same dog/)
  assert.throws(() => db.prepare('UPDATE trip SET wish_id=? WHERE id=?').run('missing', trip.id), /same dog/)
  revokeWish(db, 'w1', session, '2026-11-18T01:00:00Z')
  assert.equal(trips.start(trip.id, session).trip.wishId, null)
  assert.equal(readTripWish(db, trip.id, session), null)
})

function legacy(path, version) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys=ON')
  initializeDatabase(db, () => read('tests/fixtures/schema-v1.sql'), migrations.slice(0, version - 1))
  dogs(db)
  for (const w of fixture('wish').wishes.filter(w => w.source === 'owner')) {
    const row = { ...w }; delete row.source; delete row.source_url
    insert(db, 'wish', row)
  }
  for (const trip of fixture('trip').trips) insert(db, 'trip', trip)
  for (const exchange of fixture('exchange').exchanges) insert(db, 'exchange', exchange)
  if (version === 2) {
    insert(db, 'event', { id: 'legacy-event', code: 'legacy-event', text: 'fixture', season: 'any',
      weather: 'any', time_of_day: 'any' })
    const trip = fixture('trip').trips[0]
    insert(db, 'trip_event', { trip_id: trip.id, event_id: 'legacy-event', dog_id: trip.dog_id,
      happened_at: '2026-11-18T00:00:00Z' })
  }
  return db
}
const existing = db => Object.fromEntries(['dog', 'wish', 'trip', 'exchange', 'event', 'trip_event']
  .filter(table => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'trip_event' ? 'trip_id,event_id' : 'id'}`)
    .all().map(row => ({ ...row }))]))
function preserved(db, before) {
  const after = existing(db)
  for (const table of Object.keys(before)) {
    assert.equal(after[table].length, before[table].length)
    for (const [i, row] of before[table].entries()) {
      for (const key of Object.keys(row)) assert.deepEqual(after[table][i][key], row[key], `${table}.${key}`)
    }
  }
  assert.ok(after.wish.every(row => row.source === 'owner' && row.source_url === null))
  assert.ok(after.trip.every(row => row.wish_id === null))
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
}
for (const version of [1, 2]) {
  test(`version ${version} upgrades to current transactionally, preserves every legacy field, then reruns/reopens safely`, t => {
    const path = temporary(t)
    let db = legacy(path, version)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, version)
    const before = existing(db)
    db.close(); db = openDatabase(path)
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4)
      preserved(db, before)
      const objects = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()
      initializeDatabase(db, () => { throw new Error('No schema replay') })
      assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), objects)
      db.close(); db = openDatabase(path)
      preserved(db, before)
    } finally { db.close() }
  })
  test(`failed version ${version} upgrade rolls back columns, indexes, triggers, data and version; retry works`, t => {
    const db = legacy(temporary(t), version)
    try {
      const before = existing(db)
      const objects = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()
      const broken = [migrations[0], { ...migrations[1], sql: db => migrations[1].sql(db) + '\nINVALID SQL;' }]
      assert.throws(() => initializeDatabase(db, () => '', broken), /syntax error/)
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, version)
      assert.deepEqual(existing(db), before)
      assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), objects)
      initializeDatabase(db, () => { throw new Error('No rebuild') })
      preserved(db, before)
    } finally { db.close() }
  })
}

test('fixture round trip preserves every provenance field and explicit fixture marking', t => {
  const { db } = setup(t)
  const f = fixture('wish')
  assert.equal(f.sourceMode, 'fixture')
  for (const row of f.wishes) {
    insert(db, 'wish', row)
    assert.deepEqual({ ...db.prepare('SELECT * FROM wish WHERE id=?').get(row.id) }, row)
  }
})

test('two real concurrent processes cannot create two active collection wishes', async t => {
  const { db, path } = setup(t)
  const bootstrap = new URL('../lib/db/bootstrap.ts', import.meta.url).href
  const run = id => new Promise((resolveChild, reject) => {
    const row = { id: `concurrent-${id}`, dog_id: owner, text: 'fixture', category: fixture('wish').wishes[0].category,
      created_at: '2026-11-18T00:00:00Z', source: 'collection', source_url: url.replace('456', String(id)) }
    const code = `import {openDatabase} from ${JSON.stringify(bootstrap)};
      const db=openDatabase(${JSON.stringify(path)}); db.exec('BEGIN IMMEDIATE');
      try {db.prepare('INSERT INTO wish(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})')
        .run(...${JSON.stringify(Object.values(row))}); db.exec('COMMIT'); console.log('inserted');}
      catch(e) {db.exec('ROLLBACK'); if(!e.message.includes('UNIQUE constraint')) throw e; console.log('conflict');}
      finally {db.close();}`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true })
    let output = '', error = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolveChild(output.trim()) : reject(new Error(error)))
  })
  assert.deepEqual((await Promise.all([run(1001), run(1002)])).sort(), ['conflict', 'inserted'])
  assert.equal(db.prepare("SELECT COUNT(*) n FROM v_wish_active WHERE source='collection'").get().n, 1)
})
