import { openDatabase } from './bootstrap.ts'
import { migrations } from './migrations.ts'
import type { Migration } from './migrations.ts'
import { TRIP_HISTORY_V7_SQL } from './migrations/007-trip-history.ts'

/** Explicit joint-interface registry. The default HTTP runtime stays v6 until C wires start. */
export const d5InterfaceMigrations: readonly Migration[] = [
  ...migrations,
  { version: 7, name: 'immutable occurrence facts and departure snapshot binding', sql: TRIP_HISTORY_V7_SQL },
]

/** Dedicated local validation path only; never opens the default application database implicitly. */
export function openD5InterfaceDatabase(path: string) {
  if (typeof path !== 'string' || !path.trim() || path === ':memory:') {
    throw new Error('D5 interface database requires an explicit persistent validation path')
  }
  return openDatabase(path, d5InterfaceMigrations)
}
