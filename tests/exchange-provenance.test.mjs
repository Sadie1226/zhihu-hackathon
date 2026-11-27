import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { checkExchangeProvenance } from '../contracts/types.ts'

const fixture = name => JSON.parse(readFileSync(`contracts/fixtures/${name}.json`,'utf8'))
function setup(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(readFileSync('contracts/schema.sql','utf8'))
  t.after(() => db.close())
  for (const [table,key] of [['dog','dogs'],['trip','trips'],['find','finds']]) {
    for (const row of fixture(table === 'dog' ? 'dog-v6' : table)[key]) {
      const keys = Object.keys(row)
      db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
        .run(...Object.values(row).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : v))
    }
  }
  // All new material is explicitly synthetic fixture data, never labeled live.
  db.prepare(`INSERT INTO find(id,trip_id,kind,title,source_url,source_mode,created_at)
    VALUES('k4-zhihu-fixture','trip_seed_01','zhihu','K4 fixture','https://www.zhihu.com/question/123/answer/456','fixture','2026-11-19T00:00:00Z')`).run()
  function context(fromDog, id, extra = {}) {
    const row = id === null ? null : db.prepare(`SELECT f.id,t.dog_id AS dogId,f.source_mode AS sourceMode
      FROM find f JOIN trip t ON t.id=f.trip_id WHERE f.id=?`).get(id)
    return { fromDog, source: row ?? null, trusted: true, ...extra }
  }
  return { db, context }
}
const payload = kind => kind === 'find'
  ? { kind, findTitle:'fixture', findExcerpt:null, sourceUrl:null }
  : { kind, giftName:'fixture', note:null, imagePath:null }

test('historical four-kind payloads stay readable without added keys; no live defaults', t => {
  const { context } = setup(t)
  for (const row of fixture('exchange').exchanges) {
    const before = JSON.stringify(row.payload)
    assert.deepEqual(checkExchangeProvenance(row.payload,context(row.from_dog,null,{historical:true,trusted:false})),{ok:true})
    assert.equal(JSON.stringify(row.payload),before)
    assert.ok(!Object.hasOwn(row.payload,'sourceMode'))
  }
})

for (const kind of ['find','gift']) {
  test(`new ${kind} provenance resolves a real sender-owned fixture Find and round trips JSON`, t => {
    const { db, context } = setup(t)
    const p = { ...payload(kind), sourceFindId:'k4-zhihu-fixture', sourceMode:'fixture' }
    assert.deepEqual(checkExchangeProvenance(p,context('dog_seed_07',p.sourceFindId)),{ok:true})
    db.prepare(`INSERT INTO exchange(id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at)
      VALUES(?,'dog_seed_07','dog_owner',?,?,2,'2026-11-19T00:00:00Z')`).run(kind,kind,JSON.stringify(p))
    assert.deepEqual(JSON.parse(db.prepare('SELECT payload FROM exchange WHERE id=?').get(kind).payload),p)
  })
  test(`new ${kind} rejects invalid modes, missing/foreign IDs, self-declared live and partial keys`, t => {
    const { context } = setup(t)
    const base = { ...payload(kind), sourceFindId:'k4-zhihu-fixture', sourceMode:'fixture' }
    const cases = [
      [base,context('dog_owner',base.sourceFindId)],
      [{...base,sourceFindId:'missing'},context('dog_seed_07','missing')],
      [{...base,sourceFindId:'event-fixture'},context('dog_seed_07','event-fixture')],
      [{...base,sourceFindId:12},context('dog_seed_07',base.sourceFindId)],
      [{...base,sourceFindId:''},context('dog_seed_07',base.sourceFindId)],
      [{...base,sourceMode:'invalid'},context('dog_seed_07',base.sourceFindId)],
      [{...base,sourceMode:'live'},context('dog_seed_07',base.sourceFindId)],
      [{...base,sourceMode:'cache'},context('dog_seed_07',base.sourceFindId)],
      [{...base,sourceMode:'live'},context('dog_seed_07',base.sourceFindId,{trusted:false})],
      [base,context('dog_seed_07',base.sourceFindId,{trusted:false})],
      [payload(kind),context('dog_seed_07',null)],
      [{...payload(kind),sourceFindId:null},context('dog_seed_07',null)],
      [{...payload(kind),sourceMode:null},context('dog_seed_07',null)],
      [{...payload(kind),sourceFindId:null,sourceMode:'live'},context('dog_seed_07',null)],
    ]
    for (const [p,ctx] of cases) assert.equal(checkExchangeProvenance(p,ctx).ok,false)
  })
}

test('scene/moment reference preserves null; no-source payload explicitly supplies null/null', t => {
  const { context } = setup(t)
  for (const [id,dog] of [['find_s1','dog_owner'],['find_seed1','dog_seed_07']]) {
    for (const kind of ['find','gift']) {
      const p = {...payload(kind),sourceFindId:id,sourceMode:null}
      assert.deepEqual(checkExchangeProvenance(p,context(dog,id)),{ok:true})
      assert.equal(checkExchangeProvenance({...p,sourceMode:'fixture'},context(dog,id)).ok,false)
    }
  }
  assert.deepEqual(checkExchangeProvenance({...payload('gift'),sourceFindId:null,sourceMode:null},context('dog_owner',null)),{ok:true})
})

test('greeting/co_owner_message reject provenance; new fixture references exist and belong to sender', t => {
  const { db, context } = setup(t)
  for (const row of fixture('exchange').exchanges.filter(row => ['greeting','co_owner_message'].includes(row.kind))) {
    assert.deepEqual(checkExchangeProvenance(row.payload,context(row.from_dog,null)),{ok:true})
    assert.equal(checkExchangeProvenance({...row.payload,sourceFindId:null,sourceMode:null},context(row.from_dog,null)).ok,false)
  }
  for (const row of fixture('exchange').provenanceCases) {
    assert.deepEqual(checkExchangeProvenance(row.payload,context(row.from_dog,row.payload.sourceFindId)),{ok:true})
    assert.notEqual(row.payload.sourceMode,'live')
    db.prepare(`INSERT INTO exchange(id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at,delivered_at,replied_at,read_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(row.id,row.from_dog,row.to_dog,row.kind,JSON.stringify(row.payload),
        row.deliver_after_trip_seq,row.created_at,row.delivered_at,row.replied_at,row.read_at)
    const stored = db.prepare('SELECT * FROM exchange WHERE id=?').get(row.id)
    assert.deepEqual({...stored,payload:JSON.parse(stored.payload)},row)
  }
})

test('legacy database JSON column is not a provenance/ownership validator; contract helper is a separate boundary', t => {
  const { db, context } = setup(t)
  const bad = {...payload('find'),sourceFindId:'missing',sourceMode:'live'}
  assert.equal(checkExchangeProvenance(bad,context('dog_seed_07','missing')).ok,false)
  // Explicitly document the gap: no new exchange columns/triggers and no D4 write integration.
  db.prepare(`INSERT INTO exchange(id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at)
    VALUES('unvalidated','dog_seed_07','dog_owner','find',?,2,'2026-11-19T00:00:00Z')`).run(JSON.stringify(bad))
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM exchange WHERE id='unvalidated'").get().payload).sourceFindId,'missing')
})
