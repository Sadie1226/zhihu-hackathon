import { openDatabase } from './bootstrap.ts'
import { migrations } from './migrations.ts'
export const d5InterfaceMigrations = migrations

/** Dedicated local validation path only; never opens the default application database implicitly. */
export function openD5InterfaceDatabase(path: string) {
  if (typeof path !== 'string' || !path.trim() || path === ':memory:') {
    throw new Error('D5 interface database requires an explicit persistent validation path')
  }
  return openDatabase(path, d5InterfaceMigrations)
}
