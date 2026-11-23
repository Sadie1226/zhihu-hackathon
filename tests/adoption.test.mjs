import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  developmentEnabled,
  parseDraft,
  generateDevelopment,
  createDevelopmentDog,
  ownedDog,
  renameDevelopmentDog,
} from '../lib/adoption/development.ts'
import { handleAdoptionRequest } from '../lib/adoption/http.ts'
import { currentTrip } from '../lib/adoption/view.ts'
import { checkPersonalityTags } from '../contracts/types.ts'

import { openDatabase } from '../lib/db/bootstrap.ts'

const draft = {
  name: '小山',
  interestCategories: null,
  tendencies: [-2, 0, 0, 0, 1, 0],
}
const assembly = { outfit: null, cloth: 'S02-leaf-cape', accessory: null, face: 'F01-neutral' }

function payload() {
  return {
    ...draft,
    assembly,
    fingerprint: generateDevelopment(draft).fingerprint,
    requestId: '01234567-0123-4123-8123-012345678901',
  }
}
function insertOwner(db, id) {
  db.prepare("INSERT INTO owner VALUES (?, 'development', 'development', ?, '2026-11-22')").run(id, id)
}
function database(t) {
  const root = resolve('.local/a5-tests')
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'session-'))
  const db = openDatabase(join(dir, 'a5-development-test.sqlite'))
  for (const id of ['owner-a', 'owner-b']) insertOwner(db, id)
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  return db
}

test('strict v6 rejects legacy adoption for a new owner and preserves existing legacy dog reads', t => {
  const db = database(t)
  const dog = createDevelopmentDog(db, 'owner-a', payload())
  const upgraded = openDatabase(db.location())
  try {
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 6)
    assert.deepEqual(ownedDog(upgraded, 'owner-a'), dog)
    assert.deepEqual(createDevelopmentDog(upgraded, 'owner-a', payload()), dog)
    assert.throws(() => createDevelopmentDog(upgraded, 'owner-b', { ...payload(), assembly: { cloth: 'hoodie', hat: null, glasses: null, face: 'happy' } }), /新版/)
    assert.equal(upgraded.prepare('SELECT count(*) n FROM dog').get().n, 1)
    assert.equal(upgraded.prepare('SELECT count(*) n FROM adoption_receipt').get().n, 1)
  } finally { upgraded.close() }
})

test('development gate requires isolated filename and refuses production', () => {
  const env = {
    NODE_ENV: 'development',
    APP_IDENTITY_PROVIDER: 'development',
    DATABASE_PATH: './data/a5-development.sqlite',
  }
  assert.equal(developmentEnabled(env), true)
  for (const patch of [
    { NODE_ENV: 'production' },
    { APP_IDENTITY_PROVIDER: '' },
    { DATABASE_PATH: './data/app.sqlite' },
    { DATABASE_PATH: ':memory:' },
  ])
    assert.equal(developmentEnabled({ ...env, ...patch }), false)
})
test('draft rejects invalid names, duplicate interests, extra tendencies; server chooses valid tags', () => {
  for (const patch of [
    { name: '' },
    { name: '一二三四五六七' },
    { name: 'a\n' },
    { interestCategories: ['冷知识'] },
    { interestCategories: ['冷知识', '冷知识'] },
    { tendencies: [1] },
    { tendencies: [1, 1, 1, 1, 1, 3] },
  ]) {
    if (patch.name === 'a\n') patch.name = 'a\nb'
    assert.throws(() => parseDraft({ ...draft, ...patch }))
  }
  assert.equal(
    checkPersonalityTags(generateDevelopment(parseDraft(draft)).tags).ok,
    true,
  )
  assert.notEqual(
    generateDevelopment(draft).fingerprint,
    generateDevelopment({ ...draft, name: '另一只' }).fingerprint,
  )
})
test('creation is durable/idempotent; conflict cannot create another dog or spoof owner/tags', (t) => {
  const db = database(t),
    input = payload()
  const dog = createDevelopmentDog(db, 'owner-a', input)
  assert.deepEqual(createDevelopmentDog(db, 'owner-a', input), dog)
  assert.throws(
    () =>
      createDevelopmentDog(db, 'owner-a', {
        ...input,
        assembly: { ...assembly, accessory: 'P13-blue-cap' },
      }),
    /内容已改变/,
  )
  assert.throws(
    () =>
      createDevelopmentDog(db, 'owner-a', {
        ...input,
        requestId: '11234567-0123-4123-8123-012345678901',
      }),
    /已经领养/,
  )
  assert.throws(
    () =>
      createDevelopmentDog(db, 'owner-b', { ...input, sessionId: 'owner-a' }),
    /未定义字段/,
  )
  assert.throws(
    () =>
      createDevelopmentDog(db, 'owner-b', {
        ...input,
        fingerprint: 'tampered',
      }),
    /重新整理/,
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM dog').get().n, 1)
  assert.equal(ownedDog(db, 'owner-b', dog.id), null)
  assert.equal('sessionId' in dog, false)
  assert.notEqual(createDevelopmentDog(db, 'owner-b', input).id, dog.id)
})

test('v25 slider preserves all 21 positions; invalid increments cannot reach generation', () => {
  const fingerprints = new Set()
  for (let position = 0; position <= 100; position += 5) {
    const value = (position - 50) / 25
    const parsed = parseDraft({...draft,tendencies:[value,0,0,0,0,0]})
    assert.equal(parsed.tendencies[0],value)
    fingerprints.add(generateDevelopment(parsed).fingerprint)
  }
  assert.equal(fingerprints.size,21)
  for (const value of [NaN,Infinity,-Infinity,0.1,0.3,-2.2,2.2])
    assert.throws(()=>parseDraft({...draft,tendencies:[value,0,0,0,0,0]}))
})
test('rename only updates name and refuses another owner', (t) => {
  const db = database(t),
    dog = createDevelopmentDog(db, 'owner-a', payload())
  db.prepare('UPDATE dog SET blocked_topics=? WHERE id=?').run(
    '["保留"]',
    dog.id,
  )
  const before = db.prepare('SELECT * FROM dog WHERE id=?').get(dog.id)
  assert.throws(() => renameDevelopmentDog(db, 'owner-b', dog.id, '改名'))
  renameDevelopmentDog(db, 'owner-a', dog.id, '小禾')
  assert.deepEqual(
    { ...db.prepare('SELECT * FROM dog WHERE id=?').get(dog.id) },
    { ...before, name: '小禾' },
  )
})
test('two independent server processes racing the same receipt create exactly one dog', async (t) => {
  const root = resolve('.local/a5-tests')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'parallel-')),
    file = join(directory, 'test.sqlite')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const db = openDatabase(file)
  insertOwner(db, 'parallel-owner')
  const worker = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['tests/helpers/adoption-worker.mjs', file, JSON.stringify(payload())],
        { windowsHide: true },
      )
      let output = ''
      let errors = ''
      child.stdout.on('data', (b) => (output += b))
      child.stderr.on('data', (b) => (errors += b))
      child.on('error', reject)
      child.on('close', (code) =>
        code ? reject(Error(errors)) : resolve(JSON.parse(output)),
      )
    })
  try {
    const results = await Promise.all([worker(), worker()])
    assert.equal(results[0].ok, true)
    assert.deepEqual(results[0], results[1])
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dog').get().n, 1)
  } finally {
    db.close()
  }
})
test('HTTP login/session, whitelist, same-origin, bad input and disabled provider', async (t) => {
  const db = database(t)
  const saved = { ...process.env }
  t.after(() => {
    for (const key of ['NODE_ENV', 'APP_IDENTITY_PROVIDER', 'DATABASE_PATH']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
  Object.assign(process.env, {
    NODE_ENV: 'development',
    APP_IDENTITY_PROVIDER: 'development',
    DATABASE_PATH: db.location(),
  })
  const request = (body, cookie = '', origin = 'http://localhost:3000') =>
    new Request('http://localhost:3000/api/dogs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, origin },
      body: JSON.stringify(body),
    })
  const login = await handleAdoptionRequest(request({}), 'login', () => db)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const created = await handleAdoptionRequest(
    request(payload(), cookie),
    'create',
    () => db,
  )
  assert.equal(created.status, 200)
  assert.equal(created.headers.get('cache-control'), 'no-store')
  const dog = (await created.json()).dog
  assert.equal('sessionId' in dog, false)
  const session = await handleAdoptionRequest(
    new Request('http://localhost:3000/api/session', { headers: { cookie } }),
    'session',
    () => db,
  )
  const sessionView = await session.json()
  assert.equal(sessionView.dog.id, dog.id)
  assert.match(sessionView.draftScope,/^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(sessionView).includes(cookie.split('=')[1]),false)
  const repeat = await handleAdoptionRequest(
    new Request('http://localhost:3000/api/session',{headers:{cookie}}),'session',()=>db,
  )
  assert.equal((await repeat.json()).draftScope,sessionView.draftScope)
  const secondLogin = await handleAdoptionRequest(request({}), 'login', () => db)
  const secondCookie=secondLogin.headers.get('set-cookie').split(';')[0]
  const otherSession=await handleAdoptionRequest(
    new Request('http://localhost:3000/api/session',{headers:{cookie:secondCookie}}),'session',()=>db,
  )
  assert.notEqual((await otherSession.json()).draftScope,sessionView.draftScope)
  assert.equal(
    (
      await handleAdoptionRequest(
        request(payload(), cookie, 'https://elsewhere.test'),
        'create',
        () => db,
      )
    ).status,
    409,
  )
  const normalized = new Request('http://localhost:3000/api/session', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      cookie,
    },
  })
  assert.equal(
    (await handleAdoptionRequest(normalized, 'profile', () => db)).status,
    200,
  )
  assert.equal(
    (await handleAdoptionRequest(request({}, ''), 'create', () => db)).status,
    404,
  )
  assert.equal(
    (
      await handleAdoptionRequest(
        request({ name: '好', blockedTopics: [] }, cookie),
        'rename',
        () => db,
        dog.id,
      )
    ).status,
    409,
  )
  assert.equal(
    (
      await handleAdoptionRequest(
        new Request('http://localhost:3000/api/dogs', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: 'broken',
        }),
        'create',
        () => db,
      )
    ).status,
    409,
  )
  process.env.NODE_ENV = 'production'
  assert.equal(
    (
      await handleAdoptionRequest(request({}), 'login', () => {
        throw Error('must not open db')
      })
    ).status,
    404,
  )
  assert.equal(
    (
      await (
        await handleAdoptionRequest(
          new Request('http://localhost:3000/api/session'),
          'session',
          () => db,
        )
      ).json()
    ).provider,
    'unavailable',
  )
})
test('current trip prefers active, detects conflicting active records, then latest sequence', () => {
  assert.equal(currentTrip([]), null)
  assert.equal(
    currentTrip([
      { id: 'old', seq: 1, status: 'running' },
      { id: 'new', seq: 2, status: 'done' },
    ]).id,
    'old',
  )
  assert.equal(
    currentTrip([
      { id: 'old', seq: 1, status: 'done' },
      { id: 'new', seq: 2, status: 'timeout' },
    ]).id,
    'new',
  )
  assert.throws(() =>
    currentTrip([{ status: 'pending' }, { status: 'running' }]),
  )
})
