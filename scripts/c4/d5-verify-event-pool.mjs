import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const poolBlob = '1caa29b51bd42352bf512394936f49deb5cbbfff'
const patchBlob = 'b14b5837b7ecd05094d0e21094a33694da0f8780'
const blob = id => execFileSync('git', ['cat-file', 'blob', id], { encoding: 'utf8' })
const source = (commit, path) => execFileSync('git', ['show', `${commit}:${path}`], { encoding: 'utf8' })
const schema = source('dd5f53ebb214bc5f8ee4959b95bfeac74a055200', 'contracts/schema.sql')
const c7 = 'd548a03b07a299a6a04f41af7c72b5812d2ce6fd'
const { scenes } = JSON.parse(source(c7, 'lib/events/scene-compat.json'))
const policyCode = stripTypeScriptTypes(source(c7, 'lib/events/semantic-policy.ts'))
const { sceneAllowsEvent } = await import('data:text/javascript;base64,' + Buffer.from(policyCode).toString('base64'))
const matches = (pool, usePolicy) => pool.flatMap(row => {
  const places = JSON.parse(row.place_tags)
  return Object.entries(scenes)
    .filter(([file, tags]) => (!places.length || tags.some(tag => places.includes(tag))) &&
      (!usePolicy || sceneAllowsEvent(file, row)))
    .map(([file]) => [row.code, file])
})
const pool = blob(poolBlob)
const patch = blob(patchBlob)
const db = new DatabaseSync(':memory:')
try {
  db.exec(schema)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(pool)
    const snapshot = () => db.prepare('SELECT * FROM event ORDER BY code').all()
    const before = snapshot()
    db.exec(patch)
    assert.equal(db.prepare('SELECT changes() AS n').get().n, 1)
    const after = snapshot()
    assert.equal(after.length, 30)
    const empty = after.filter(row => JSON.parse(row.place_tags).length === 0).map(row => row.code)
    assert.deepEqual(empty, ['any_moon_ring', 'autumn_birds'])
    const edits = after.flatMap((row, i) => {
      const old = before[i]
      assert.deepEqual({ ...row, place_tags: old.place_tags }, { ...old })
      return row.place_tags === old.place_tags ? [] : [row.code]
    })
    assert.deepEqual(edits, ['spring_first_green', 'summer_cicada'])
    assert.deepEqual(JSON.parse(after.find(row => row.code === 'spring_first_green').place_tags), ['street', 'stall'])
    assert.deepEqual(JSON.parse(after.find(row => row.code === 'summer_cicada').place_tags), ['street'])
    const semanticBefore = matches(before, true)
    const semanticAfter = matches(after, true)
    assert.equal(semanticBefore.length, 54)
    assert.deepEqual(semanticAfter, semanticBefore)
    db.exec(patch)
    assert.equal(db.prepare('SELECT changes() AS n').get().n, 0)
    assert.deepEqual(snapshot(), after)
    db.exec(pool)
    db.exec(patch)
    assert.deepEqual(snapshot(), after)
    db.exec('COMMIT')
    console.log(JSON.stringify({ events: after.length, changed: edits, emptyPlaces: empty, reimportDrift: false,
      coarsePairs: [matches(before, false).length, matches(after, false).length],
      semanticPairs: [semanticBefore.length, semanticAfter.length] }))
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
} finally {
  db.close()
}
