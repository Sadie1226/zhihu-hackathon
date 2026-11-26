import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { revokeSession, resolveAuthContext, sessionCookieName } from '../lib/auth/session.ts'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { CHAT_BODY_MAX_BYTES, CHAT_TEXT_MAX_CHARS, parseChatRequest } from '../contracts/chat.ts'
import { countChars } from '../contracts/types.ts'
import { insertDog, mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'
import { fixtureSession } from './helpers/owner-session.mjs'

const api = readFileSync('contracts/api.md', 'utf8')
const types = readFileSync('contracts/types.ts', 'utf8')
const request = { dogId: 'dog_xxx', text: '今天想和你说件小事', clientMessageId: 'msg_intent_xxx' }
const expectedResponse = { id: 'chat_xxx', dogId: request.dogId, text: request.text, createdAt: '2026-11-25T08:00:00.000Z' }

test('documented JSON examples match the request parser and first-commit response fields', () => {
  const section = api.split('### 11. 日常交流')[1].split('## 三、')[0]
  const examples = [...section.matchAll(/```json\r?\n([\s\S]+?)\r?\n```/g)].map(block => JSON.parse(block[1]))
  assert.deepEqual(examples, [request, expectedResponse])
  assert.deepEqual(parseChatRequest(examples[0]), request)
  assert.equal(new Date(expectedResponse.createdAt).toISOString(), expectedResponse.createdAt)
  for (const [type, example] of [['ChatRequest', request], ['ChatResponse', expectedResponse]]) {
    const declaration = types.match(new RegExp(`export interface ${type} \\{([^}]+)\\}`))[1]
    assert.deepEqual([...declaration.matchAll(/^\s+(\w+): (string|IsoTime)$/gm)].map(field => field[1]), Object.keys(example))
  }
  assert.doesNotMatch(section, /\|\s*400\s*\|/)
  for (const [status, code, retriable] of [[404, 'NOT_FOUND', false], [409, 'CONFLICT', false], [503, 'NETWORK', true]]) {
    assert.match(section, new RegExp(`\\| ${status} \\| \`${code}\` \\| ${retriable} \\|`))
  }
})

test('trim preserves interior whitespace and Unicode spelling with the shared UTF-16 length rule', () => {
  const parseText = text => parseChatRequest({ ...request, text })
  assert.equal(CHAT_BODY_MAX_BYTES, 16_384)
  assert.equal(CHAT_TEXT_MAX_CHARS, 200)
  assert.equal(parseText(' \t你好，\n  café\r\n ').text, '你好，\n  café')
  assert.equal(parseText(' e\u0301 ').text, 'e\u0301')
  assert.equal(countChars(' 汉。\n😀e\u0301 '), 6)
  for (const word of ['狗'.repeat(200), '😀'.repeat(100), 'e\u0301'.repeat(100), '字' + ' '.repeat(2047)]) {
    assert.ok(parseText(word))
  }
  for (const word of ['狗'.repeat(201), '😀'.repeat(100) + '。', ' \u00A0\n\t', '字' + ' '.repeat(2048), '\uD800', '字\u0000', '字\u0085']) {
    assert.equal(parseText(word), null)
  }
})

test('rejects absent, extra or incorrectly typed fields and malformed intent keys', () => {
  for (const value of [
    undefined, null, [], 'hello', {}, { dogId: request.dogId, text: request.text },
    { ...request, ownerId: 'owner' }, { ...request, sessionId: 'session' }, { ...request, token: 'token' },
    { ...request, dogId: 1 }, { ...request, dogId: ' dog_xxx' }, { ...request, dogId: 'x'.repeat(129) },
    { ...request, text: ['text'] }, { ...request, clientMessageId: null },
    ...['', '_first', 'a b', 'a/b', 'a\n', 'a.', '中', 'a'.repeat(129)].map(clientMessageId => ({ ...request, clientMessageId })),
  ]) assert.equal(parseChatRequest(value), null)
  assert.ok(parseChatRequest({ ...request, clientMessageId: 'A' + '_'.repeat(127) }))
})

test('default v9 storage supports owner-scoped first-write replay and leaves Trip Message and Snapshot untouched', t => {
  const { db, path } = mailboxDatabase(t)
  const firstSession = fixtureSession(db, 'chat-test-first')
  const first = { id: 'dog_first', cookie: firstSession.setCookie.split(';', 1)[0] }
  insertDog(db, first.id, firstSession.sessionId)
  const second = ownedDog(db, 'dog_second')
  insertDog(db, 'dog_sample', 'seed', 1)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9)
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='chat_message'").get().name, 'chat_message')
  const cookieRequest = cookie => new Request('https://example.test/api/chat', { headers: { Cookie: cookie } })
  const persisted = (connection, dog, text, id, createdAt = expectedResponse.createdAt) => {
    const { clientMessageId } = request
    const save = connection.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?)')
    const find = connection.prepare(`SELECT id, dog_id AS dogId, text, created_at AS createdAt
      FROM chat_message WHERE owner_id = ? AND client_message_id = ?`)
    const normalized = parseChatRequest({ dogId: dog.id, text, clientMessageId }).text
    connection.exec('BEGIN IMMEDIATE')
    try {
      const auth = resolveAuthContext(cookieRequest(dog.cookie), connection)
      const matchingDog = connection.prepare('SELECT 1 FROM dog WHERE id = ? AND owner_id = ? AND is_sample = 0')
      if (!auth || !matchingDog.get(dog.id, auth.ownerId)) {
        connection.exec('ROLLBACK')
        return '404 NOT_FOUND'
      }
      let row = find.get(auth.ownerId, clientMessageId)
      if (!row) {
        save.run(id, auth.ownerId, clientMessageId, dog.id, normalized, createdAt)
        row = find.get(auth.ownerId, clientMessageId)
      }
      connection.exec('COMMIT')
      return row.dogId === dog.id && row.text === normalized ? { ...row } : '409 CONFLICT'
    } catch (error) {
      if (connection.isTransaction) connection.exec('ROLLBACK')
      throw error
    }
  }
  assert.equal(persisted(db, { ...first, cookie: `${sessionCookieName()}=seed` }, request.text, 'chat_forged'), '404 NOT_FOUND')
  const saved = persisted(db, first, request.text, 'chat_first')
  assert.deepEqual(Object.keys(saved), ['id', 'dogId', 'text', 'createdAt'])
  assert.deepEqual(persisted(db, first, ' ' + request.text + ' ', 'chat_retry'), saved)
  assert.equal(persisted(db, first, '改了内容', 'chat_conflict'), '409 CONFLICT')
  for (const id of [second.id, 'dog_sample', 'missing']) {
    assert.equal(persisted(db, { ...first, id }, request.text, 'chat_forbidden'), '404 NOT_FOUND')
  }
  assert.throws(() => db.prepare('INSERT INTO chat_message VALUES (?,?,?,?,?,?)')
    .run('invalid', firstSession.sessionId, 'cross', second.id, request.text, expectedResponse.createdAt), /FOREIGN KEY/)
  assert.equal(persisted(db, second, request.text, 'chat_second').id, 'chat_second')
  assert.equal(db.prepare('SELECT count(*) AS n FROM chat_message').get().n, 2)
  const messageColumns = db.prepare("PRAGMA table_info('message')").all().map(column => column.name)
  assert.deepEqual(messageColumns, ['id', 'trip_id', 'text', 'mentions_find_id', 'created_at'])
  for (const table of ['message', 'snapshot', 'wish', 'exchange', 'reply', 'trip_event']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table)
  }
  revokeSession(cookieRequest(first.cookie), db)
  db.close()
  const reopened = openDatabase(path)
  try {
    assert.equal(persisted(reopened, first, request.text, 'chat_revoked'), '404 NOT_FOUND')
    const newSession = fixtureSession(reopened, 'chat-test-first')
    assert.equal(newSession.sessionId, firstSession.sessionId)
    const retried = persisted(reopened, { ...first, cookie: newSession.setCookie.split(';', 1)[0] },
      request.text, 'chat_reopened', '2026-11-25T09:00:00.000Z')
    assert.deepEqual(retried, saved)
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { reopened.close() }
})
