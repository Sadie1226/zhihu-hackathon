import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { boundedImage, hashBytes, maxImageBytes, normalizeLegacyAccessories } from '../lib/appearance/assets.ts'
import { composeDog } from '../lib/appearance/compose.ts'
import { createLocalAssetStorage, storeDogComposition } from '../lib/appearance/storage.ts'
import { assemblyFixture, fixtureDirectory, readPixels } from './helpers/appearance-fixtures.mjs'

test('synthetic full stack follows explicit placement, alpha, layer order and nearest-neighbor pixels', async () => {
  const { input, white, blue, green, red, gold } = await assemblyFixture()
  const result = await composeDog(input)
  const metadata = await sharp(result.bytes).metadata()
  assert.deepEqual([metadata.format, metadata.width, metadata.height, metadata.hasAlpha], ['webp', 5, 5, true])
  const { pixel } = await readPixels(result.bytes)
  assert.deepEqual(pixel(1, 1), white)
  assert.deepEqual(pixel(2, 1), blue)
  assert.deepEqual(pixel(1, 2), green)
  assert.deepEqual(pixel(3, 3), red)
  assert.deepEqual(pixel(0, 0), [0, 0, 0, 0])
  const bare = normalizeLegacyAccessories({ ...input.assembly, glasses: 'none', hat: 'none' })
  const noGlasses = await composeDog({ ...input, assembly: { ...input.assembly, glasses: null } })
  assert.deepEqual((await readPixels(noGlasses.bytes)).pixel(1, 1), gold)
  const noAccessories = await composeDog({ ...input, assembly: bare })
  assert.deepEqual((await readPixels(noAccessories.bytes)).pixel(1, 1), blue)
  const repeated = await composeDog({ ...input, assembly: { ...input.assembly } })
  assert.equal(result.id, repeated.id)
  assert.equal(result.sha256, repeated.sha256)
  assert.deepEqual((await readPixels(result.bytes)).data, (await readPixels(repeated.bytes)).data)
  const enlarged = await composeDog({ ...input, options: { format: 'webp', size: { width: 10, height: 10 } } })
  const scaledPixels = await readPixels(enlarged.bytes)
  assert.deepEqual(scaledPixels.pixel(2, 2), white)
  assert.deepEqual(scaledPixels.pixel(3, 3), white)
  assert.deepEqual(scaledPixels.pixel(4, 2), blue)
  assert.notEqual(enlarged.id, result.id)
  const scaledLayer = { ...input.mapping.cloth.hoodie, scale: 2 }
  const withScaledLayer = await composeDog({ ...input, assembly: bare,
    mapping: { ...input.mapping, cloth: { hoodie: scaledLayer } } })
  assert.deepEqual((await readPixels(withScaledLayer.bytes)).pixel(2, 2), green)
})

test('compositor refuses unknown enum, missing layer, traversal, wrong geometry or invalid PNG', async () => {
  const { input, sources } = await assemblyFixture()
  for (const assembly of [{ ...input.assembly, cloth: 'unknown' }, { ...input.assembly, hat: 'none' },
    { ...input.assembly, private: true }]) {
    await assert.rejects(composeDog({ ...input, assembly }), /Assembly/)
  }
  await assert.rejects(composeDog({ ...input, mapping: { ...input.mapping, cloth: {} } }), /cloth asset/)
  for (const [change, error] of [
    [{ asset: '../body' }, /body asset/], [{ left: 2 }, /placement/], [{ scale: 1.5 }, /placement/],
    [{ height: 3 }, /dimensions/],
  ]) await assert.rejects(composeDog({ ...input, mapping: { ...input.mapping, body: { ...input.mapping.body, ...change } } }), error)
  await assert.rejects(composeDog({ ...input, options: { format: 'webp', size: { width: 6, height: 5 } } }), /integer/)
  const opaque = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer()
  for (const body of [opaque, await sharp(sources.body).jpeg().toBuffer(), Buffer.alloc(maxImageBytes + 1)]) {
    await assert.rejects(composeDog({ ...input, resolveAsset: async key => key === 'body' ? body : sources[key] }))
  }
})

test('private storage reuses output, atomically resolves concurrent writers and survives another process', async t => {
  const root = await fixtureDirectory(t)
  const { input } = await assemblyFixture()
  const storage = await createLocalAssetStorage(root)
  const another = await createLocalAssetStorage(root)
  const refs = await Promise.all([storage, storage, another].map(adapter => storeDogComposition(adapter, input)))
  const [ref] = refs
  assert.ok(refs.every(value => value.sha256 === ref.sha256 && value.id === ref.id))
  assert.deepEqual(await readdir(root), [ref.id])
  const stored = await storage.read(ref)
  assert.equal(stored.record.provenance.mappingStatus, 'synthetic')
  const path = join(root, ref.id, 'image.webp')
  const before = (await stat(path)).mtimeMs
  assert.deepEqual(await storeDogComposition(storage, input), ref)
  assert.equal((await stat(path)).mtimeMs, before)
  const program = `import { createLocalAssetStorage } from './lib/appearance/storage.ts';
    const storage = await createLocalAssetStorage(process.argv[1]);
    const file = await storage.read(JSON.parse(process.argv[2]));
    process.stdout.write(file.record.sha256);`
  const reopened = execFileSync(process.execPath, ['--input-type=module', '-e', program, root, JSON.stringify(ref)], { encoding: 'utf8' })
  assert.equal(reopened, ref.sha256)
  await assert.rejects(storage.read({ ...ref, id: '../bad' }), /Invalid asset identifier/)
  await assert.rejects(createLocalAssetStorage('public/c14-private'), /private/)
  await truncate(path, maxImageBytes + 1)
  await assert.rejects(storage.read(ref), /size/)
  await assert.rejects(storeDogComposition(storage, input), /size/)
})

test('archived neutral front body decodes and converts to WebP for diagnosis', async () => {
  const png = await readFile('public/assets/dogs/kanshan-neutral-v1/body-front-neutral.png')
  const image = boundedImage(png)
  const source = await image.metadata()
  assert.deepEqual([source.format, source.width, source.height, source.hasAlpha], ['png', 1024, 1024, true])
  const converted = await image.webp({ lossless: true }).toBuffer()
  const { width, height, format, hasAlpha } = await sharp(converted).metadata()
  assert.deepEqual([width, height, format, hasAlpha], [1024, 1024, 'webp', true])
  const decoded = await readPixels(converted)
  const original = await readPixels(png)
  for (let i = 0; i < original.data.length; i += 4) {
    const alpha = original.data[i + 3]
    assert.equal(decoded.data[i + 3], alpha)
    if (alpha) assert.deepEqual(decoded.data.subarray(i, i + 3), original.data.subarray(i, i + 3))
  }
  if (process.env.C14_SAMPLE_OUTPUT === '1') {
    const folder = '.local/c14-samples'
    await mkdir(folder, { recursive: true })
    const { input } = await assemblyFixture()
    const sample = await composeDog(input)
    await writeFile(join(folder, 'synthetic-assembly.webp'), sample.bytes)
    await writeFile(join(folder, 'neutral-body-diagnostic.webp'), converted)
    console.log(`C14 samples: synthetic 5×5 ${sample.sha256}; neutral 1024×1024 ${hashBytes(converted)}`)
  }
})
