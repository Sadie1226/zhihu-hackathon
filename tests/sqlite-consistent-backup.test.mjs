import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { APPLICATION_ID } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { createTripService } from '../lib/trips/service.ts'
import { createTripDiscoverySearch } from '../lib/trips/discover.ts'
import { createTripDiscoveryComposer } from '../lib/trips/composer.ts'
import { ownerDiscoveryIntent, readDiscoveryReceipt } from '../lib/trips/discovery-receipt.ts'
import { createMemorySearchCache } from '../lib/trips/search-cache.ts'
import { mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'

const oldSha = 'a6ad71d43edb4adbf34c791d73fe303472c52cff'
const combinedSha = 'cdff70309942c2c6c9e4aa254ee1dc2bfaa9bfad'
const command = (source, directory, stopped = true, appSha = oldSha) => spawnSync(process.execPath, [
  'scripts/backup-sqlite-consistent.mjs', '--source', source, '--snapshot', join(directory, 'backup.sqlite'),
  '--out-dir', directory, '--app-sha', appSha, ...(stopped ? ['--writes-stopped'] : []),
], { encoding: 'utf8', windowsHide: true })
const tables = db => [
  db.prepare('SELECT * FROM trip_discovery_receipt ORDER BY trip_id').all(),
  db.prepare('SELECT * FROM find ORDER BY id').all(),
]

test('VACUUM INTO includes committed WAL contents and preserves a readable app/database pair', async t => {
  const v8 = migrations.filter(migration => migration.version <= 8)
  const { db, path } = mailboxDatabase(t, v8, readFileSync('tests/fixtures/schema-v1.sql', 'utf8'))
  db.exec('PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE)')
  let at = '2026-11-25T02:00:00.000Z'
  const now = () => new Date(at)
  const lifecycle = createTripService(db, { now })
  const cache = createMemorySearchCache()
  const provider = async () => ({ ok: true, httpStatus: 200, fetchedAt: at, items: [{
    sourceMode: 'live', sourceUrl: 'https://www.zhihu.com/question/921', title: '离线受控来源',
    excerpt: null, authorityLevel: null, voteUpCount: null,
  }] })
  const confirm = async (trip, request, searchProvider) => {
    const result = await createTripDiscoverySearch(db, searchProvider, { cache, now })(trip.id, request)
    assert.equal(result.ok, true)
    const observations = ['one', 'two'].map(id => ({
      id, tripId: trip.id, dogId: trip.dogId, kind: 'scene',
      happenedAt: at, title: '离线场景 ' + id, topics: [], excerpt: null,
    }))
    const composition = createTripDiscoveryComposer(db, { now })(trip.id, request, { searchProofs: result.proofs, observations })
    assert.equal(composition.status, 'complete')
    return composition.finds
  }
  const owner = ownedDog(db, 'backup-owner')
  const request = new Request('https://local.test/finds', { headers: { cookie: owner.cookie } })
  const newTrip = () => lifecycle.start(lifecycle.create(owner.id, owner.sessionId, 'auto').id, owner.sessionId).trip
  const first = newTrip()
  const initialFinds = await confirm(first, request, provider)
  const frozenRows = tables(db)
  // Reproduce the original v8 schema, which did not yet define the cutover table.
  const holdTable = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'trip_discovery_legacy_hold'").get().sql
  db.exec('DROP TABLE trip_discovery_legacy_hold')
  const output = join(dirname(path), 'stop-point')
  const result = command(path, output)
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(result.stdout)
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')), manifest)
  assert.equal(manifest.app_sha, oldSha)
  assert.equal(manifest.user_version, 8)
  assert.equal(manifest.application_id, APPLICATION_ID)
  assert.equal(manifest.legacy_hold_capability, false)
  assert.equal(manifest.manifest_version, 1)
  assert.match(manifest.schema_hash, /^[0-9a-f]{64}$/)
  assert.ok(manifest.source_wal_bytes > 0)
  assert.deepEqual(manifest.receipt_capabilities, { table_present: true, receipt_count: 1,
    observed_member_types: ['observation', 'search'], live_members_present: true, cache_members_present: false })
  const backup = join(output, manifest.backup_path)
  assert.equal(manifest.backup_sha256, createHash('sha256').update(readFileSync(backup)).digest('hex'))
  assert.equal(command(path, output).status, 1)

  db.exec(holdTable)
  lifecycle.finish(first.id, owner.sessionId, 'done')
  at = '2026-11-25T09:00:00.000Z'
  const second = newTrip()
  const latest = await confirm(second, request, async () => ({ ok: false, httpStatus: 429,
    error: { code: 'RATE_LIMITED', detail: '', retriable: false }, fallback: 'cache-or-fixture', alert: false }))
  assert.equal(latest[0].sourceMode, 'cache')
  const after = command(path, join(dirname(path), 'after-cache'), true, combinedSha)
  assert.equal(after.status, 0, after.stderr)
  assert.equal(JSON.parse(after.stdout).receipt_capabilities.cache_members_present, true)

  const never = async () => assert.fail('a completed receipt must be read without provider access')
  const restored = new DatabaseSync(backup, { readOnly: true })
  try {
    assert.deepEqual(tables(restored), frozenRows)
    assert.equal(restored.prepare('SELECT 1 FROM trip WHERE id=?').get(second.id), undefined)
    assert.equal(restored.prepare('SELECT status FROM trip WHERE id=?').get(first.id).status, 'running')
    const replay = readDiscoveryReceipt(restored, { tripId: first.id, dogId: owner.id,
      ownerId: owner.sessionId, intentId: ownerDiscoveryIntent(first.id) })
    assert.deepEqual(replay.members.map(([id]) => id), initialFinds.map(row => row.id))

    // The release rehearsal supplies an exact checkout of the original v8 application.
    if (process.env.TRAVEL_OLD_READER_ROOT) {
      const root = resolve(process.env.TRAVEL_OLD_READER_ROOT)
      const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true })
      assert.equal(head.status, 0, head.stderr)
      assert.equal(head.stdout.trim(), oldSha)
      t.diagnostic(JSON.stringify(manifest))
      const { createTripDiscoverySearch: oldSearch } = await import(pathToFileURL(join(root, 'lib/trips/discover.ts')).href)
      const incompatible = new DatabaseSync(path, { readOnly: true })
      try {
        await assert.rejects(oldSearch(incompatible, never, { now })(second.id, request), { code: 'DISCOVERY_RECEIPT_INVALID' })
        const restoredByOld = await oldSearch(restored, never, { now })(first.id, request)
        assert.deepEqual(restoredByOld.replay.finds, initialFinds)
        t.diagnostic('Exact a6ad71d reader rejected cache members and replayed the paired live snapshot')
      } finally { incompatible.close() }
    }
  } finally { restored.close() }
})

test('backup requires a declared stop point and refuses an active writer', t => {
  const { db, path } = mailboxDatabase(t)
  const output = join(dirname(path), 'must-not-exist')
  assert.equal(command(path, output, false).status, 1)
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = command(path, output)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /database is locked/)
    assert.equal(existsSync(output), false)
  } finally { db.exec('ROLLBACK') }
})
