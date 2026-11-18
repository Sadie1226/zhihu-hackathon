import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { APPLICATION_ID, BUSY_TIMEOUT_MS, initializeDatabase, openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'

const root = resolve('.local/c2-tests')
mkdirSync(root, { recursive: true })
function temporary(t) {
  const directory = mkdtempSync(join(root, 'database-'))
  t.after(() => {
    assert.ok(directory.startsWith(root + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  return join(directory, 'nested', 'app.sqlite')
}
function insertMarker(db) {
  const fixture = JSON.parse(readFileSync('contracts/fixtures/dog.json', 'utf8')).dogs[0]
  db.prepare('INSERT INTO dog (id,session_id,personality_tags,assembly,created_at) VALUES (?,?,?,?,?)')
    .run('c2-persistence-test', 'test-session', JSON.stringify(fixture.personality_tags),
      JSON.stringify(fixture.assembly), '2026-11-16T00:00:00Z')
}

test('new file: contract tables, foreign keys, WAL, timeout and version are initialized', (t) => {
  const db = openDatabase(temporary(t))
  try {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table'").get().n, 12)
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, BUSY_TIMEOUT_MS)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(db.prepare('PRAGMA application_id').get().application_id, APPLICATION_ID)
    assert.throws(() => db.exec("INSERT INTO snapshot(dog_id,version,personality_tags,interest_categories,created_at) VALUES('missing',1,'[1,2,3]','[1,2]','test')"), /FOREIGN KEY/)
  } finally { db.close() }
})

test('repeated initialization and reopen preserve data without rerunning CREATE statements', (t) => {
  const path = temporary(t)
  let db = openDatabase(path)
  try {
    insertMarker(db)
    initializeDatabase(db, () => { throw new Error('schema must not be read again') })
  } finally { db.close() }
  db = openDatabase(path)
  try { assert.equal(db.prepare('SELECT COUNT(*) n FROM dog').get().n, 1) }
  finally { db.close() }
})

test('unversioned existing database is refused and its data is preserved', (t) => {
  const path = temporary(t)
  mkdirSync(resolve(path, '..'), { recursive: true })
  const old = new DatabaseSync(path)
  old.exec("CREATE TABLE existing(value TEXT); INSERT INTO existing VALUES('keep')")
  old.close()
  assert.throws(() => openDatabase(path), /explicit adoption/)
  const check = new DatabaseSync(path)
  try {
    assert.equal(check.prepare('SELECT value FROM existing').get().value, 'keep')
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 0)
  } finally { check.close() }
})

test('non-SQLite file is refused without replacement', (t) => {
  const path = temporary(t)
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, 'existing non-database contents')
  const before = readFileSync(path)
  assert.throws(() => openDatabase(path))
  assert.deepEqual(readFileSync(path), before)
})

test('failed new schema rolls back all DDL and version stamps', () => {
  const db = new DatabaseSync(':memory:')
  try {
    assert.throws(() => initializeDatabase(db, () => 'CREATE TABLE partial(id TEXT); INVALID SQL;'))
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0)
    assert.equal(db.prepare('PRAGMA application_id').get().application_id, 0)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table'").get().n, 0)
  } finally { db.close() }
})

test('additive migration runs once, preserves data and rejects application downgrade', (t) => {
  const path = temporary(t)
  let db = openDatabase(path)
  insertMarker(db)
  db.close()
  const changes = [...migrations, { version: 3, name: 'test index', sql: 'CREATE INDEX idx_c2_test_name ON dog(name)' }]
  db = openDatabase(path, changes)
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3)
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='idx_c2_test_name'").get())
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dog').get().n, 1)
  } finally { db.close() }
  db = openDatabase(path, changes)
  db.close()
  assert.throws(() => openDatabase(path), /newer than this application/)
})

test('failed additive migration preserves old version, schema and data', (t) => {
  const path = temporary(t)
  const db = openDatabase(path)
  insertMarker(db)
  try {
    assert.throws(() => initializeDatabase(db, () => '', [...migrations, {
      version: 3, name: 'broken test migration', sql: 'CREATE INDEX idx_partial ON dog(name); INVALID SQL;',
    }]))
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='idx_partial'").get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dog').get().n, 1)
  } finally { db.close() }
})

test('foreign application ID and nonconsecutive migrations are refused', (t) => {
  const path = temporary(t)
  const db = openDatabase(path)
  db.exec('PRAGMA application_id = 42')
  db.close()
  assert.throws(() => openDatabase(path), /different application/)
  const clean = new DatabaseSync(':memory:')
  try {
    assert.throws(() => initializeDatabase(clean, () => '', [{ version: 3, name: 'gap', sql: 'SELECT 1' }]), /consecutive/)
  } finally { clean.close() }
})

test('parallel processes can initialize the same new database safely', async (t) => {
  const path = temporary(t)
  const moduleUrl = new URL('../lib/db/bootstrap.ts', import.meta.url).href
  const script = `import { openDatabase } from ${JSON.stringify(moduleUrl)}; const db=openDatabase(${JSON.stringify(path)}); db.close();`
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolveChild() : reject(new Error(stderr)))
  })))
  const db = openDatabase(path)
  try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2) }
  finally { db.close() }
})
