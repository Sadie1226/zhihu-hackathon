import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

// Run explicitly from the pinned B worktree, whose schema and fixtures are v5.
const fromCheckout = path => import(pathToFileURL(resolve(path)).href)
const { createInvitationStore } = await fromCheckout('app/(b)/b6-invitations.ts')
const { createTripService } = await fromCheckout('lib/trips/service.ts')
const { mailboxDatabase, ownedDog } = await fromCheckout('tests/helpers/mailbox-fixtures.mjs')

test('reference B6: concurrent waiting retries reuse, including at capacity, while terminal invitation replay is unbound', async t => {
  const { db, path } = mailboxDatabase(t)
  const { id: dogId, sessionId } = ownedDog(db, 'b6-reference-dog')
  const startAt = '2026-11-27T01:00:00.000Z'
  const inviteAt = '2026-11-27T02:00:00.000Z'
  const c4 = createTripService(db, { now: () => new Date(startAt) })
  const trip = c4.start(c4.create(dogId, sessionId, 'auto').id, sessionId).trip
  c4.finish(trip.id, sessionId, 'done')
  db.prepare("INSERT INTO find(id,trip_id,kind,title,created_at) VALUES('source',?,'scene','合成材料',?)").run(trip.id, startAt)
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { openDatabase } from './lib/db/bootstrap.ts';
      import { createInvitationStore } from './app/(b)/b6-invitations.ts';
      const [path, dogId, ownerId, time] = JSON.parse(process.argv[1]);
      const db = openDatabase(path);
      try {
        const result = createInvitationStore(db, { now: () => new Date(time) }).create(dogId, ownerId, { basedOnFindId: 'source' });
        console.log(JSON.stringify(result));
      } finally { db.close(); }
    `, JSON.stringify([path, dogId, sessionId, inviteAt])], { windowsHide: true })
    let output = '', errors = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { errors += data })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)))
  })
  const [a, b] = await Promise.all([run(), run()])
  assert.equal(a.invitation.id, b.invitation.id)
  assert.equal(db.prepare('SELECT count(*) n FROM invitation').get().n, 1)
  const store = createInvitationStore(db, { now: () => new Date(inviteAt) })
  store.create(dogId, sessionId, {})
  store.create(dogId, sessionId, {})
  assert.equal(store.create(dogId, sessionId, { basedOnFindId: 'source' }).invitation.id, a.invitation.id)
  assert.equal(store.create(dogId, sessionId, {}).wentAlone, true)
  assert.equal(db.prepare("SELECT count(*) n FROM v_invitation_state WHERE state='waiting'").get().n, 3)
  const later = '2026-11-27T08:00:00.000Z'
  const next = createTripService(db, { now: () => new Date(later) })
  next.start(next.create(dogId, sessionId, 'auto').id, sessionId)
  assert.equal(db.prepare('SELECT state FROM v_invitation_state WHERE invitation_id=?').get(a.invitation.id).state, 'gone_alone')
  const after = createInvitationStore(db, { now: () => new Date(later) }).create(dogId, sessionId, { basedOnFindId: 'source' })
  assert.notEqual(after.invitation.id, a.invitation.id)
  console.log('B6 gap reproduced: same source after gone_alone can create another row')
  db.prepare('INSERT INTO reply(id,invitation_id,text,created_at) VALUES(?,?,?,?)')
    .run('control-reply', after.invitation.id, '离线回应', later)
  assert.equal(db.prepare('SELECT state FROM v_invitation_state WHERE invitation_id=?').get(after.invitation.id).state, 'replied')
  const afterReply = createInvitationStore(db, { now: () => new Date(later) }).create(dogId, sessionId, { basedOnFindId: 'source' })
  assert.notEqual(afterReply.invitation.id, after.invitation.id)
  console.log('B6 gap reproduced: same source after replied can create another row')
})
