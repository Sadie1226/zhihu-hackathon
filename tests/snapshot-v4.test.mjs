import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initializeDatabase, openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { SNAPSHOT_V4_TRIGGERS_SQL } from '../lib/db/migrations/004-snapshot-interest-null.ts'

const root = resolve('.local/k4-tests')
mkdirSync(root, { recursive: true })
const fixture = name => JSON.parse(readFileSync(`contracts/fixtures/${name}.json`, 'utf8'))
const oldSchema = readFileSync('tests/fixtures/schema-v1.sql', 'utf8')
const v6Migrations = migrations.filter(migration => migration.version <= 6)
function temporary(t) {
  const directory = mkdtempSync(join(root, 'database-'))
  t.after(() => {
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  return join(directory, 'app.sqlite')
}
function insert(db, table, row) {
  const keys = Object.keys(row)
  db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : v))
}
function seed(db, dogFixture = 'dog') {
  for (const dog of fixture(dogFixture).dogs) insert(db, 'dog', dog)
  for (const snapshot of fixture('snapshot').snapshots.filter(s => s.interest_categories !== null)) insert(db, 'snapshot', snapshot)
  // Preserve several historical versions for the same dog.
  insert(db, 'snapshot', { ...fixture('snapshot').snapshots[0], version: 7 })
  for (const trip of fixture('trip').trips) insert(db, 'trip', trip)
  for (const exchange of fixture('exchange').exchanges) insert(db, 'exchange', exchange)
}
const snapshots = db => db.prepare('SELECT * FROM snapshot ORDER BY dog_id,version').all()
function legacy(path, version) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys=ON')
  initializeDatabase(db, () => oldSchema, migrations.slice(0, version - 1))
  seed(db)
  return db
}

test('fresh database accepts snapshot NULL for dog with no selected interests; preserves seven-column whitelist and PK', t => {
  const db = openDatabase(temporary(t))
  try {
    insert(db, 'dog', { ...fixture('dog-v6').dogs[0], interest_categories: null })
    insert(db, 'snapshot', { ...fixture('snapshot').snapshots[0], interest_categories: null })
    assert.equal(snapshots(db)[0].interest_categories, null)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9)
    const columns = db.prepare("PRAGMA table_info('snapshot')").all()
    assert.deepEqual(columns.map(c => c.name), ['dog_id','version','personality_tags','interest_categories','recent_trips','waiting_for','created_at'])
    assert.deepEqual(columns.filter(c => c.pk).map(c => [c.name,c.pk]), [['dog_id',1],['version',2]])
    assert.equal(columns.find(c => c.name === 'interest_categories').notnull, 0)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(db.prepare("PRAGMA foreign_key_list('snapshot')").get().table, 'dog')
    insert(db,'dog',fixture('dog-v6').dogs[1])
    db.prepare(`INSERT INTO exchange(id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at)
      VALUES('null-interest-fixture','dog_owner','dog_seed_07','greeting',?,1,'2026-11-19T00:00:00Z')`)
      .run(JSON.stringify({kind:'greeting',line:'fixture',weather:null}))
    assert.equal(db.prepare('SELECT COUNT(*) n FROM exchange').get().n,1)
  } finally { db.close() }
})

test('non-NULL snapshots require JSON arrays with 2–3 existing categories, on INSERT and UPDATE', t => {
  const db = openDatabase(temporary(t), v6Migrations)
  try {
    insert(db, 'dog', fixture('dog-v6').dogs[0])
    insert(db, 'snapshot', { ...fixture('snapshot').snapshots[0], interest_categories: null })
    const update = db.prepare('UPDATE snapshot SET interest_categories=?')
    for (const bad of ['', '[', 'null', '{}', '[]', '[1,2]', '[null,null]', '["unknown","unknown"]',
      JSON.stringify([fixture('snapshot').snapshots[0].interest_categories[0]]),
      JSON.stringify([...fixture('snapshot').snapshots[1].interest_categories, fixture('snapshot').snapshots[0].interest_categories[0]])]) {
      assert.throws(() => update.run(bad))
      assert.throws(() => db.prepare(`INSERT INTO snapshot(dog_id,version,personality_tags,interest_categories,created_at)
        SELECT dog_id,9,personality_tags,?,created_at FROM snapshot WHERE version=1`).run(bad))
      assert.equal(snapshots(db)[0].interest_categories, null)
    }
    for (const snapshot of fixture('snapshot').snapshots.filter(s => s.interest_categories !== null)) {
      update.run(JSON.stringify(snapshot.interest_categories))
      assert.deepEqual(JSON.parse(snapshots(db)[0].interest_categories), snapshot.interest_categories)
    }
    update.run(null)
    assert.equal(snapshots(db)[0].interest_categories, null)
  } finally { db.close() }
})

test('fresh schema does not rebuild snapshots in migration v4; triggers agree with frozen migration', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    initializeDatabase(db, () => readFileSync('contracts/schema.sql','utf8'), migrations.slice(0,2))
    seed(db, 'dog-v6')
    const schema = db.prepare("SELECT * FROM sqlite_schema WHERE tbl_name='snapshot' ORDER BY name").all()
    const changes = db.prepare('SELECT total_changes() n').get().n
    initializeDatabase(db, () => { throw new Error('must not reread schema') }, v6Migrations)
    assert.deepEqual(db.prepare("SELECT * FROM sqlite_schema WHERE tbl_name='snapshot' ORDER BY name").all(), schema)
    assert.equal(db.prepare('SELECT total_changes() n').get().n, changes)
    const fresh = readFileSync('contracts/schema.sql','utf8').replaceAll('\r\n','\n')
    assert.ok(fresh.includes(SNAPSHOT_V4_TRIGGERS_SQL))
  } finally { db.close() }
})

for (const version of [1,2,3]) {
  test(`v${version} -> current preserves every snapshot field/version, keys, other business data, custom objects and restart state`, t => {
    const path = temporary(t)
    let db = legacy(path, version)
    const before = snapshots(db)
    const others = Object.fromEntries(['dog','trip','exchange'].map(table => [table,db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]))
    db.exec(`CREATE INDEX snapshot_custom ON snapshot(created_at);
      CREATE VIEW snapshot_public AS SELECT dog_id,version,interest_categories FROM snapshot;
      CREATE TABLE fixture_audit(value TEXT);
      CREATE TRIGGER snapshot_audit AFTER INSERT ON snapshot BEGIN INSERT INTO fixture_audit VALUES('insert'); END;
      CREATE TRIGGER snapshot_view_delete INSTEAD OF DELETE ON snapshot_public BEGIN SELECT 1; END;
      CREATE TRIGGER dog_snapshot_reference AFTER UPDATE OF name ON dog BEGIN SELECT count(*) FROM snapshot; END;`)
    const preservedObjects = db.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('snapshot_custom','snapshot_public','snapshot_audit','snapshot_view_delete','dog_snapshot_reference') ORDER BY name").all()
    db.close(); db = openDatabase(path)
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9)
      assert.deepEqual(snapshots(db), before)
      for (const [table, rows] of Object.entries(others)) {
        const actual = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
        for (const [i, row] of rows.entries()) for (const key of Object.keys(row)) assert.deepEqual(actual[i][key],row[key])
      }
      for (const row of preservedObjects) assert.equal(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(row.name).sql,row.sql)
      assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture_audit').get().n, 0, 'copy must not replay custom side effects')
      assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshot_public').get().n, before.length)
      insert(db,'snapshot',{ ...fixture('snapshot').snapshots[0], version:8, interest_categories:null })
      assert.throws(() => insert(db,'snapshot',{ ...fixture('snapshot').snapshots[0],version:8,interest_categories:null }),/snapshot version already exists/)
      assert.throws(() => insert(db,'snapshot',{ ...fixture('snapshot').snapshots[0],dog_id:'missing',interest_categories:null }),/FOREIGN KEY/)
      assert.throws(() => db.exec("UPDATE snapshot SET recent_trips='[1,2,3,4]'"),/snapshot version is immutable/)
      assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture_audit').get().n, 1)
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
      const all = snapshots(db)
      initializeDatabase(db, () => { throw new Error('no schema replay') })
      db.close(); db = openDatabase(path)
      assert.deepEqual(snapshots(db),all)
    } finally { db.close() }
  })
  test(`v${version} failed v4 migration rolls back rebuilt schema, custom objects, every row and version; retry succeeds`, t => {
    const db = legacy(temporary(t),version)
    try {
      const before = snapshots(db), schema = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()
      const broken = [...migrations.slice(0,2), { ...migrations[2], sql: connection => migrations[2].sql(connection) + '\nINVALID SQL;' }]
      assert.throws(() => initializeDatabase(db, () => '', broken),/syntax error/)
      assert.equal(db.prepare('PRAGMA user_version').get().user_version,version)
      assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),schema)
      assert.deepEqual(snapshots(db),before)
      assert.equal(db.prepare("SELECT COUNT(*) n FROM temp.sqlite_schema WHERE name='snapshot_v4_backup'").get().n,0)
      initializeDatabase(db, () => { throw new Error('no rebuilding DB') })
      assert.deepEqual(snapshots(db),before)
    } finally { db.close() }
  })
}

test('unexpected incoming FK or invalid legacy category aborts safely without dropping historical data', t => {
  for (const incoming of [true,false]) {
    const db = legacy(temporary(t),3)
    try {
      if (incoming) db.exec('CREATE TABLE fixture_child(dog_id TEXT,version INTEGER,FOREIGN KEY(dog_id,version) REFERENCES snapshot(dog_id,version))')
      else db.exec("UPDATE snapshot SET interest_categories='[1,2]'")
      const rows = snapshots(db), schema = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()
      assert.throws(() => initializeDatabase(db, () => ''))
      assert.deepEqual(snapshots(db),rows)
      assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),schema)
      assert.equal(db.prepare('PRAGMA user_version').get().user_version,3)
    } finally { db.close() }
  }
})
