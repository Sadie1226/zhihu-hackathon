import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleMailboxRequest } from '../lib/mailbox/http.ts'
import { handleContentRequest } from '../app/(b)/b5-share.ts'
import { issueOwnerSession, revokeSession } from '../lib/auth/session.ts'
import { mailboxDatabase, seedMailbox } from './helpers/mailbox-fixtures.mjs'

test('mailbox and B content use one owner resolver, preserve another device and reject revoked cookies', async t => {
  const { db } = mailboxDatabase(t)
  const { owner, otherTrip } = seedMailbox(db)
  const identity = db.prepare('SELECT provider_subject subject FROM owner WHERE id = ?').get(owner.sessionId)
  const second = issueOwnerSession(db, { provider: 'zhihu', subject: identity.subject }).setCookie.split(';', 1)[0]
  const req = cookie => new Request('http://localhost/api/mailbox', { headers: { cookie } })
  const target = { action: 'inbox', id: owner.id }
  assert.equal((await handleMailboxRequest(req(owner.cookie), target, () => db)).status, 200)
  revokeSession(req(owner.cookie), db)
  assert.equal((await handleMailboxRequest(req(owner.cookie), target, () => db)).status, 404)
  assert.equal((await handleMailboxRequest(req(second), target, () => db)).status, 200)
  const response = await handleContentRequest(req(owner.cookie), otherTrip.id, () => db)
  assert.equal(response.status, 404)
})
