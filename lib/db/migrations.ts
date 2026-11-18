import { EVENT_SCHEMA_V2_SQL } from './migrations/002-events.ts'

/** Infrastructure versions use PRAGMA user_version, without a separate tracking table. */
export interface Migration {
  version: number
  name: string
  sql: string
}

// contracts/schema.sql is the current fresh-database schema. Historical version 1
// predates event/trip_event. Append migrations; never change a deployed migration.
// IF NOT EXISTS also permits the fresh schema to pass through the same version stamps.
export const migrations: readonly Migration[] = [
  { version: 2, name: 'event pool and trip event history', sql: EVENT_SCHEMA_V2_SQL },
]
