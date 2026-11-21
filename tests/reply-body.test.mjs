// ReplyBody 可复用正文的纯逻辑回归：target 二选一映射、实例 key、失败分态文案。
// 与 app/(b)/b4-reply-body.tsx 共用同一份 utils，不产生两套口径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  targetField, targetKey, readableUploadError, readableReplyError,
} from '../app/(b)/b4-reply-body-utils.ts'

test('invitation target maps to exactly one business source field', () => {
  assert.deepEqual(targetField({ invitationId: 'inv-1' }), { invitationId: 'inv-1' })
  assert.equal('exchangeId' in targetField({ invitationId: 'inv-1' }), false)
})

test('exchange target maps to exactly one business source field', () => {
  assert.deepEqual(targetField({ exchangeId: 'ex-1' }), { exchangeId: 'ex-1' })
  assert.equal('invitationId' in targetField({ exchangeId: 'ex-1' }), false)
})

test('target key is stable and distinct per source', () => {
  assert.equal(targetKey({ invitationId: 'inv-1' }), 'i:inv-1')
  assert.equal(targetKey({ exchangeId: 'ex-1' }), 'e:ex-1')
  assert.notEqual(targetKey({ invitationId: 'same' }), targetKey({ exchangeId: 'same' }))
})

test('upload failures map to actionable, non-blaming messages', () => {
  assert.match(readableUploadError(413), /1600/)
  assert.match(readableUploadError(415), /格式/)
  assert.match(readableUploadError(401), /会话/)
  assert.match(readableUploadError(500), /再试一次/)
})

test('reply failures keep draft and distinguish conflict', () => {
  assert.match(readableReplyError(404), /不在当前会话/)
  assert.match(readableReplyError(409), /还没到可以回应/)
  assert.match(readableReplyError(500), /文字和图都还在/)
})

test('no blaming words in user-visible error copy', () => {
  const banned = /连续|打卡|天数|坚持|别忘|快回来|还剩|已过期|差一点|加油|你还没|已经很久|太棒/
  for (const status of [400, 401, 403, 404, 409, 413, 415, 500]) {
    assert.doesNotMatch(readableUploadError(status), banned)
    assert.doesNotMatch(readableReplyError(status), banned)
  }
})
