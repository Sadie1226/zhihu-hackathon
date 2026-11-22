import { boundedImage, hashBytes, maxImageBytes, processingVersion, validIdentifier, validateDimensions } from './assets.ts'
import type { Dimensions } from './assets.ts'
import { giftPrompt, momentComposition, momentStyle, sceneComposition, sceneStyle } from './prompts.ts'
import type { AssetReference, AssetStorage } from './storage.ts'

const scenes = {
  kanas: ['阿勒泰·喀纳斯', '高山湖泊、远处雪山、针叶林与草甸，湖水蓝绿，开阔清爽；避免热带湖。'],
  tianchi: ['长白山天池', '高海拔火山口湖、环形山脊、冷蓝湖面与山地森林；突出环形火山地貌，不画成普通海湾。'],
  sanya: ['三亚海滩', '热带海岸、沙滩、椰树与海水，明亮柔和暖光；角色站立区保留足够描边对比。'],
  beijingRoad: ['广州北京路', '岭南商业街、相连的骑楼柱廊；招牌只使用抽象色块。'],
  nantou: ['深圳南头古城', '城门洞、城墙、灰砖巷道与巷弄纵深，岭南传统建筑融合现代城市细节；不得画成北方宫殿或普通骑楼商业街。'],
  nightCorner: ['深夜街角', '安静城市街角、便利店或小店暖灯、冷蓝夜色与暖光对比；不恐怖、不压抑、不出现可读店招。'],
} as const

type SourceKind = 'exchange' | 'trip' | 'find' | 'event' | 'scene' | 'fixture'
export type Source = Readonly<{ kind: SourceKind; id: string }>
type Job = { kind: 'gift' | 'moment' | 'scene'; source: Source }

/** Facts come from a trusted server lookup. Slot keys index reviewed, static catalogs. */
export type GenerationFacts = { blockedTopics: readonly string[] } & (
  | { kind: 'gift'; item: string }
  | { kind: 'moment'; theme: string; subject: string; action: string; details: readonly string[]; dog?: AssetReference }
  | { kind: 'scene'; place: keyof typeof scenes }
)
type Catalog = Readonly<{
  gifts: Readonly<Record<string, Readonly<{ name: string; subject: string }>>>
  moment: Readonly<Record<string, string>>
}>
export type ProviderFailure = 'temporary' | 'timeout' | 'auth' | 'rate-limited' | 'quota' | 'invalid-output' |
  'unavailable' | 'template-pending' | 'blocked' | 'invalid-source' | 'storage'
export class ImageProviderError extends Error {
  readonly reason: ProviderFailure
  constructor(reason: ProviderFailure) {
    super(reason)
    this.reason = reason
  }
}
export type ProviderRequest = Readonly<{
  kind: Job['kind']
  prompt: string
  size: Dimensions
  format: 'png'
  reference?: Buffer
  signal: AbortSignal
}>
export type ImageProvider = Readonly<{
  mode: 'mock' | 'live'
  name: string
  model: string
  generate: (request: ProviderRequest) => Promise<Buffer>
}>
type Options = Readonly<{
  storage: AssetStorage
  provider?: ImageProvider
  catalog: Catalog
  loadFacts: (source: Source) => Promise<GenerationFacts | null>
  timeoutMs?: number
}>

function reject(reason: ProviderFailure): never { throw new ImageProviderError(reason) }
function lookup<T>(catalog: Readonly<Record<string, T>>, key: string): T {
  if (!validIdentifier(key) || !Object.hasOwn(catalog, key)) reject('invalid-source')
  return catalog[key]
}
function checkTopics(topics: readonly string[], values: readonly string[]) {
  const normalized = values.join('\n').normalize('NFKC').toLowerCase()
  if (topics.some(topic => topic.trim() && normalized.includes(topic.normalize('NFKC').trim().toLowerCase()))) {
    reject('blocked')
  }
}

async function buildRequest(facts: GenerationFacts, options: Options) {
  const { storage, catalog } = options
  if (facts.kind === 'gift') {
    const { name, subject } = lookup(catalog.gifts, facts.item)
    checkTopics(facts.blockedTopics, [name, subject])
    return { size: { width: 64, height: 64 }, template: 'E11-v2-gift',
      prompt: `${giftPrompt}\n礼物名称：${name}\n礼物主体：${subject}`, mappingVersion: 'none' }
  }
  if (facts.kind === 'scene') {
    const [name, visual] = lookup(scenes, facts.place)
    checkTopics(facts.blockedTopics, [name, visual])
    return { size: { width: 750, height: 640 }, template: 'E11-v2-scene-candidate',
      prompt: `${sceneStyle}\n${sceneComposition}\n地点：${name}。\n${visual}`, mappingVersion: 'none' }
  }
  if (!Array.isArray(facts.details) || facts.details.length > 3) reject('invalid-source')
  const [theme, subject, action, ...details] = [facts.theme, facts.subject, facts.action, ...facts.details]
    .map(key => lookup(catalog.moment, key))
  checkTopics(facts.blockedTopics, [theme, subject, action, ...details])
  if (facts.dog && facts.dog.kind !== 'dog') reject('invalid-source')
  const dog = facts.dog ? await storage.read(facts.dog).catch(() => reject('invalid-source')) : null
  if (facts.dog && !dog) reject('invalid-source')
  return { size: { width: 1200, height: 800 }, template: 'E11-v2-moment-candidate',
    prompt: `${momentStyle}\n${momentComposition}\n瞬间主题：${theme}\n主体对象：${subject}\n关键动作：${action}` +
      `\n环境细节：${details.join('、') || '无'}\n角色参与：${dog ? '是' : '否'}`,
    reference: dog?.bytes, mappingVersion: dog?.record.provenance.mappingVersion ?? 'none' }
}

async function validatePng(bytes: Buffer, kind: Job['kind'], size: Dimensions): Promise<Buffer> {
  const image = boundedImage(bytes)
  const { format, width, height, hasAlpha, channels, pages = 1 } = await image.metadata()
  if (format !== 'png' || !width || !height || pages !== 1) reject('invalid-output')
  validateDimensions({ width, height })
  if (kind === 'moment' ? Math.max(width, height) !== 1200 : width !== size.width || height !== size.height) {
    reject('invalid-output')
  }
  if (kind === 'gift' && (!hasAlpha || channels !== 4)) reject('invalid-output')
  if (hasAlpha) {
    const alpha = await image.clone().toColourspace('srgb').extractChannel('alpha').raw().toBuffer()
    if (kind === 'gift') {
      if (!alpha.includes(0) || !alpha.includes(255) || alpha.some(value => value !== 0 && value !== 255)) {
        reject('invalid-output')
      }
      for (let i = 0; i < width; i++) {
        if (alpha[i] || alpha[(height - 1) * width + i] || alpha[i * width] || alpha[i * width + width - 1]) {
          reject('invalid-output')
        }
      }
    } else if (alpha.some(value => value !== 255)) reject('invalid-output')
  }
  return image.webp({ lossless: true }).toBuffer()
}

export function createImageGenerator(options: Options) {
  const { provider, storage, loadFacts, timeoutMs = 30_000 } = options
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Invalid provider timeout')
  if (provider && (!validIdentifier(provider.name) || !validIdentifier(provider.model) ||
      !['mock', 'live'].includes(provider.mode))) throw new Error('Invalid provider configuration')

  return async function generate(job: Job, onFallbackDog?: (asset: AssetReference) => void) {
    if (!validIdentifier(job.source.id)) reject('invalid-source')
    const facts = await loadFacts(job.source)
    if (!facts || facts.kind !== job.kind || (job.source.kind === 'fixture' && provider?.mode === 'live')) {
      reject('invalid-source')
    }
    const approvedSource = facts.kind === 'gift' ? job.source.kind === 'exchange' :
      facts.kind === 'scene' ? job.source.kind === 'scene' : ['trip', 'find', 'event'].includes(job.source.kind)
    if (!approvedSource && job.source.kind !== 'fixture') reject('invalid-source')
    const { prompt, size, template, reference, mappingVersion } = await buildRequest(facts, options)
    if (facts.kind === 'moment') {
      if (facts.dog) onFallbackDog?.(facts.dog)
      if (provider?.mode === 'live') reject('template-pending')
    }
    if (!provider) return reject('unavailable')
    const promptHash = hashBytes(prompt)
    const referenceHash = reference ? hashBytes(reference) : 'none'
    const id = hashBytes(JSON.stringify([processingVersion, template, job.source.kind, job.source.id, job.kind, size,
      mappingVersion, promptHash, referenceHash, provider.mode, provider.name, provider.model]))
    let attempts = 0
    const asset = await storage.getOrCreate(id, job.kind, async () => {
      let original: Buffer
      for (;;) {
        attempts++
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const { signal } = controller
        try {
          original = await new Promise<Buffer>((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new ImageProviderError('timeout')), { once: true })
            void Promise.resolve().then(() => provider.generate({
              kind: job.kind, prompt, size, format: 'png', reference: reference && Buffer.from(reference), signal,
            })).then(resolve, reject)
          })
          break
        } catch (error) {
          if (!(error instanceof ImageProviderError)) return reject('unavailable')
          if (error.reason !== 'temporary' || attempts >= 2) throw error
        } finally {
          clearTimeout(timer)
        }
      }
      if (!Buffer.isBuffer(original)) return reject('invalid-output')
      if (original.length === 0 || original.length > maxImageBytes) return reject('invalid-output')
      original = Buffer.from(original)
      const bytes = await validatePng(original, job.kind, size).catch(() => reject('invalid-output'))
      return {
        bytes, original,
        provenance: { sourceKind: job.source.kind, sourceId: job.source.id, template, mappingVersion, promptHash,
          referenceHash, provider: provider.name, model: provider.model, mode: provider.mode },
      }
    }).catch((error: unknown) => {
      if (error instanceof ImageProviderError) throw error
      return reject('storage')
    })
    return { asset, attempts, mode: provider.mode }
  }
}

export type GenerateImage = ReturnType<typeof createImageGenerator>
