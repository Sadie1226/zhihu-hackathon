import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { loadEnvFile } from 'node:process'
import { openDatabase } from '../../lib/db/bootstrap.ts'
import { ensureAnonymousSession, sessionCookieName } from '../../lib/auth/session.ts'
import { createTripService } from '../../lib/trips/service.ts'
import { createTripDiscoverer } from '../../lib/trips/discover.ts'
import { createFindStore } from '../../lib/trips/finds.ts'
import { createZhihuSearchClient } from '../../lib/zhihu/client.ts'

// Run after npm build. --live is a separate, explicit real request; never part of npm test.
// node --conditions=react-server tests/helpers/discover-smoke.mjs [--live]
const live = process.argv.includes('--live')
const root = resolve('.local'); mkdirSync(root, { recursive: true })
const report = { checkedAt: new Date().toISOString(), mode: live ? 'REAL_PROVIDER' : 'SYNTHETIC_PROVIDER',
  query: '想看雪', requestCount: 0, httpStatus: null, successfulCount: 0,
  publicUrls: [], productionGetStatus: null, noCookieStatus: null, postStatus: null,
  restartPreserved: false, result: 'NOT_RUN', errorType: null }
const reportPath = join(root, live ? 'c6-phase2-real-smoke.json' : 'c6-phase2-synthetic-smoke.json')
const directory = mkdtempSync(join(root, 'c6-wire-smoke-')), path = join(directory, 'app.sqlite')
let db, child
try {
  if (live) {
    try { loadEnvFile('.env') } catch { /* report only error type, never env contents */ }
    if (!process.env.ZHIHU_ACCESS_SECRET?.trim()) {
      report.errorType = 'AUTH'; throw new Error('SECRET_UNAVAILABLE')
    }
  }
  db = openDatabase(path)
  const session = ensureAnonymousSession(new Request('http://localhost'), db, true)
  const at = new Date().toISOString()
  db.prepare(`INSERT INTO dog(id,session_id,personality_tags,assembly,created_at)
    VALUES('smoke-private-dog',?,'["好奇","看物","直给"]',
    '{"cloth":"hoodie","hat":null,"glasses":null,"face":"hopeful"}',?)`).run(session.sessionId, at)
  db.prepare(`INSERT INTO wish(id,dog_id,text,category,created_at)
    VALUES('smoke-wish','smoke-private-dog','想看雪','自然风景',?)`).run(at)
  const service = createTripService(db)
  const trip = service.create('smoke-private-dog', session.sessionId, 'wish')
  service.start(trip.id, session.sessionId)
  const synthetic = createZhihuSearchClient({ accessSecret: 'synthetic-fixture-token', fetch: async () =>
    Response.json({ Code: 0, Data: { Items: [{ Title: 'Synthetic fixture smoke', ContentText: 'Not a real search',
      Url: 'https://www.zhihu.com/question/123/answer/456', AuthorityLevel: '4', VoteUpCount: 1 }] } }) })
  report.requestCount = 1
  const result = await createTripDiscoverer(db, live ? {} : { provider: synthetic })(trip.id, session.sessionId)
  report.httpStatus = result.httpStatus
  if (!result.ok) { report.errorType = result.error.code; throw new Error('PROVIDER_FAILED') }
  report.successfulCount = result.finds.length
  report.publicUrls = result.finds.map(find => find.sourceUrl)
  if (!result.finds.length) throw new Error('NO_RESULTS')
  const finished = service.finish(trip.id, session.sessionId, 'done')
  assert.deepEqual(finished.finds.map(row => ({ ...row })), result.finds)
  assert.equal(finished.message, null)
  db.close(); db = openDatabase(path)
  assert.deepEqual(createFindStore(db).list(trip.id, session.sessionId), result.finds)
  report.restartPreserved = true; db.close()
  const portServer = createServer()
  await new Promise(resolvePort => portServer.listen(0, '127.0.0.1', resolvePort))
  const port = portServer.address().port
  await new Promise(resolveClose => portServer.close(resolveClose))
  // The production HTTP child cannot use the real search credential, even if .env exists.
  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production',
      NODE_OPTIONS: '', DATABASE_PATH: path, ZHIHU_ACCESS_SECRET: '' } })
  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await globalThis.fetch(base + '/api/health')).ok } catch { /* server starting */ }
    if (ready) break
    await new Promise(resolveWait => globalThis.setTimeout(resolveWait, 100))
  }
  assert.ok(ready)
  const endpoint = `${base}/api/trips/${trip.id}/finds`
  const cookie = session.setCookie.split(';')[0]
  assert.ok(cookie.startsWith(sessionCookieName(true) + '='))
  const response = await globalThis.fetch(endpoint, { headers: { cookie } })
  report.productionGetStatus = response.status; assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('vary'), /Cookie/)
  assert.deepEqual(await response.json(), { finds: result.finds })
  report.noCookieStatus = (await globalThis.fetch(endpoint)).status; assert.equal(report.noCookieStatus, 404)
  report.postStatus = (await globalThis.fetch(endpoint, { method: 'POST', headers: { cookie } })).status
  assert.equal(report.postStatus, 405)
  report.result = 'PASS'
} catch {
  report.result = report.errorType === 'AUTH' && report.requestCount === 0 ? 'NOT_RUN' : 'FAILED'
  process.exitCode = 1
} finally {
  if (child && child.exitCode === null) {
    const stopped = new Promise(resolveStop => child.once('exit', resolveStop))
    child.kill(); await stopped
  }
  if (db?.isOpen) db.close()
  rmSync(directory, { recursive: true, force: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2)) // deliberate safe allowlist only
}
