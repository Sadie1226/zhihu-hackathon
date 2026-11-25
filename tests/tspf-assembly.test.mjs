import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { isLegacyAssembly, isTspfAssembly, parseStoredAssembly } from '../contracts/assembly.ts'
import { TSPF_IDS } from '../contracts/tspf-ids.ts'
import { resolveTspfPlan, TSPF_ASSET_REVISION, TSPF_ASSET_ROOT } from '../lib/appearance/tspf-plan.ts'
import { initializeDatabase, openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'

const manifest = JSON.parse(readFileSync(join(TSPF_ASSET_ROOT, 'wardrobe.json'), 'utf8'))
const legacyFixtures = JSON.parse(readFileSync('contracts/fixtures/dog.json', 'utf8')).dogs
const v6Fixtures = JSON.parse(readFileSync('contracts/fixtures/dog-v6.json', 'utf8')).dogs
const good = manifest.modeRules.default
const seedSql = readFileSync('team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql', 'utf8')
const schema = () => readFileSync('contracts/schema.sql', 'utf8')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const insert = db => db.prepare(`INSERT INTO dog(id,session_id,personality_tags,assembly,created_at)
  VALUES (?,'fixture','["好奇","看物","直给"]',?,'2026-11-23T00:00:00Z')`)

const invalid = [
  { ...good, cloth: null },
  { ...good, outfit: TSPF_IDS.outfit[0] },
  { ...good, outfit: TSPF_IDS.outfit[0], cloth: null, accessory: TSPF_IDS.accessory[0] },
  { ...good, accessory: TSPF_IDS.accessory.slice(0, 2) },
  { ...good, face: 'F09-dark' },
  { ...good, cloth: TSPF_IDS.cloth.slice(0, 2) },
  { ...good, face: TSPF_IDS.face.slice(0, 2) },
  { ...good, accessory: 'P99-unknown' },
  { ...good, face: null },
  { ...good, cloth: 'jacket' },
  { ...good, face: 'happy' },
  { ...good, face: 'F01-neutral\u0000extra' },
  { ...good, accessory: TSPF_IDS.face[0] },
  { ...good, extra: 1 },
  { outfit: null, cloth: good.cloth, face: good.face },
  legacyFixtures[0].assembly,
  null,
]

function assertRules(db) {
  const put = insert(db)
  let count = 0
  function valid(value) {
    assert.ok(isTspfAssembly(value))
    put.run(`fixture-${count++}`, JSON.stringify(value))
  }
  for (const face of TSPF_IDS.face) {
    for (const outfit of TSPF_IDS.outfit) valid({ outfit, cloth: null, accessory: null, face })
    for (const cloth of TSPF_IDS.cloth) {
      for (const accessory of [null, ...TSPF_IDS.accessory]) valid({ outfit: null, cloth, accessory, face })
    }
  }
  assert.equal(count, 864)
  for (const value of invalid) {
    assert.equal(isTspfAssembly(value), false)
    assert.throws(() => put.run('invalid', JSON.stringify(value)), /invalid T\/S\/P\/F/)
  }
  for (const raw of ['{}', '[]', '{invalid', JSON.stringify(good) + '\u0000extra', Buffer.from(JSON.stringify(good)),
    '{"outfit":null,"cloth":"S02-leaf-cape","accessory":null,"face":"F01-neutral","face":"F02-wink"}']) {
    assert.throws(() => put.run('invalid-raw', raw), /invalid T\/S\/P\/F/)
  }
  assert.throws(() => db.prepare("UPDATE dog SET assembly=? WHERE id='fixture-0'")
    .run(JSON.stringify(legacyFixtures[0].assembly)), /invalid T\/S\/P\/F/)
}

test('TS, r2 whitelist and fresh SQLite accept the same 864 selections and reject illegal shapes', () => {
  const expected = {
    outfit: manifest.items.filter(row => row.category === 'sets').map(row => row.id),
    cloth: manifest.items.filter(row => row.category === 'singles').map(row => row.id),
    accessory: manifest.items.filter(row => row.category === 'accessories').map(row => row.id),
    face: manifest.expressions.map(row => row.id),
  }
  assert.deepEqual(TSPF_IDS, expected)
  assert.deepEqual(Object.values(expected).map(items => items.length), [6, 9, 9, 9])
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(schema())
    assertRules(db)
    for (const { assembly } of v6Fixtures) assert.ok(isTspfAssembly(assembly))
    for (const { assembly } of legacyFixtures) assert.deepEqual(parseStoredAssembly(JSON.stringify(assembly)), assembly)
    assert.throws(() => parseStoredAssembly(JSON.stringify({ ...good, face: 'F09-dark' })), /Invalid stored assembly/)
    assert.throws(() => db.exec(seedSql), /invalid T\/S\/P\/F/)
  } finally { db.close() }
})

test('r2 paths, SHA-256, RGBA canvas and render order match the adopted assets', () => {
  const all = [...manifest.items, ...manifest.expressions]
  const sums = JSON.parse(readFileSync(join(TSPF_ASSET_ROOT, 'SHA256SUMS.json'), 'utf8'))
  for (const row of [...all, ...[manifest.base, manifest.expressionBase].map(layer => ({ layer, sha256: sums[layer], offset: [0, 0] }))]) {
    const bytes = readFileSync(join(TSPF_ASSET_ROOT, row.layer))
    assert.equal(sha(bytes), row.sha256)
    assert.equal(bytes.toString('ascii', 12, 16), 'IHDR')
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20), bytes[24], bytes[25]], [1024, 1024, 8, 6])
    assert.deepEqual(row.offset, [0, 0])
  }
  const plan = resolveTspfPlan(good)
  assert.equal(plan.revision, TSPF_ASSET_REVISION)
  assert.deepEqual(plan.footAnchor, { x: 522, y: 950 })
  assert.deepEqual(plan.layers.map(layer => layer.path), [manifest.base, all.find(row => row.id === good.cloth).layer])
  const worn = { ...good, accessory: 'P13-blue-cap', face: 'F02-wink' }
  const dressed = resolveTspfPlan(worn)
  assert.deepEqual(dressed.layers.map(layer => layer.role), ['body', 'face', 'clothing', 'front-accessory'])
  assert.equal(dressed.layers[0].path, manifest.expressionBase)
  const removed = resolveTspfPlan({ ...worn, accessory: null })
  assert.deepEqual(removed.layers.map(layer => layer.role), ['body', 'face', 'clothing'])
  assert.deepEqual(resolveTspfPlan(worn), dressed)
  const wings = resolveTspfPlan({ ...worn, accessory: 'P19-blue-wings' })
  assert.deepEqual(wings.layers.map(layer => layer.role), ['back-accessory', 'body', 'face', 'clothing'])
  assert.equal(wings.layers[0].sha256, all.find(row => row.id === 'P19-blue-wings').sha256)
  for (const plan of [dressed, wings]) for (const layer of plan.layers) {
    assert.deepEqual([layer.width, layer.height, layer.left, layer.top], [1024, 1024, 0, 0])
    assert.ok(existsSync(join(TSPF_ASSET_ROOT, layer.path)))
  }
  const outfit = { outfit: 'T01-frog', cloth: null, accessory: null, face: worn.face }
  assert.deepEqual(resolveTspfPlan(outfit).layers.map(layer => layer.role), ['body', 'face', 'clothing'])
  assert.notEqual(resolveTspfPlan(outfit).layers.at(-1).path, dressed.layers.at(-2).path)
  assert.throws(() => resolveTspfPlan({ ...outfit, accessory: worn.accessory }), /Invalid T\/S\/P\/F/)
})

test('v5 seed SQL and historical rows survive atomic upgrade, rollback and restart byte-for-byte', t => {
  const root = resolve('.local/k6-tests')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'case-'))
  const path = join(directory, 'app.sqlite')
  t.after(() => {
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  let db = new DatabaseSync(path)
  function rows() {
    return Object.fromEntries(['dog', 'owner', 'trip', 'exchange', 'snapshot', 'wish']
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  }
  function triggers(connection) {
    return connection.prepare("SELECT name, sql FROM sqlite_schema WHERE name IN ('dog_assembly_ins','dog_assembly_upd') ORDER BY name").all()
      .map(({ name, sql }) => ({ name, sql: sql.replaceAll('\r\n', '\n') }))
  }
  try {
    db.exec('PRAGMA foreign_keys=ON')
    initializeDatabase(db, () => readFileSync('tests/fixtures/schema-v1.sql', 'utf8'), migrations.slice(0, 4))
    db.exec(seedSql)
    db.exec(seedSql)
    assert.equal(db.prepare('SELECT count(*) n FROM dog').get().n, 20)
    const historicAssembly = JSON.stringify(legacyFixtures[0].assembly, null, 2)
    insert(db).run('legacy-dog', historicAssembly)
    db.exec(`
      INSERT INTO owner VALUES ('legacy-owner','zhihu','zhihu','fixture-subject','2026-11-23T00:00:00Z');
      INSERT INTO trip(id,dog_id,seq,status,trigger,created_at) VALUES ('legacy-trip','legacy-dog',1,'pending','auto','2026-11-23T00:00:00Z');
      INSERT INTO exchange(id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at)
      VALUES ('legacy-exchange','dog_seed_01','legacy-dog','greeting','{"kind":"greeting","line":"fixture","weather":null}',1,'2026-11-23T00:00:00Z');
      INSERT INTO snapshot(dog_id,version,personality_tags,created_at)
      VALUES ('legacy-dog',1,'["好奇","看物","直给"]','2026-11-23T00:00:00Z');
      INSERT INTO wish(id,dog_id,text,category,created_at)
      VALUES ('legacy-wish','legacy-dog','历史心愿','自然风景','2026-11-23T00:00:00Z');
    `)
    const before = rows(), v5Triggers = triggers(db)
    assert.throws(() => initializeDatabase(db, schema, [...migrations.slice(0, 4),
      { ...migrations[4], sql: migrations[4].sql + '\nINVALID SQL' }]))
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5)
    assert.deepEqual(triggers(db), v5Triggers)
    assert.deepEqual(rows(), before)
    db.close()
    db = openDatabase(path)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8)
    assert.deepEqual(rows(), before)
    assert.ok(rows().dog.every(row => isLegacyAssembly(parseStoredAssembly(row.assembly))))
    assert.equal(db.prepare("SELECT assembly FROM dog WHERE id='legacy-dog'").get().assembly, historicAssembly)
    assert.throws(() => db.exec(seedSql), /invalid T\/S\/P\/F/)
    db.exec("UPDATE dog SET name='旧狗' WHERE id='legacy-dog'")
    assert.equal(db.prepare("SELECT assembly FROM dog WHERE id='legacy-dog'").get().assembly, historicAssembly)
    const fresh = new DatabaseSync(':memory:')
    try {
      fresh.exec(schema())
      assert.deepEqual(triggers(db), triggers(fresh))
    } finally { fresh.close() }
    assertRules(db)
    const update = db.prepare("UPDATE dog SET assembly=? WHERE id='legacy-dog'")
    assert.throws(() => update.run(historicAssembly), /invalid T\/S\/P\/F/)
    update.run(JSON.stringify(good))
    db.close()
    db = openDatabase(path)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8)
    assert.deepEqual(parseStoredAssembly(db.prepare("SELECT assembly FROM dog WHERE id='legacy-dog'").get().assembly), good)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { if (db.isOpen) db.close() }
})
