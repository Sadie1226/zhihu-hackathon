import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { initializeDatabase } from '../lib/db/bootstrap.ts'
import { databaseHealth } from '../lib/db/health.ts'

test('health reads real schema, returns exact 200 body, no cache and no writes', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    initializeDatabase(db, () => readFileSync('contracts/schema.sql', 'utf8'))
    const before = db.prepare('SELECT total_changes() n').get().n
    const response = databaseHealth(() => db)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.deepEqual(await response.json(), { ok: true, service: 'zhihu-hackathon', database: 'ok' })
    assert.equal(db.prepare('SELECT total_changes() n').get().n, before)
  } finally { db.close() }
})

test('connection failure is 503 and does not disclose internal error details', async () => {
  const response = databaseHealth(() => { throw new Error('private-path-and-test-credential') })
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await response.json(), { ok: false, service: 'zhihu-hackathon', database: 'unavailable' })
})

test('closed database and missing schema are not reported as healthy', () => {
  const db = new DatabaseSync(':memory:')
  assert.equal(databaseHealth(() => db).status, 503)
  db.close()
  assert.equal(databaseHealth(() => db).status, 503)
})
