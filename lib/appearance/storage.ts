import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { boundedImage, hashBytes, maxImageBytes, processingVersion, validateDimensions } from './assets.ts'
import type { Dimensions } from './assets.ts'
import { prepareComposition } from './compose.ts'
import type { CompositionInput } from './compose.ts'

export type AssetKind = 'dog' | 'gift' | 'moment' | 'scene'
export type AssetReference = Readonly<{ id: string; kind: AssetKind; sha256: string } & Dimensions>
type Provenance = Readonly<Record<string, string>>
type Artifact = { bytes: Buffer; original?: Buffer; provenance: Provenance }
type AssetRecord = AssetReference & {
  processing: string
  provenance: Provenance
  originalHash?: string
}
type StoredFile = { record: AssetRecord; bytes: Buffer }
const digest = /^[0-9a-f]{64}$/
const kinds = ['dog', 'gift', 'moment', 'scene']

function reference({ id, kind, sha256, width, height }: AssetRecord): AssetReference {
  return { id, kind, sha256, width, height }
}

function under(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
}

async function readBounded(path: string, limit: number): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) throw new Error('Expected a private regular file')
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    if (!size || size > limit) throw new Error('Invalid stored file size')
    const buffer = Buffer.alloc(size + 1)
    let position = 0
    while (position < buffer.length) {
      const { bytesRead } = await file.read(buffer, position, buffer.length - position, position)
      if (!bytesRead) break
      position += bytesRead
    }
    if (position !== size) throw new Error('Stored file changed during read')
    return buffer.subarray(0, size)
  } finally { await file.close() }
}

/** Configure only on the server with a dedicated, private state directory. */
export async function createLocalAssetStorage(directory: string) {
  const publicRoot = resolve('public')
  const target = resolve(directory)
  if (under(publicRoot, target)) throw new Error('Asset storage must be private')
  await mkdir(target, { recursive: true, mode: 0o700 })
  const root = await realpath(target)
  const realPublic = await realpath(publicRoot)
  if (under(realPublic, root)) throw new Error('Asset storage must be private')
  const pending = new Map<string, Promise<AssetRecord>>()

  async function load(id: string, kind: AssetKind): Promise<StoredFile | null> {
    if (!digest.test(id) || !kinds.includes(kind)) throw new Error('Invalid asset identifier')
    const dir = join(root, id)
    const entry = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!entry) return null
    if (!entry.isDirectory()) throw new Error('Invalid asset directory')
    const record = JSON.parse((await readBounded(join(dir, 'record.json'), 8192)).toString('utf8')) as AssetRecord
    if (record.id !== id || record.kind !== kind || !digest.test(record.sha256) || !record.provenance ||
        typeof record.provenance !== 'object' || !record.processing) throw new Error('Invalid asset metadata')
    validateDimensions(record)
    const bytes = await readBounded(join(dir, 'image.webp'), maxImageBytes)
    if (hashBytes(bytes) !== record.sha256) throw new Error('Asset integrity check failed')
    if (record.originalHash) {
      const original = await readBounded(join(dir, 'original.png'), maxImageBytes)
      if (hashBytes(original) !== record.originalHash) throw new Error('Original image integrity check failed')
    }
    return { record, bytes }
  }

  async function persist(id: string, kind: AssetKind, produce: () => Promise<Artifact>): Promise<AssetRecord> {
    const existing = await load(id, kind)
    if (existing) return existing.record
    const { bytes, original, provenance } = await produce()
    const { format, width, height } = await boundedImage(bytes).metadata()
    if (format !== 'webp' || !width || !height) throw new Error('Expected WebP output')
    validateDimensions({ width, height })
    if (original) boundedImage(original)
    const record: AssetRecord = {
      id, kind, sha256: hashBytes(bytes), width, height, processing: processingVersion, provenance,
      ...(original ? { originalHash: hashBytes(original) } : {}),
    }
    const manifest = JSON.stringify(record)
    if (Buffer.byteLength(manifest) > 8192) throw new Error('Asset metadata too large')
    const temp = await mkdtemp(join(root, '.pending-'))
    try {
      await writeFile(join(temp, 'image.webp'), bytes, { flag: 'wx', mode: 0o600 })
      if (original) await writeFile(join(temp, 'original.png'), original, { flag: 'wx', mode: 0o600 })
      await writeFile(join(temp, 'record.json'), manifest, { flag: 'wx', mode: 0o600 })
      try {
        await rename(temp, join(root, id))
        return record
      } catch (error) {
        const winner = await load(id, kind)
        if (!winner) throw error
        return winner.record
      }
    } finally { await rm(temp, { recursive: true, force: true }) }
  }

  return {
    async getOrCreate(id: string, kind: AssetKind, produce: () => Promise<Artifact>): Promise<AssetReference> {
      if (!digest.test(id) || !kinds.includes(kind)) throw new Error('Invalid asset identifier')
      let task = pending.get(id)
      if (!task) {
        task = persist(id, kind, produce)
        pending.set(id, task)
      }
      try {
        const record = await task
        if (record.kind !== kind) throw new Error('Asset type does not match')
        return reference(record)
      } finally {
        if (pending.get(id) === task) pending.delete(id)
      }
    },
    async read(asset: AssetReference): Promise<StoredFile | null> {
      const file = await load(asset.id, asset.kind)
      if (file && (file.record.sha256 !== asset.sha256 || file.record.width !== asset.width ||
          file.record.height !== asset.height)) throw new Error('Asset reference does not match')
      return file
    },
  }
}

export type AssetStorage = Awaited<ReturnType<typeof createLocalAssetStorage>>

export async function storeDogComposition(storage: AssetStorage, input: CompositionInput): Promise<AssetReference> {
  const dog = await prepareComposition(input)
  return storage.getOrCreate(dog.id, 'dog', async () => ({
    bytes: await dog.render(),
    provenance: { mappingVersion: dog.mappingVersion, mappingStatus: dog.mappingStatus },
  }))
}
