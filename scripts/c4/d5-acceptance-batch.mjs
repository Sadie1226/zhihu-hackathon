import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync, backup } from 'node:sqlite'
import { initializeDatabase, openDatabase } from '../../lib/db/bootstrap.ts'
import { migrations } from '../../lib/db/migrations.ts'
import { createSeedTripRunner } from '../../lib/trips/seed-runner.ts'
import { readDepartureSnapshot } from '../../lib/trips/departure-snapshot.ts'

// C runs this once on A's execution SHA. Never opens/deletes the default application database.
const args = process.argv.slice(2)
const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
const directory = value('--out-dir'), batch = value('--batch'), expectedSha = value('--code-sha')
if (!directory || !batch || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(batch) || !/^[a-f0-9]{40}$/.test(expectedSha ?? '')) {
  throw new Error('Usage: node scripts/c4/d5-acceptance-batch.mjs --out-dir <NEW directory> --batch <batch id> --code-sha <A full execution SHA>')
}
const actualSha = execFileSync(process.env.GIT_EXE ?? 'git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
assert.equal(actualSha, expectedSha, 'Wrong execution code SHA')
assert.equal(execFileSync(process.env.GIT_EXE ?? 'git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), '', 'Tracked source must be clean')
const output = resolve(directory)
if (existsSync(output)) throw new Error('Output directory already exists; choose a new batch directory. No overwrite/force supported.')
mkdirSync(output, { recursive: true })
const source = join(output, 'source.sqlite'), destination = join(output, 'app.sqlite')
let db = new DatabaseSync(source)
const dogs = ['dog_seed_01', 'dog_seed_05', 'dog_seed_07', 'dog_seed_12', 'dog_seed_18']
const at = { value: '2026-11-25T00:00:00.000Z' }
const rows = []
try {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000')
  initializeDatabase(db, () => readFileSync('tests/fixtures/schema-v1.sql', 'utf8'), migrations.filter(m => m.version <= 5))
  db.exec(readFileSync('team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql', 'utf8'))
  const assemblies = db.prepare('SELECT id,assembly FROM dog ORDER BY id').all()
  db.close()
  db = openDatabase(source)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7)
  assert.deepEqual(db.prepare('SELECT id,assembly FROM dog ORDER BY id').all(), assemblies)
  db.exec(readFileSync('team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql', 'utf8'))
  db.exec(readFileSync('team/2026-11-23/d/1123-d2c-事件条件修正-v1.sql', 'utf8'))
  const runner = createSeedTripRunner(db, { now: () => new Date(at.value) })
  for (const [i, dogId] of dogs.entries()) {
    const base = Date.parse('2026-11-25T00:00:00.000Z') + i * 3600000
    at.value = new Date(base).toISOString()
    const intentId = `${batch}:${dogId}`
    const intent = runner(dogId, intentId)
    const pending = intent.create()
    const started = intent.start()
    assert.equal(started.trip.id, pending.id)
    // No trusted live weather/place supplied. Exercise the real C7 entry without inventing conditions.
    const selected = intent.selectEvent(null)
    assert.equal(selected, null)
    at.value = new Date(base + 600000).toISOString()
    const done = intent.finish('done').trip
    assert.equal(intent.start().trip.id, done.id, 'same intent retry must reuse trip')
    const snapshot = readDepartureSnapshot(db, done.id, dogId)
    assert.ok(snapshot)
    rows.push({ dogId, intentId, tripId: done.id, seq: done.seq, status: done.status,
      startedAt: done.startedAt, endedAt: done.endedAt, snapshotVersion: snapshot.version,
      events: db.prepare('SELECT * FROM v_trip_event_history WHERE trip_id=? AND dog_id=?').all(done.id, dogId),
      finds: db.prepare('SELECT id,kind,source_mode FROM find WHERE trip_id=?').all(done.id),
      emptyReason: '真实C7入口收到null条件：未提供可信天气/场景，不造事件；种子不运行真实搜索，Find为空。' })
  }
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  // All lifecycle writes have finished; SQLite backup includes committed WAL content.
  await backup(db, destination)
} finally { if (db.isOpen) db.close() }
const read = new DatabaseSync(destination, { readOnly: true })
let schemaVersion
try {
  schemaVersion = Number(read.prepare('PRAGMA user_version').get().user_version)
  assert.equal(schemaVersion, 7)
  assert.equal(read.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(read.prepare('PRAGMA foreign_key_check').all(), [])
  for (const row of rows) assert.equal(read.prepare('SELECT status FROM trip WHERE id=? AND dog_id=?').get(row.tripId, row.dogId).status, 'done')
} finally { read.close() }
const bytes = readFileSync(destination), sha256 = createHash('sha256').update(bytes).digest('hex')
const manifest = { batch, codeSha: actualSha, schemaVersion, database: 'app.sqlite', bytes: bytes.length, sha256,
  environment: '受控演练时钟；独立SQLite；无真实天气/场景/在线搜索；非生产数据',
  writerConnectionsClosed: true, state: 'C_BATCH_COMPLETE_A_RECEPTION_PENDING', dogs: rows }
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
writeFileSync(join(output, 'SHA256.txt'), `${sha256}  app.sqlite\n`)
console.log(JSON.stringify({ batch, codeSha: actualSha, schemaVersion, trips: rows.length, database: destination, sha256,
  next: 'C交备份/manifest/hash给A；A接收核验并标库READY后D只读。不要把本地完成当A已接收。' }, null, 2))
