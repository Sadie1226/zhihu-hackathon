/** Infrastructure versions use PRAGMA user_version, without adding business tables. */
export interface Migration {
  version: number
  name: string
  sql: string
}

// Version 1 is contracts/schema.sql. After approval, append ordered additive
// migrations (version 2 onward); never edit a migration already deployed.
// New indexes also present in a newer schema must use CREATE INDEX IF NOT EXISTS.
export const migrations: readonly Migration[] = []
