import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { APPLICATION_ID } from '../lib/db/bootstrap.ts'
import { readDiscoveryReceipt } from '../lib/trips/discovery-receipt.ts'

const manifestName = 'manifest.json'
const sha256 = input => createHash('sha256').update(input).digest('hex')

function applicationId(db) {
  const id = db.prepare('PRAGMA application_id').get().application_id
  if (id !== APPLICATION_ID) throw new Error('Unexpected SQLite application_id')
  return id
}

function walBytes(source) {
  try { return statSync(source + '-wal').size }
  catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
}

function inspectSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const application_id = applicationId(db)
    const user_version = db.prepare('PRAGMA user_version').get().user_version
    const integrity = db.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('Snapshot failed SQLite integrity or foreign key checks')
    }
    const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all()
    const hasTable = name => schema.some(row => row.type === 'table' && row.name === name)
    const receiptTable = hasTable('trip_discovery_receipt')
    const memberTypes = new Set()
    let receiptCount = 0
    if (receiptTable) {
      const scopes = db.prepare(`SELECT trip_id AS tripId, dog_id AS dogId, owner_id AS ownerId,
        intent_id AS intentId FROM trip_discovery_receipt`)
      for (const scope of scopes.iterate()) {
        const receipt = readDiscoveryReceipt(db, scope)
        for (const [, , filter] of receipt.members) memberTypes.add(filter[0])
        receiptCount++
      }
    }
    return {
      user_version,
      application_id,
      schema_hash: sha256(JSON.stringify(schema.map(row => ({ ...row, sql: row.sql?.replace(/\r\n?/g, '\n') ?? null })))),
      receipt_capabilities: {
        table_present: receiptTable,
        receipt_count: receiptCount,
        observed_member_types: [...memberTypes].sort(),
        live_members_present: memberTypes.has('search'),
        cache_members_present: memberTypes.has('cache'),
      },
      legacy_hold_capability: hasTable('trip_discovery_legacy_hold'),
    }
  } finally { db.close() }
}

async function backup({ source, snapshot, 'out-dir': output, 'app-sha': appSha, 'writes-stopped': stopped }) {
  if (!stopped || !source?.trim() || !snapshot?.trim() || !output?.trim() || !/^[0-9a-f]{40}$/.test(appSha ?? '')) {
    throw new Error('Usage: node scripts/backup-sqlite-consistent.mjs --source <db> --snapshot <new snapshot path> --out-dir <new directory> --app-sha <40-character SHA> --writes-stopped')
  }
  source = realpathSync(source)
  output = resolve(output)
  snapshot = resolve(snapshot)
  if (!statSync(source).isFile() || dirname(snapshot) !== output ||
      basename(snapshot).toLowerCase() === manifestName) {
    throw new Error('Snapshot must be a file in the new output directory')
  }

  const writerLock = new DatabaseSync(source, { timeout: 0 })
  let source_wal_bytes
  try {
    applicationId(writerLock)
    // Detect an outstanding writer and exclude new writes while SQLite reads its snapshot.
    // Operators must stop all instances and drain all transaction types before invoking this tool.
    writerLock.exec('BEGIN IMMEDIATE')
    source_wal_bytes = walBytes(source)
    mkdirSync(output)
    const reader = new DatabaseSync(source, { readOnly: true, timeout: 0 })
    try { reader.prepare('VACUUM INTO ?').run(snapshot) }
    finally { reader.close() }
  } finally {
    if (writerLock.isTransaction) writerLock.exec('ROLLBACK')
    writerLock.close()
  }

  const metadata = inspectSnapshot(snapshot)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(snapshot)) hash.update(chunk)
  const manifest = {
    manifest_version: 1,
    app_sha: appSha,
    ...metadata,
    backup_sha256: hash.digest('hex'),
    backup_created_at: new Date().toISOString(),
    backup_path: basename(snapshot),
    source_wal_bytes,
  }
  writeFileSync(join(output, manifestName), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  return manifest
}

try {
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, snapshot: { type: 'string' }, 'out-dir': { type: 'string' },
    'app-sha': { type: 'string' }, 'writes-stopped': { type: 'boolean' },
  } })
  console.log(JSON.stringify(await backup(values), null, 2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
