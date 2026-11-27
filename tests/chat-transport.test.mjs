// 客户端传输层映射测试：POST 响应到 send.ts 四类结果的边界（Node 24）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatTransport, interpretChatResponse } from '../lib/chat/transport.ts'

const OK_BODY = { id: 'chat_1', dogId: 'dog_a', text: '你好', createdAt: '2026-11-26T08:00:00.000Z' }

test('200 严格四键回执 → ok', () => {
  const result = interpretChatResponse(200, OK_BODY)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') assert.deepEqual(result.response, OK_BODY)
})

test('200 多字段或字段缺失 → 不采信，按可重试处理', () => {
  assert.equal(interpretChatResponse(200, { ...OK_BODY, replyText: '假回复' }).kind, 'retriable')
  assert.equal(interpretChatResponse(200, { id: '', dogId: 'dog_a', text: '你好', createdAt: 'x' }).kind, 'retriable')
  assert.equal(interpretChatResponse(200, null).kind, 'retriable')
})

test('409 → conflict 终态；404 → forbidden；5xx/0 → network 可重试', () => {
  assert.equal(interpretChatResponse(409, { code: 'CONFLICT' }).kind, 'conflict')
  assert.equal(interpretChatResponse(404, { code: 'NOT_FOUND' }).kind, 'forbidden')
  assert.deepEqual(interpretChatResponse(503, { code: 'NETWORK' }), { kind: 'retriable', reason: 'network' })
  assert.equal(interpretChatResponse(0, null).kind, 'retriable')
})

test('createChatTransport 请求三字段、同源凭据；网络异常按可重试', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return { status: 200, json: async () => OK_BODY }
  }
  const result = await createChatTransport(fetchImpl)({
    dogId: 'dog_a', text: '你好', clientMessageId: 'msg_intent_abc123',
  })
  assert.equal(result.kind, 'ok')
  assert.equal(seen.url, '/api/chat')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.credentials, 'same-origin')
  assert.deepEqual(JSON.parse(seen.init.body), {
    dogId: 'dog_a', text: '你好', clientMessageId: 'msg_intent_abc123',
  })

  const failing = createChatTransport(async () => { throw new Error('offline') })
  assert.deepEqual(await failing({ dogId: 'dog_a', text: '你好', clientMessageId: 'k' }),
    { kind: 'retriable', reason: 'network' })
})

test('malformed successful receipts never become confirmed', () => {
  for (const key of ['id', 'dogId', 'text', 'createdAt']) {
    for (const value of [17, null, {}, [], true]) {
      assert.equal(interpretChatResponse(200, { ...OK_BODY, [key]: value }).kind, 'retriable')
    }
  }
  for (const patch of [{ id: ' ' }, { dogId: '' }, { createdAt: 'invalid' }, { createdAt: '' },
    { other: 'x', id: undefined }]) {
    assert.equal(interpretChatResponse(200, { ...OK_BODY, ...patch }).kind, 'retriable')
  }
})
