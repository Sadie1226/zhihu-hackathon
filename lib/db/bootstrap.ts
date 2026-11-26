import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { migrations as defaultMigrations } from './migrations.ts'
import type { Migration } from './migrations.ts'

export const APPLICATION_ID = 0x5a484831
export const BUSY_TIMEOUT_MS = 5000
const journalRetryWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

function enableWal(db: DatabaseSync): void {
  const deadline = performance.now() + BUSY_TIMEOUT_MS
  try {
    for (;;) {
      const remaining = Math.max(0, Math.floor(deadline - performance.now()))
      db.exec(`PRAGMA busy_timeout = ${remaining}`)
      try {
        db.prepare('PRAGMA journal_mode = WAL').get()
        return
      } catch (error) {
        // Rollback-mode readers can contend with the exclusive WAL transition.
        // SQLite can fail that lock promotion without invoking the busy handler.
        if (!(error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' &&
          (error.errcode & 0xff) === 5) || performance.now() >= deadline) throw error
        Atomics.wait(journalRetryWait, 0, 0, Math.min(10, remaining))
      }
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  }
}

export function databasePath(): string {
  const configured = process.env.DATABASE_PATH ?? './data/app.sqlite'
  if (!configured.trim() || configured === ':memory:') {
    throw new Error('DATABASE_PATH must name a persistent database file')
  }
  // Runtime data is external state, not an asset to copy into the server bundle.
  return resolve(/* turbopackIgnore: true */ configured)
}

/** Only trusted, reviewed SQL is passed here; migrations never come from HTTP. */
export function initializeDatabase(
  db: DatabaseSync,
  schema: () => string,
  migrations: readonly Migration[] = defaultMigrations,
): void {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 2 || !migration.name ||
        (typeof migration.sql !== 'function' && !migration.sql.trim())) {
      throw new Error('Migrations must be consecutive versions starting at 2')
    }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    let version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
    const application = Number(db.prepare('PRAGMA application_id').get()?.application_id)
    if (version === 0) {
      const objects = db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()
      if (objects?.n !== 0 || application !== 0) {
        throw new Error('Unversioned existing database: explicit adoption is required')
      }
      // Empty SQLite database only. The schema and version stamp commit together.
      db.exec(schema())
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1`)
      version = 1
    } else if (application !== APPLICATION_ID) {
      throw new Error('Database belongs to a different application')
    }
    if (version > migrations.length + 1) {
      throw new Error('Database version is newer than this application')
    }
    for (const migration of migrations) {
      if (migration.version <= version) continue
      // Resolve additive column DDL under the same write lock. Fresh schemas may
      // already contain these columns; historical databases still need ALTER.
      db.exec(typeof migration.sql === 'function' ? migration.sql(db) : migration.sql)
      db.exec(`PRAGMA user_version = ${migration.version}`)
      version = migration.version
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Opens a persistent connection without deleting, replacing, or seeding data. */
export function openDatabase(
  path = databasePath(),
  migrations: readonly Migration[] = defaultMigrations,
): DatabaseSync {
  if (!path.trim() || path === ':memory:') throw new Error('A persistent database file is required')
  const absolutePath = resolve(/* turbopackIgnore: true */ path)
  mkdirSync(dirname(absolutePath), { recursive: true })
  const db = new DatabaseSync(absolutePath, { timeout: BUSY_TIMEOUT_MS })
  try {
    db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    initializeDatabase(db, () => readFileSync(resolve('contracts/schema.sql'), 'utf8'), migrations)
    // Keep application/DDL validation before changing the file's journal mode.
    // SQLite's returned mode remains authoritative when WAL is unavailable.
    enableWal(db)
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) {
      throw new Error('Foreign key enforcement is unavailable')
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
