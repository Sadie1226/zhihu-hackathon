/* global fetch */
// Run after `npm run build -- --webpack`. Uses an external, isolated development-named DB.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, join, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../', import.meta.url))
const port = process.env.E10_TEST_PORT || '3218'
const base = `http://127.0.0.1:${port}`
const db = resolve(process.env.E10_TEST_DATABASE || join(root, '..', '.tmp-e10-http', `a5-development-http-${Date.now()}.sqlite`))
const relativeDb = relative(root, db)
assert(relativeDb.startsWith('..' + sep) || isAbsolute(relativeDb), 'Test database must be outside the repository')
assert(/a5-development-[a-z0-9-]+\.sqlite$/i.test(db), 'Use an explicit development database filename')
await mkdir(dirname(db), {recursive:true})
const server = spawn(process.execPath, [join(root,'node_modules/next/dist/bin/next'),'start','--port',port,'--hostname','127.0.0.1'], {
  cwd:root, env:{...process.env,NODE_ENV:'production',DATABASE_PATH:db,APP_IDENTITY_PROVIDER:'',NEXT_TELEMETRY_DISABLED:'1'}, stdio:['ignore','pipe','pipe'],
})
let log = ''
server.stdout.on('data', data => { log += data })
server.stderr.on('data', data => { log += data })
try {
  let ready = false
  for (let attempt=0; attempt<40; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready=true; break } } catch { /* Waiting for the child listener. */ }
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}: ${log.slice(-1200)}`)
    await delay(250)
  }
  assert(ready, `Server did not start: ${log.slice(-1200)}`)
  const home = await fetch(`${base}/home`)
  assert.equal(home.status,200)
  const preview = await fetch(`${base}/openings-preview`)
  assert.equal(preview.status,404, 'Fixture route must not be available in production')
  const media = await fetch(`${base}/assets/e10-openings/journal-open.mp4`)
  assert.equal(media.status,200)
  assert.match(media.headers.get('content-type') || '',/video\/mp4/)
  const bytes = new Uint8Array(await media.arrayBuffer())
  assert(bytes.length > 0)
  const range = await fetch(`${base}/assets/e10-openings/journal-open.mp4`,{headers:{Range:'bytes=0-63'}})
  assert.equal(range.status,206)
  assert.equal((await range.arrayBuffer()).byteLength,64)
  const output = {productionHttpOnly:true,browserInteraction:'not tested here',homeStatus:home.status,fixtureStatus:preview.status,mediaStatus:media.status,mediaBytes:bytes.length,rangeStatus:range.status,rangeBytes:64,database:'isolated external database'}
  const out = process.env.E10_HTTP_EVIDENCE || join(root,'team/2026-11-28/e/home-openings/evidence/http.json')
  await mkdir(dirname(out),{recursive:true})
  await writeFile(out,JSON.stringify(output,null,2))
  console.log(JSON.stringify(output,null,2))
} finally {
  const stopped = new Promise(resolveStop => server.once('close',resolveStop))
  server.kill('SIGTERM')
  if (server.exitCode === null) await stopped
}
