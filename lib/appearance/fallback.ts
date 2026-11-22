import { ImageProviderError } from './generate.ts'
import type { GenerateImage, ProviderFailure } from './generate.ts'
import type { AssetReference, AssetStorage } from './storage.ts'

type Result =
  | { status: 'generated'; level: 0; asset: AssetReference; attempts: number; mode: 'mock' | 'live' }
  | { status: 'dog-image'; level: 2; asset: AssetReference; reason: ProviderFailure }
  | { status: 'text-only'; level: 3; reason: ProviderFailure }

/** Only a character Moment can offer the same dog's approved, persisted still image. */
export async function generateWithFallback(
  generate: GenerateImage,
  storage: AssetStorage,
  job: Parameters<GenerateImage>[0],
): Promise<Result> {
  let momentDog: AssetReference | undefined
  try {
    return { status: 'generated', level: 0, ...await generate(job, asset => { momentDog = asset }) }
  } catch (error) {
    const reason = error instanceof ImageProviderError ? error.reason : 'unavailable'
    if (job.kind === 'moment' && momentDog?.kind === 'dog' &&
        !['blocked', 'invalid-source', 'rate-limited', 'quota'].includes(reason)) {
      const stored = await storage.read(momentDog).catch(() => null)
      if (stored?.record.provenance.mappingStatus === 'approved') {
        return { status: 'dog-image', level: 2, asset: momentDog, reason }
      }
    }
    return { status: 'text-only', level: 3, reason }
  }
}
