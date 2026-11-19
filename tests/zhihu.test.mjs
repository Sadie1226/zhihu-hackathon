import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createZhihuSearchClient, SEARCH_ENDPOINT } from '../lib/zhihu/client.ts'

// All HTTP data here is synthetic test input, never a live integration result.
const token = 'synthetic-test-credential'
const item = { Title: 'fixture title', ContentText: 'fixture excerpt',
  Url: 'https://www.zhihu.com/question/123/answer/456', AuthorityLevel: 2, VoteUpCount: 10 }
const success = items => ({ Code: 0, Message: 'fixture', Data: { Items: items, HasMore: false, SearchHashId: 'fixture' } })
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status })
function setup(handler, overrides = {}) {
  const calls = []
  const search = createZhihuSearchClient({ accessSecret: token, now: () => 1795046400123,
    fetch: async (...args) => { calls.push(args); return handler(...args) }, ...overrides })
  return { search, calls }
}

test('GET uses only the approved HTTPS endpoint, encoded query, Bearer and seconds timestamp', async () => {
  const { search, calls } = setup(() => reply(success([item])))
  const result = await search('想看雪 & 茶', 3)
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  const [url, options] = calls[0]
  assert.equal(url.origin + url.pathname, SEARCH_ENDPOINT)
  assert.equal(url.searchParams.get('Query'), '想看雪 & 茶')
  assert.equal(url.searchParams.get('Count'), '3')
  assert.equal(options.method, 'GET')
  assert.equal(options.headers.Authorization, `Bearer ${token}`)
  assert.equal(options.headers['X-Request-Timestamp'], '1795046400')
  assert.equal(options.cache, 'no-store')
  assert.equal(options.redirect, 'error')
  assert.ok(options.signal)
  assert.ok(!url.href.includes(token))
})

test('success maps only approved fields, preserves exact answer identity, strips highlight and ranks authority/votes', async () => {
  const { search } = setup(() => reply(success([
    { ...item, Title: '<em>fixture</em> &amp; text', ContentText: '<b>excerpt</b>', Author: { private: 'never return' } },
    { ...item, Url: 'https://zhuanlan.zhihu.com/p/789', AuthorityLevel: '4' },
    { ...item, Url: 'https://www.zhihu.com/question/123/answer/457?utm=share#comment', AuthorityLevel: 2, VoteUpCount: 100 },
  ])))
  const result = await search('fixture')
  assert.equal(result.ok, true)
  assert.deepEqual(result.items.map(row => row.sourceUrl), ['https://zhuanlan.zhihu.com/p/789',
    'https://www.zhihu.com/question/123/answer/457', item.Url])
  assert.equal(result.items[2].title, 'fixture & text')
  assert.equal(result.items[2].excerpt, 'excerpt')
  assert.ok(result.items.every(row => row.sourceMode === 'live'))
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['title', 'excerpt', 'sourceUrl', 'sourceMode', 'authorityLevel', 'voteUpCount'].sort())
  assert.ok(!JSON.stringify(result).includes('never return'))
  assert.deepEqual(result.responseFields.envelope, ['Code', 'Message', 'Data'])
})

test('empty successful response stays empty; missing optional fields are null and duplicate URLs deduplicated', async () => {
  const empty = setup(() => reply(success([])))
  assert.deepEqual((await empty.search('fixture')).items, [])
  const { search } = setup(() => reply(success([{ Title: 'fixture', Url: item.Url }, { Title: 'fixture', Url: item.Url }])))
  const result = await search('fixture')
  assert.equal(result.items.length, 1)
  for (const key of ['excerpt', 'authorityLevel', 'voteUpCount']) assert.equal(result.items[0][key], null)
})

test('all four live AuthorityLevel strings map to the existing numeric K enum', async () => {
  for (const level of [1, 2, 3, 4]) {
    const { search } = setup(() => reply(success([{ ...item, AuthorityLevel: String(level) }])))
    assert.equal((await search('fixture')).items[0].authorityLevel, level)
  }
})

test('empty credentials and invalid parameters never perform a request', async () => {
  for (const accessSecret of [undefined, '', '   ']) {
    const { search, calls } = setup(() => { throw new Error('unexpected') }, { accessSecret })
    const result = await search('fixture')
    assert.equal(result.error.code, 'AUTH'); assert.equal(result.alert, true)
    assert.equal(result.httpStatus, null); assert.equal(calls.length, 0)
  }
  const { search, calls } = setup(() => { throw new Error('unexpected') })
  for (const [query, count] of [['', 3], [' ', 3], [null, 3], ['x', 0], ['x', 11], ['x', 1.5]]) {
    assert.equal((await search(query, count)).error.code, 'CONFLICT')
  }
  assert.equal(calls.length, 0)
})

for (const [status, code, expected] of [[200, 20001, 'AUTH'], [200, '20001', 'AUTH'],
  [200, 30001, 'RATE_LIMITED'], [401, null, 'AUTH'], [403, null, 'AUTH'],
  [429, null, 'RATE_LIMITED'], [200, 10001, 'CONFLICT'], [500, null, 'NETWORK']]) {
  test(`HTTP ${status} / upstream ${code} maps to ${expected} without retry or credential reflection`, async () => {
    const { search, calls } = setup(() => reply({ Code: code, Message: token, Data: { secret: token } }, status))
    const result = await search('fixture')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, expected)
    assert.equal(result.error.retriable, expected === 'NETWORK')
    assert.equal(result.fallback, ['AUTH', 'RATE_LIMITED'].includes(expected) ? 'cache-or-fixture' : null)
    assert.equal(result.httpStatus, status)
    assert.equal(calls.length, 1)
    assert.ok(!JSON.stringify(result).includes(token))
    assert.ok(!('items' in result))
  })
}

test('network/abort/JSON failures are sanitized and never produce live results; non-JSON HTTP auth retains AUTH', async () => {
  for (const handler of [() => { throw new Error(`headers contain ${token}`) },
    () => { throw Object.assign(new Error(token), { name: 'TimeoutError' }) },
    () => new Response('not json'), () => reply({ Code: 0, Data: {} })]) {
    const { search, calls } = setup(handler)
    const result = await search('fixture')
    assert.equal(result.error.code, 'NETWORK')
    assert.equal(calls.length, 1)
    assert.ok(!JSON.stringify(result).includes(token))
    assert.ok(!('items' in result))
  }
  const auth = setup(() => new Response('not json', { status: 401 }))
  assert.equal((await auth.search('fixture')).error.code, 'AUTH')
})

test('malformed envelopes, metadata, unsafe URLs and secret reflections fail closed', async () => {
  const invalidRows = [{ ...item, Url: 'javascript:alert(1)' }, { ...item, Url: 'https://evil.test/answer/1' },
    { ...item, Url: 'http://www.zhihu.com/question/123' }, { ...item, Url: 'https://user@www.zhihu.com/question/1' },
    { ...item, Title: token }, { ...item, ContentText: token }, { ...item, Title: '<em></em>' },
    { ...item, Title: 'synthetic-<em>test</em>-credential' },
    { ...item, AuthorityLevel: 5 }, { ...item, AuthorityLevel: 'not-a-level' }, { ...item, VoteUpCount: -1 },
    { ...item, VoteUpCount: '10' }, { ...item, ContentText: {} }, null]
  for (const body of [null, [], {}, { Code: 0, Data: [] }, { Code: 0, Data: { Items: 'bad' } },
    { Code: 99999, Data: { Items: [] } }, ...invalidRows.map(row => success([row]))]) {
    const { search } = setup(() => reply(body))
    const result = await search('fixture')
    assert.equal(result.error.code, 'NETWORK')
    assert.ok(!('items' in result))
  }
})

test('bounded timeout uses injected AbortSignal without waiting in tests', async () => {
  for (const timeoutMs of [0, -1, Infinity, 60001, 1.5]) {
    assert.throws(() => createZhihuSearchClient({ accessSecret: token, timeoutMs }), /timeoutMs/)
  }
  const { search } = setup((_url, options) => {
    assert.equal(options.signal.aborted, false)
    throw new Error('simulated transport failure')
  }, { timeoutMs: 1 })
  assert.equal((await search('fixture')).error.code, 'NETWORK')
})

test('server entry has a server-only guard and reads env only there; client bundles cannot import it', () => {
  const source = readFileSync('lib/zhihu/index.ts', 'utf8')
  assert.match(source, /import 'server-only'/)
  assert.match(source, /process\.env\.ZHIHU_ACCESS_SECRET/)
  assert.doesNotMatch(readFileSync('lib/zhihu/client.ts', 'utf8'), /process\.env/)
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import './lib/zhihu/index.ts'"],
    { encoding: 'utf8', windowsHide: true })
  assert.notEqual(child.status, 0)
  assert.match(child.stderr, /Server Component/)
})
