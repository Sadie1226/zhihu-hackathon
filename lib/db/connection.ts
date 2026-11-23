import type { DatabaseSync } from 'node:sqlite'
import { databasePath, openDatabase } from './bootstrap.ts'

const state = globalThis as typeof globalThis & {
  zhihuDatabase?: { path: string; connection: DatabaseSync }
}

/** One successful connection per server process, including development reloads. */
export function getDatabase(): DatabaseSync {
  const path = databasePath()
  if (state.zhihuDatabase && state.zhihuDatabase.path !== path) {
    throw new Error('Restart the server after changing DATABASE_PATH')
  }
  if (!state.zhihuDatabase) {
    state.zhihuDatabase = { path, connection: openDatabase(path) }
  }
  return state.zhihuDatabase.connection
}
