import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { APPLICATION_ID } from '../lib/db/bootstrap.ts'
import { assertV7DiscoveryCutoverSource, LEGACY_DISCOVERY_CANDIDATES_SQL } from '../lib/db/migrations/008-discovery-receipt.ts'

function preflight(path) {
  const db = new DatabaseSync(resolve(path), { readOnly: true })
  try {
    db.exec('BEGIN')
    if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID) {
      throw new Error('Unexpected SQLite application_id')
    }
    assertV7DiscoveryCutoverSource(db)
    const trips = db.prepare(LEGACY_DISCOVERY_CANDIDATES_SQL + ' ORDER BY trip_id').all()
    return {
      status: trips.length ? 'A_REVIEW_REQUIRED' : 'EMPTY_CAN_PROCEED_TO_UPGRADE_GATE',
      schema_version: 7,
      trip_count: trips.length,
      find_count: trips.reduce((count, row) => count + row.find_count, 0),
      inventory_sha256: createHash('sha256').update(JSON.stringify(trips)).digest('hex'),
      trips,
    }
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
    db.close()
  }
}

try {
  if (process.argv.length !== 4 || process.argv[2] !== '--db' || !process.argv[3].trim()) {
    throw new Error('Usage: node scripts/check-v7-discovery-cutover.mjs --db <stopped v7 database>')
  }
  const result = preflight(process.argv[3])
  console.log(JSON.stringify(result, null, 2))
  if (result.trip_count) process.exitCode = 2
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
