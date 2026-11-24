import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { initializeDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'

/** Diagnostic fixtures only: import original legacy seeds at v5, then preserve them through K6. */
export function initializeDiagnosticSeeds(db) {
  const root = new URL('../', import.meta.url)
  initializeDatabase(db, () => readFileSync(new URL('tests/fixtures/schema-v1.sql', root), 'utf8'),
    migrations.filter(m => m.version <= 5))
  db.exec(readFileSync(new URL('team/2026-11-17/d/1117-d2b-种子狗装配单-v1.sql', root), 'utf8'))
  initializeDatabase(db, () => readFileSync(fileURLToPath(new URL('contracts/schema.sql', root)), 'utf8'))
}
