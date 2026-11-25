import assert from 'node:assert/strict'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { parseChatRequest } from '../contracts/chat.ts'
import { openDatabase } from '../lib/db/bootstrap.ts'
import { migrations } from '../lib/db/migrations.ts'
import { CHAT_MESSAGE_V9_SQL, chatMessageMigration } from '../lib/db/migrations/009-chat-message.ts'
import { insertDog, mailboxDatabase, ownedDog } from './helpers/mailbox-fixtures.mjs'

const at = '2026-11-25T08:00:00.000Z'
const fields = '(id, owner_id, client_message_id, dog_id, text, created_at)'
const insertSql = `INSERT INTO chat_message ${fields} VALUES (?,?,?,?,?,?)`
const keyConflict = { code: 'ERR_SQLITE_ERROR', errcode: 1811,
  message: 'UNIQUE constraint failed: chat_message.owner_id, chat_message.client_message_id' }
const idConflict = { code: 'ERR_SQLITE_ERROR', errcode: 1811, message: 'UNIQUE constraint failed: chat_message.id' }
const foreignKey = { code: 'ERR_SQLITE_ERROR', errcode: 787 }
const rows = db => db.prepare('SELECT * FROM chat_message ORDER BY id').all()
const hasV8 = migrations.some(migration => migration.version === 8)
const versions = hasV8 && migrations.at(-1).version === 8 ? [...migrations, chatMessageMigration] : migrations

function setup(t) {
  const { db, path } = mailboxDatabase(t, versions)
  if (!hasV8) db.exec(CHAT_MESSAGE_V9_SQL)
  const getOwner = db.prepare('SELECT owner_id AS ownerId FROM dog WHERE id = ?')
  const [first, second] = ['chat-dog-first', 'chat-dog-second'].map(id => {
    ownedDog(db, id)
    return { id, ...getOwner.get(id) }
  })
  const value = (id = 'chat-fixture-1', owner = first, key = 'Intent-1') =>
    [id, owner.ownerId, key, owner.id, '隔离测试材料', at]
  return { db, path, first, second, value, insert: db.prepare(insertSql) }
}

test('STRICT six-column table enforces the stable owner and accepted composite dog parent key', t => {
  const { db, first, second, insert, value } = setup(t)
  insertDog(db, 'sample-chat-dog', 'sample-local', 1)
  insertDog(db, 'unowned-chat-dog', 'unowned-local')
  assert.equal(db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'chat_message'").get().strict, 1)
  const columns = db.prepare("SELECT name, type, pk, \"notnull\" FROM pragma_table_info('chat_message') ORDER BY cid").all()
  assert.deepEqual(columns.map(row => row.name), ['id', 'owner_id', 'client_message_id', 'dog_id', 'text', 'created_at'])
  assert.ok(columns.every(row => row.type === 'TEXT' && row.notnull === 1))
  assert.deepEqual(columns.filter(row => row.pk).map(row => row.name), ['id'])
  assert.equal(db.prepare("SELECT \"unique\" AS isUnique FROM pragma_index_list('dog') WHERE name = 'uniq_dog_id_owner'")
    .get().isUnique, 1)
  assert.deepEqual(db.prepare("SELECT name FROM pragma_index_info('uniq_dog_id_owner') ORDER BY seqno").all()
    .map(row => row.name), ['id', 'owner_id'])
  const { token_hash: sessionHash } = db.prepare('SELECT token_hash FROM owner_session WHERE owner_id = ?').get(first.ownerId)
  for (const [ownerId, dogId] of [
    ['missing-owner', first.id], [sessionHash, first.id], [first.ownerId, 'missing-dog'],
    [first.ownerId, second.id], [first.ownerId, 'sample-chat-dog'], [first.ownerId, 'unowned-chat-dog'],
  ]) {
    assert.throws(() => insert.run('chat-invalid', ownerId, 'Intent-1', dogId, '隔离材料', at), foreignKey)
  }
  assert.throws(() => db.prepare("UPDATE dog SET is_sample = 1 WHERE id = ?").run(first.id), /invalid owner association/)
  for (let field = 0; field < 6; field++) {
    const invalid = value()
    invalid[field] = null
    assert.throws(() => insert.run(...invalid), /NOT NULL/)
  }
  assert.throws(() => insert.run(...value('')), /CHECK/)
  insert.run(...value())
  assert.equal(rows(db).length, 1)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('owner key is case-sensitive; primary-key, targeted uniqueness and REPLACE are distinguishable', t => {
  const { db, first, second, insert, value } = setup(t)
  insert.run(...value())
  const prior = rows(db)
  for (const prefix of ['INSERT', 'INSERT OR REPLACE', 'REPLACE']) {
    const attempt = db.prepare(`${prefix} INTO chat_message ${fields} VALUES (?,?,?,?,?,?)`)
    assert.throws(() => attempt.run(...value('chat-other-id')), keyConflict)
    assert.throws(() => attempt.run(...value('chat-fixture-1', first, 'other-key')), idConflict)
    assert.deepEqual(rows(db), prior)
  }
  assert.throws(() => insert.run(...value()), idConflict)
  insert.run(...value('chat-other-owner', second))
  insert.run(...value('chat-other-case', first, 'intent-1'))
  assert.equal(rows(db).length, 3)

  db.exec('BEGIN; DROP TRIGGER chat_message_v9_insert_guard')
  try {
    assert.throws(() => insert.run(...value('chat-another-id')), { errcode: 2067 })
    assert.throws(() => insert.run(...value('chat-fixture-1', first, 'another-key')), { errcode: 1555 })
  } finally { db.exec('ROLLBACK') }
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'chat_message_v9_insert_guard'").get().name,
    'chat_message_v9_insert_guard')
})

test('key CHECK matches the parser; valid Unicode text and first server fields survive reopen unchanged', t => {
  const { db, path, first, insert, value } = setup(t)
  for (const key of ['', 'a ', ' a', '_a', 'a.b', 'a/b', 'a\n', '中', 'a\u0000hidden', 'a'.repeat(129)]) {
    assert.equal(parseChatRequest({ dogId: first.id, clientMessageId: key, text: '样本' }), null)
    assert.throws(() => insert.run(...value('chat-invalid', first, key)), /CHECK/)
  }
  const phrases = [' \t汉  e\u0301\r\n😀 \u00a0', '😀'.repeat(100), '字' + ' '.repeat(2046) + '尾']
  for (const [index, text] of phrases.entries()) {
    const parsed = parseChatRequest({ dogId: first.id, clientMessageId: 'A' + '_'.repeat(126) + index, text })
    assert.ok(parsed)
    insert.run(`opaque-server-id-${index}`, first.ownerId, parsed.clientMessageId, parsed.dogId, parsed.text, at)
  }
  assert.equal(rows(db)[0].text, '汉  e\u0301\r\n😀')
  assert.equal(rows(db)[2].text, phrases[2])
  const prior = rows(db)
  db.close()
  const reopened = openDatabase(path, versions)
  try {
    assert.deepEqual(rows(reopened), prior)
    for (const table of ['snapshot', 'find', 'trip_event', 'invitation', 'message', 'reply', 'exchange', 'wish']) {
      assert.equal(reopened.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table)
    }
    assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { reopened.close() }
})

test('INSERT faults and a real deferred-FK COMMIT failure roll back chat rows and preserve previous data', t => {
  const { db, insert, value } = setup(t)
  insert.run(...value())
  const prior = rows(db)
  db.exec(`CREATE TRIGGER test_chat_insert_failure AFTER INSERT ON chat_message WHEN NEW.id = 'fail-insert'
    BEGIN SELECT RAISE(FAIL, 'injected insert failure'); END`)
  db.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(() => insert.run(...value('fail-insert', undefined, 'insert-fault-key')), /injected insert failure/)
    assert.equal(rows(db).length, 2)
  } finally { db.exec('ROLLBACK') }
  assert.deepEqual(rows(db), prior)

  db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON')
  try {
    insert.run('fail-commit', value()[1], 'commit-fault-key', 'missing-dog', '隔离材料', at)
    assert.equal(rows(db).length, 2)
    assert.throws(() => db.exec('COMMIT'), foreignKey)
    assert.equal(db.isTransaction, true)
  } finally { if (db.isTransaction) db.exec('ROLLBACK') }
  assert.deepEqual(rows(db), prior)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('independent SQLite connections competing for one owner key preserve only the first row', { timeout: 15000 }, async t => {
  const { db, path, first, value } = setup(t)
  const source = `
    const { parentPort, workerData } = require('node:worker_threads')
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(workerData.path, { timeout: 5000 })
    db.exec('PRAGMA foreign_keys = ON')
    parentPort.once('message', () => {
      try {
        db.exec('BEGIN IMMEDIATE')
        db.prepare(workerData.sql).run(...workerData.values)
        db.exec('COMMIT')
        parentPort.postMessage({ id: workerData.values[0] })
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK')
        parentPort.postMessage({ message: error.message, errcode: error.errcode })
      } finally { db.close(); parentPort.close() }
    })
    parentPort.postMessage('ready')
  `
  const workers = ['chat-race-a', 'chat-race-b'].map(id => {
    const worker = new Worker(source, { eval: true, workerData: { path, sql: insertSql, values: value(id, first) } })
    t.after(() => worker.terminate())
    return { worker, ready: once(worker, 'message'), exit: once(worker, 'exit') }
  })
  assert.deepEqual(await Promise.all(workers.map(item => item.ready)), [['ready'], ['ready']])
  const results = workers.map(item => once(item.worker, 'message'))
  workers.forEach(item => item.worker.postMessage('insert'))
  const replies = (await Promise.all(results)).map(([result]) => result)
  for (const item of workers) assert.deepEqual(await item.exit, [0])
  const [winner] = rows(db)
  assert.equal(rows(db).length, 1)
  assert.ok(replies.some(reply => reply.id === winner.id))
  assert.ok(replies.some(reply => reply.message === keyConflict.message && reply.errcode === keyConflict.errcode))
  const independentReader = new DatabaseSync(path, { readOnly: true })
  try { assert.deepEqual(rows(independentReader), rows(db)) } finally { independentReader.close() }
})
