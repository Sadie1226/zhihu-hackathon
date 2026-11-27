import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto as crypto } from 'node:crypto'
import { createRequestId } from '../lib/adoption/request-id.ts'

test('HTTP-compatible secure random fallback makes RFC4122 version/variant IDs', () => {
  const fake = { getRandomValues: bytes => { bytes.fill(255); return bytes } }
  assert.equal(createRequestId(fake), 'ffffffff-ffff-4fff-bfff-ffffffffffff')
  assert.notEqual(createRequestId({ getRandomValues: crypto.getRandomValues.bind(crypto) }),
    createRequestId({ getRandomValues: crypto.getRandomValues.bind(crypto) }))
})
test('native path is used and unavailable entropy fails explicitly', () => {
  assert.equal(createRequestId({ randomUUID: () => 'native-id' }), 'native-id')
  assert.throws(() => createRequestId({}), /无法安全创建/)
})
