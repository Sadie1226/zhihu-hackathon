import { EVENT_SCHEMA_V2_SQL } from './migrations/002-events.ts'
import type { DatabaseSync } from 'node:sqlite'
import { wishMigrationSql } from './migrations/003-wishes.ts'
import { snapshotInterestNullMigration } from './migrations/004-snapshot-interest-null.ts'
import { ownerSessionMigration } from './migrations/005-owner-session.ts'

/** Infrastructure versions use PRAGMA user_version, without a separate tracking table. */
export interface Migration {
  version: number
  name: string
  sql: string | ((db: DatabaseSync) => string)
}

// contracts/schema.sql is the current fresh-database schema. Historical version 1
// predates event/trip_event. Append migrations; never change a deployed migration.
// IF NOT EXISTS (v2) and column inspection (v3) permit the fresh schema to pass
// through the same version stamps without replaying ALTER TABLE.
export const migrations: readonly Migration[] = [
  { version: 2, name: 'event pool and trip event history', sql: EVENT_SCHEMA_V2_SQL },
  { version: 3, name: 'active wishes and collection provenance', sql: wishMigrationSql },
  { version: 4, name: 'nullable snapshot interests', sql: snapshotInterestNullMigration },
  { version: 5, name: 'stable owners and revocable sessions', sql: ownerSessionMigration },
]
