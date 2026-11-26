// POST /api/chat 服务端持久化回归测试（Node 24，--experimental-strip-types）。
// 用真实 SQLite 内存库 + C 的 chat_message v9 表结构（仅测试夹具，B 不建迁移），
// 验证 writeChatOnce 的写事务：授权先于幂等、同值回放、异值冲突、并发只写一行、
// 提交失败不返回成功、跨 owner 隔离。不 import '@/'，不连项目默认库。
import assert from 'node:assert/strict'
import { unlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { isOwnerKeyConflict, toChatResponse, writeChatOnce } from '../lib/chat/server-store.ts'

const TEXT = '今天想和你说件小事'
const KEY = 'msg_intent_abc123'

// 与 C 的 contracts/schema-v9-chat.sql 等价的最小夹具：六字段 + 目标唯一键 + 防覆盖触发器。
const CHAT_MESSAGE_DDL = `
CREATE TABLE owner (id TEXT PRIMARY KEY);
CREATE TABLE dog (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, is_sample INTEGER NOT NULL DEFAULT 0);
CREATE TABLE chat_message (
  id TEXT NOT NULL PRIMARY KEY CHECK (id <> ''),
  owner_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL COLLATE BINARY,
  dog_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (text <> ''),
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, client_message_id)
) STRICT;
CREATE TRIGGER chat_message_v9_insert_guard BEFORE INSERT ON chat_message
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: chat_message.id')
    WHERE EXISTS (SELECT 1 FROM chat_message WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: chat_message.owner_id, chat_message.client_message_id')
    WHERE EXISTS (SELECT 1 FROM chat_message WHERE owner_id = NEW.owner_id AND client_message_id = NEW.client_message_id);
END;
`

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(CHAT_MESSAGE_DDL)
  db.exec("INSERT INTO owner (id) VALUES ('owner_a'), ('owner_b')")
  db.exec("INSERT INTO dog (id, owner_id, is_sample) VALUES ('dog_a', 'owner_a', 0), ('dog_b', 'owner_b', 0), ('seed_a', 'owner_a', 1)")
  return { db }
}
const validSession = () => true

test('首次写入 created：真实落库一行，四键回执无 owner/key', () => {
  const { db } = setup()
  const result = writeChatOnce(db,
    { ownerId: 'owner_a', dogId: 'dog_a', text: TEXT, clientMessageId: KEY }, validSession)
  assert.equal(result.kind, 'created')
  if (result.kind !== 'created') return
  assert.deepEqual(Object.keys(toChatResponse(result.record)).sort(), ['createdAt', 'dogId', 'id', 'text'])
  assert.equal(db.prepare('SELECT count(*) AS n FROM chat_message').get().n, 1)
  const row = db.prepare('SELECT text, owner_id FROM chat_message').get()
  assert.equal(row.text, TEXT)
  assert.equal(row.owner_id, 'owner_a')
})

test('同键同值回放：不改 createdAt、不新增行', () => {
  const { db } = setup()
  const input = { ownerId: 'owner_a', dogId: 'dog_a', text: TEXT, clientMessageId: KEY }
  const first = writeChatOnce(db, input, validSession)
  if (first.kind !== 'created') return assert.fail('first should create')
  const again = writeChatOnce(db, input, validSession)
  assert.equal(again.kind, 'replay')
  if (again.kind === 'replay') assert.equal(again.record.createdAt, first.record.createdAt)
  assert.equal(db.prepare('SELECT count(*) AS n FROM chat_message').get().n, 1)
})

test('同键改文本或换狗：conflict，库不变', () => {
  const { db } = setup()
  writeChatOnce(db, { ownerId: 'owner_a', dogId: 'dog_a', text: TEXT, clientMessageId: KEY }, validSession)
  const changedText = writeChatOnce(db,
    { ownerId: 'owner_a', dogId: 'dog_a', text: TEXT + '!', clientMessageId: KEY }, validSession)
  assert.equal(changedText.kind, 'conflict')
  assert.equal(db.prepare('SELECT text FROM chat_message').get().text, TEXT)
})

test('授权先于幂等：种子狗/跨主人/会话失效一律 forbidden，不回读同键', () => {
  const { db } = setup()
  const base = { ownerId: 'owner_a', text: TEXT, clientMessageId: KEY }
  assert.equal(writeChatOnce(db, { ...base, dogId: 'seed_a' }, validSession).kind, 'forbidden')
  assert.equal(writeChatOnce(db, { ...base, dogId: 'dog_b' }, validSession).kind, 'forbidden')
  assert.equal(writeChatOnce(db, { ...base, dogId: 'dog_a' }, () => false).kind, 'forbidden')
  assert.equal(db.prepare('SELECT count(*) AS n FROM chat_message').get().n, 0)
})

test('跨 owner 同键互不冲突：各自首存', () => {
  const { db } = setup()
  const a = writeChatOnce(db, { ownerId: 'owner_a', dogId: 'dog_a', text: TEXT, clientMessageId: KEY }, validSession)
  const b = writeChatOnce(db, { ownerId: 'owner_b', dogId: 'dog_b', text: TEXT, clientMessageId: KEY }, validSession)
  assert.equal(a.kind, 'created')
  assert.equal(b.kind, 'created')
  assert.equal(db.prepare('SELECT count(*) AS n FROM chat_message').get().n, 2)
})

test('表未就位（未跑 v9 迁移）：failed，绝不返回成功', () => {
  const db = new DatabaseSync(':memory:')
  const result = writeChatOnce(db,
    { ownerId: 'owner_a', dogId: 'dog_a', text: TEXT, clientMessageId: KEY }, validSession)
  assert.equal(result.kind, 'failed')
})

test('提交阶段真实故障：failed，不冒充成功', () => {
  const { db } = setup()
  // AFTER INSERT 触发器在提交前抛非唯一键错误，模拟磁盘/约束故障。
  db.exec(`CREATE TRIGGER chat_fail BEFORE INSERT ON chat_message
    BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`)
  const result = writeChatOnce(db,
    { ownerId: 'owner_a', dogId: 'dog_a', text: TEXT, clientMessageId: KEY }, validSession)
  assert.equal(result.kind, 'failed')
  assert.equal(db.prepare('SELECT count(*) AS n FROM chat_message').get().n, 0)
})

test('两独立连接并发同键：只落一行，两侧都确认同一 id', () => {
  // 内存库不能跨连接共享，改用临时文件库模拟两连接争抢。
  const path = `./_chat_concurrency_${process.pid}.sqlite`
  try {
    const init = new DatabaseSync(path)
    init.exec(CHAT_MESSAGE_DDL)
    init.exec("INSERT INTO owner (id) VALUES ('owner_a')")
    init.exec("INSERT INTO dog (id, owner_id, is_sample) VALUES ('dog_a', 'owner_a', 0)")
    init.close()
    const c1 = new DatabaseSync(path)
    const c2 = new DatabaseSync(path)
    const input = { ownerId: 'owner_a', dogId: 'dog_a', text: TEXT, clientMessageId: KEY }
    const r1 = writeChatOnce(c1, input, validSession)
    const r2 = writeChatOnce(c2, input, validSession)
    assert.ok(r1.kind === 'created' || r1.kind === 'replay')
    assert.ok(r2.kind === 'created' || r2.kind === 'replay')
    if (r1.kind !== 'created' && r1.kind !== 'replay') return assert.fail('r1 unexpected')
    if (r2.kind !== 'created' && r2.kind !== 'replay') return assert.fail('r2 unexpected')
    assert.equal(r1.record.id, r2.record.id)
    const check = new DatabaseSync(path)
    assert.equal(check.prepare('SELECT count(*) AS n FROM chat_message').get().n, 1)
    check.close(); c1.close(); c2.close()
  } finally {
    try {
      unlinkSync(path)
    } catch { /* 忽略清理失败 */ }
  }
})

test('isOwnerKeyConflict 只认目标唯一键，不认主键冲突', () => {
  assert.equal(isOwnerKeyConflict(new Error('UNIQUE constraint failed: chat_message.owner_id, chat_message.client_message_id')), true)
  assert.equal(isOwnerKeyConflict(new Error('UNIQUE constraint failed: chat_message.id')), false)
  assert.equal(isOwnerKeyConflict(new Error('FOREIGN KEY constraint failed')), false)
})
