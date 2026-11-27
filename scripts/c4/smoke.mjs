// Production HTTP acceptance against disposable fixture data, never a live-data/demo endpoint.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { openDatabase } from '../../lib/db/bootstrap.ts'
import { fixtureSession } from '../../tests/helpers/owner-session.mjs'

const root = resolve('.local/c4-smoke')
mkdirSync(root, { recursive: true })
const directory = mkdtempSync(join(root, 'run-'))
const path = join(directory, 'fixture.sqlite')
const db = openDatabase(path)
const session = fixtureSession(db, 'c4-local-smoke', true)
const secondDevice = fixtureSession(db, 'c4-local-smoke', true)
const cookie = session.setCookie.split(';')[0]
const secondCookie = secondDevice.setCookie.split(';', 1)[0]
for (const [id, owner, sample] of [['fixture-recipient', session.sessionId, 0], ['fixture-sender', null, 1]]) {
  db.prepare(`INSERT INTO dog(id,session_id,owner_id,personality_tags,assembly,is_sample,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(id, owner ?? 'fixture-other', owner, '["好奇","看物","直给"]',
    '{"outfit":null,"cloth":"S02-leaf-cape","accessory":null,"face":"F01-neutral"}', sample, '2026-11-17T00:00:00Z')
}
db.prepare(`INSERT INTO exchange(id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at)
  VALUES('fixture-gift','fixture-sender','fixture-recipient','gift',?,1,?)`)
  .run('{"kind":"gift","giftName":"验收夹具","note":null,"imagePath":null}', '2026-11-17T00:00:00Z')
db.close()

const probe = createServer()
probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
const port = probe.address().port
await new Promise((resolveClose, reject) => probe.close(error => error ? reject(error) : resolveClose()))
const base = `http://127.0.0.1:${port}`
let child, exit
async function start() {
  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', DATABASE_PATH: path, APP_IDENTITY_PROVIDER: 'zhihu' },
  })
  exit = once(child, 'exit')
  await new Promise((resolveReady, reject) => {
    let output = ''
    const watchdog = globalThis.setTimeout(() => reject(new Error('Production server readiness timed out')), 30000)
    function cleanup() { globalThis.clearTimeout(watchdog) }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('exit', () => { cleanup(); reject(new Error('Production server exited before ready')) })
    child.stdout.on('data', data => {
      output += data.toString()
      if (/Ready in/.test(output)) { cleanup(); resolveReady() }
    })
    child.stderr.on('data', () => {})
  })
}
async function stop() {
  if (child && child.exitCode === null) { child.kill(); await exit }
}
async function request(route, body, expected = 200, authenticated = true) {
  const response = await globalThis.fetch(base + route, {
    method: body === undefined ? 'GET' : route.endsWith('/revoke') ? 'PATCH' : 'POST',
    headers: { ...(authenticated ? { cookie: authenticated === true ? cookie : authenticated } : {}),
      ...(body === undefined ? {} : { origin: base }), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  assert.equal(response.status, expected, route)
  if (route.startsWith('/api/')) assert.equal(response.headers.get('cache-control'), 'no-store')
  return response
}
try {
  await start()
  await request('/')
  assert.deepEqual(await (await request('/api/health')).json(), { ok: true, service: 'zhihu-hackathon', database: 'ok' })
  const { trip } = await (await request('/api/dogs/fixture-recipient/trips', { trigger: 'wish' })).json()
  assert.equal(trip.status, 'pending')
  await request('/api/dogs/fixture-recipient/trips', { trigger: 'wish' }, 409)
  await request(`/api/trips/${trip.id}`, undefined, 404, false)
  await request('/api/dogs/fixture-sender/trips', undefined, 404)
  const started = await (await request(`/api/trips/${trip.id}/start`, {})).json()
  assert.equal(started.trip.status, 'running'); assert.equal(started.delivered.length, 1)
  assert.equal(started.delivered[0].deliveredAt, started.trip.startedAt)
  const replay = await (await request(`/api/trips/${trip.id}/start`, {})).json()
  assert.deepEqual(replay.trip, started.trip); assert.deepEqual(replay.delivered, [])
  const finished = await (await request(`/api/trips/${trip.id}/finish`, { status: 'done' })).json()
  assert.equal(finished.trip.status, 'done'); assert.deepEqual(finished.finds, []); assert.equal(finished.message, null)
  assert.deepEqual(await (await request(`/api/trips/${trip.id}/finish`, { status: 'done' })).json(), finished)
  await request(`/api/trips/${trip.id}/finish`, { status: 'timeout' }, 409)
  const listed = await (await request('/api/dogs/fixture-recipient/trips?limit=1')).json()
  assert.deepEqual(listed.trips, [finished.trip])
  console.log('PASS: production root/health, create/start/finish/get/list, ownership, idempotency and delivery')
  await stop(); await start()
  assert.deepEqual(await (await request(`/api/trips/${trip.id}`)).json(), { trip: finished.trip })
  assert.deepEqual(await (await request(`/api/trips/${trip.id}/finds`)).json(), { finds: [] })
  assert.deepEqual(await (await request(`/api/trips/${trip.id}/message`)).json(), { message: null })
  const wishes = '/api/dogs/fixture-recipient/wishes'
  const newWish = await (await request(wishes, { text: '想看雪', category: '自然风景' })).json()
  await request(`/api/wishes/${newWish.wish.id}/revoke`, {})
  assert.deepEqual(await (await request(wishes)).json(), { wishes: [] })
  const sessionView = await (await request('/api/session')).text()
  assert.equal(JSON.parse(sessionView).dog.id, 'fixture-recipient')
  assert.ok(!sessionView.includes(session.sessionId))
  assert.deepEqual(await (await request('/api/session', undefined, 200, secondCookie)).json(), JSON.parse(sessionView))
  await request('/api/dogs/fixture-recipient/invitations?state=all', undefined, 200, secondCookie)
  const logout = await request('/api/auth/logout', {})
  assert.match(logout.headers.get('set-cookie'), /HttpOnly.*Max-Age=0.*Secure/)
  await request(`/api/trips/${trip.id}`, undefined, 404)
  await request(`/api/trips/${trip.id}/finds`, undefined, 404)
  await request(`/api/trips/${trip.id}/message`, undefined, 404)
  await request(wishes, undefined, 404)
  await request('/api/dogs/fixture-recipient/invitations?state=all', undefined, 404)
  await request('/api/uploads/photo', {}, 401)
  await request('/api/replies', {}, 401)
  await request(`/api/trips/${trip.id}`, undefined, 200, secondCookie)
  console.log('PASS: production owner session, C4/C6/Wish/Message, logout and stale Cookie replay')
  const check = openDatabase(path)
  try {
    const gift = check.prepare("SELECT * FROM exchange WHERE id='fixture-gift'").get()
    assert.equal(gift.delivered_at, started.trip.startedAt)
    assert.equal(gift.replied_at, null); assert.equal(gift.read_at, null)
  } finally { check.close() }
  console.log('PASS: production process restart preserves trip and delivery timestamps; fixture database only')
} finally {
  await stop()
  assert.ok(directory.startsWith(root + sep))
  rmSync(directory, { recursive: true, force: true })
}
