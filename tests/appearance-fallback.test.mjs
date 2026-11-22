import assert from 'node:assert/strict'
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { createImageGenerator, ImageProviderError } from '../lib/appearance/generate.ts'
import { generateWithFallback } from '../lib/appearance/fallback.ts'
import { createLocalAssetStorage, storeDogComposition } from '../lib/appearance/storage.ts'
import { assemblyFixture, fixtureDirectory, rgbaPng } from './helpers/appearance-fixtures.mjs'

const jobs = {
  gift: { kind: 'gift', source: { kind: 'exchange', id: 'test-exchange' } },
  moment: { kind: 'moment', source: { kind: 'trip', id: 'test-trip' } },
  scene: { kind: 'scene', source: { kind: 'scene', id: 'test-scene' } },
}
const catalog = {
  gifts: { boat: { name: '小纸船', subject: '一只折好的纸船' } },
  moment: { scene: '纸船过水', subject: '纸船', action: '漂过水面', water: '浅水' },
}
const facts = {
  gift: { kind: 'gift', item: 'boat', blockedTopics: [] },
  moment: { kind: 'moment', theme: 'scene', subject: 'subject', action: 'action', details: ['water'], blockedTopics: [] },
  scene: { kind: 'scene', place: 'beijingRoad', blockedTopics: [] },
}
const provider = (generate, mode = 'mock') => ({ mode, name: 'test-provider', model: 'fake-v1', generate })
const opaque = (width, height) => sharp({ create: { width, height, channels: 3, background: '#445566' } }).png().toBuffer()

async function setup(t) {
  const root = await fixtureDirectory(t)
  const storage = await createLocalAssetStorage(root)
  const make = (selectedProvider, change = {}) => createImageGenerator({
    provider: selectedProvider, storage, catalog,
    loadFacts: async source => facts[Object.keys(jobs).find(key => jobs[key].source.id === source.id)] ?? null,
    ...change,
  })
  return { root, storage, make }
}

test('mock Gift/Moment/Scene use fixed templates, structured slots, dimensions and provenance', async t => {
  const { root, storage, make } = await setup(t)
  const seen = []
  const generate = make(provider(async request => {
    const { kind, size, format, prompt, reference } = request
    seen.push(kind)
    assert.equal(reference, undefined)
    assert.equal(format, 'png')
    if (kind === 'gift') {
      assert.match(prompt, /真透明背景/)
      assert.match(prompt, /礼物名称：小纸船/)
      return rgbaPng(64, 64, [[10, 10, [255, 0, 0, 255]]])
    }
    if (kind === 'scene') {
      assert.match(prompt, /广州北京路/)
      assert.match(prompt, /固定平视视角/)
      assert.doesNotMatch(prompt, /商业街人流/)
      assert.deepEqual(size, { width: 750, height: 640 })
    }
    if (kind === 'moment') {
      assert.match(prompt, /漂过水面/)
      assert.match(prompt, /角色参与：否/)
      assert.equal(Math.max(size.width, size.height), 1200)
    }
    return opaque(size.width, size.height)
  }))
  for (const job of Object.values(jobs)) {
    const result = await generateWithFallback(generate, storage, job)
    assert.equal(result.status, 'generated')
    assert.equal(result.attempts, 1)
    assert.equal(result.mode, 'mock')
    const { bytes, record } = await storage.read(result.asset)
    assert.equal((await sharp(bytes).metadata()).format, 'webp')
    const original = await readFile(join(root, result.asset.id, 'original.png'))
    assert.equal((await sharp(original).metadata()).format, 'png')
    assert.equal(record.provenance.sourceId, job.source.id)
    assert.equal(record.provenance.mode, 'mock')
    assert.equal(record.provenance.model, 'fake-v1')
    assert.match(record.provenance.promptHash, /^[0-9a-f]{64}$/)
  }
  assert.deepEqual(seen, ['gift', 'moment', 'scene'])
})

test('a temporary provider failure retries once and duplicate jobs reuse persisted output', async t => {
  const { make } = await setup(t)
  let calls = 0
  const mock = provider(async () => {
    if (++calls === 1) throw new ImageProviderError('temporary')
    return rgbaPng(64, 64, [[10, 10, [255, 0, 0, 255]]])
  })
  const generate = make(mock)
  const results = await Promise.all([generate(jobs.gift), generate(jobs.gift)])
  assert.deepEqual(results[0].asset, results[1].asset)
  assert.equal(calls, 2)
  assert.deepEqual(results.map(result => result.attempts).sort(), [0, 2])
  const retry = await make(mock)(jobs.gift)
  assert.equal(retry.attempts, 0)
  assert.deepEqual(retry.asset, results[0].asset)
  assert.equal(calls, 2)
})

test('exhausted retry falls back to a verified dog file only for its character Moment', async t => {
  const { root, storage, make } = await setup(t)
  const { input } = await assemblyFixture()
  // This synthetic fixture exercises the approved-manifest branch without promoting any actual asset.
  const dog = await storeDogComposition(storage, { ...input, mapping: { ...input.mapping, status: 'approved' } })
  let calls = 0
  const generate = make(provider(async ({ reference }) => {
    calls++
    assert.ok(reference?.length)
    throw new ImageProviderError('temporary')
  }), { loadFacts: async () => ({ ...facts.moment, dog }) })
  assert.deepEqual(await generateWithFallback(generate, storage, jobs.moment),
    { status: 'dog-image', level: 2, reason: 'temporary', asset: dog })
  assert.equal(calls, 2)
  await unlink(join(root, dog.id, 'image.webp'))
  assert.equal((await generateWithFallback(generate, storage, jobs.moment)).status, 'text-only')
  assert.equal(calls, 2)
})

test('hard failures, policy rejects and timeouts make no successful-looking asset', async t => {
  const { root, storage, make } = await setup(t)
  for (const reason of ['auth', 'rate-limited', 'quota']) {
    let calls = 0
    const generate = make(provider(async () => { calls++; throw new ImageProviderError(reason) }))
    assert.deepEqual(await generateWithFallback(generate, storage, jobs.scene), { status: 'text-only', level: 3, reason })
    assert.equal(calls, 1)
  }
  let calls = 0
  const mock = provider(async () => { calls++; return new Promise(() => {}) })
  assert.deepEqual(await generateWithFallback(make(mock, { timeoutMs: 15 }), storage, jobs.gift),
    { status: 'text-only', level: 3, reason: 'timeout' })
  assert.equal(calls, 1)
  for (const [job, loaded, reason] of [
    [jobs.gift, { ...facts.gift, item: 'unreviewed user text' }, 'invalid-source'],
    [jobs.gift, { ...facts.gift, blockedTopics: ['纸船'] }, 'blocked'],
    [jobs.scene, { ...facts.scene, place: 'anywhere' }, 'invalid-source'],
    [jobs.moment, { ...facts.moment, details: ['water', 'water', 'water', 'water'] }, 'invalid-source'],
  ]) {
    assert.deepEqual(await generateWithFallback(make(mock, { loadFacts: async () => loaded }), storage, job),
      { status: 'text-only', level: 3, reason })
  }
  assert.equal((await generateWithFallback(make(provider(mock.generate, 'live')), storage, jobs.moment)).reason, 'template-pending')
  assert.equal((await generateWithFallback(make(undefined), storage, jobs.gift)).reason, 'unavailable')
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(root), [])
})

test('rejects false transparency, softened icon alpha, clipped icons and incorrect PNG formats', async t => {
  const { root, storage, make } = await setup(t)
  for (const bytes of [await opaque(64, 64), await rgbaPng(64, 64, [[3, 3, [2, 3, 4, 127]]]),
    await rgbaPng(64, 64, [[0, 0, [2, 3, 4, 255]]]), await rgbaPng(32, 64, [[3, 3, [2, 3, 4, 255]]]),
    await sharp(await opaque(64, 64)).webp().toBuffer()]) {
    const result = await generateWithFallback(make(provider(async () => bytes)), storage, jobs.gift)
    assert.deepEqual(result, { status: 'text-only', level: 3, reason: 'invalid-output' })
  }
  const transparent = await rgbaPng(750, 640, [[3, 3, [2, 3, 4, 255]]])
  assert.equal((await generateWithFallback(make(provider(async () => transparent)), storage, jobs.scene)).reason, 'invalid-output')
  assert.deepEqual(await readdir(root), [])
})

test('a filesystem failure after provider success returns text-only without an asset reference', async t => {
  const { root, storage, make } = await setup(t)
  const moved = join(root, 'moved')
  // Keep the sabotage inside the disposable fixture directory.
  const cache = join(root, 'cache')
  const local = await createLocalAssetStorage(cache)
  const generate = make(provider(async () => {
    const valid = await rgbaPng(64, 64, [[10, 10, [255, 0, 0, 255]]])
    await rename(cache, moved)
    await writeFile(cache, 'fixture blocks directory creation')
    return valid
  }), { storage: local })
  const result = await generateWithFallback(generate, storage, jobs.gift)
  assert.deepEqual(result, { status: 'text-only', level: 3, reason: 'storage' })
  assert.deepEqual(await readdir(moved), [])
})
