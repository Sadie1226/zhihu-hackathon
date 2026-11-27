import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { initializeDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { recordAdoption } from '../lib/auth/adoption.ts'
import { createDevelopmentDog, generateDevelopment, mockProfile } from '../lib/adoption/development.ts'

test('v5 committed creation with lost response replays original receipt after v6 without rewriting assembly', () => {
  const root = resolve('.local/e5-legacy-receipt'); mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'case-')), db = new DatabaseSync(join(dir, 'test.sqlite'))
  try {
    const schema = () => readFileSync('tests/fixtures/schema-v1.sql', 'utf8')
    initializeDatabase(db, schema, migrations.slice(0, 4))
    db.prepare("INSERT INTO owner VALUES('old-owner','zhihu','zhihu','old-user','2026-11-22')").run()
    const draft = { name: '小旧', interestCategories: null, tendencies: [-2, 0, 0, 0, 1, 0] }
    const assembly = { cloth: 'hoodie', hat: 'cap', glasses: 'round', face: 'happy' }
    const id = '01234567-0123-4123-8123-012345678901'
    const hash = createHash('sha256').update(JSON.stringify([draft, assembly, mockProfile.version])).digest('hex')
    const dogId = recordAdoption(db, 'old-owner', { id, hash }, (dog, at) => {
      db.prepare('INSERT INTO dog(id,name,session_id,owner_id,personality_tags,assembly,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(dog, draft.name, 'old-owner', 'old-owner', JSON.stringify(generateDevelopment(draft).tags), JSON.stringify(assembly), at)
    })
    initializeDatabase(db, schema, migrations)
    const saved = createDevelopmentDog(db, 'old-owner', { ...draft, assembly,
      requestId: id, fingerprint: generateDevelopment(draft).fingerprint })
    assert.equal(saved.id, dogId)
    assert.deepEqual(saved.assembly, assembly)
    assert.equal(db.prepare('SELECT count(*) n FROM dog').get().n, 1)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
