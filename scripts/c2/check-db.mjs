import { openDatabase } from '../../lib/db/bootstrap.ts'

const db = openDatabase()
try {
  console.log(JSON.stringify({
    foreignKeys: db.prepare('PRAGMA foreign_keys').get().foreign_keys,
    journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
    tables: db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table'").get().n,
  }))
} finally { db.close() }
