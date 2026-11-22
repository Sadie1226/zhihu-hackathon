import sharp from 'sharp'
import { boundedImage, hashBytes, placedLayers, processingVersion, validateDimensions } from './assets.ts'
import type { AssetMapping, CompositionAssembly, Dimensions, ResolveAsset } from './assets.ts'

export type CompositionOptions = Readonly<{ format: 'webp'; size: Dimensions }>
export type CompositionInput = Readonly<{
  assembly: CompositionAssembly
  mapping: AssetMapping
  options: CompositionOptions
  resolveAsset: ResolveAsset
}>

export async function prepareComposition({ assembly, mapping, options, resolveAsset }: CompositionInput) {
  const { width, height } = mapping.canvas
  const output = { width: options.size.width, height: options.size.height }
  validateDimensions(output)
  const scale = output.width / width
  if (options.format !== 'webp' || !Number.isSafeInteger(scale) || scale < 1 || height * scale !== output.height) {
    throw new Error('Output must be WebP at a matching integer canvas scale')
  }
  const entries = placedLayers(assembly, mapping)
  const mappingVersion = mapping.version
  const mappingStatus = mapping.status
  const layers = await Promise.all(entries.map(async ([layer, placement]) => {
    const source = await resolveAsset(placement.asset)
    boundedImage(source)
    const bytes = Buffer.from(source)
    const metadata = await boundedImage(bytes).metadata()
    if (metadata.format !== 'png' || !metadata.hasAlpha || (metadata.pages ?? 1) !== 1 ||
        metadata.width !== placement.width || metadata.height !== placement.height) {
      throw new Error(`Invalid ${layer} PNG, alpha or dimensions`)
    }
    return { layer, placement, bytes, hash: hashBytes(bytes) }
  }))
  const id = hashBytes(JSON.stringify([processingVersion, mappingVersion, mappingStatus, width, height, output,
    [assembly.cloth, assembly.face, assembly.hat, assembly.glasses],
    layers.map(({ layer, placement, hash }) => [layer, placement, hash])]))
  return {
    id, mappingVersion, mappingStatus, ...output,
    async render() {
      const overlays = await Promise.all(layers.map(async ({ bytes, placement }) => {
        const { left, top, width, height } = placement
        const factor = placement.scale ?? 1
        const input = await boundedImage(bytes).resize(width * factor, height * factor, { kernel: 'nearest' }).png().toBuffer()
        return { input, left, top }
      }))
      // Composite at the manifest canvas before scaling the finished pixels.
      const result = await sharp({ create: { width, height, channels: 4, background: '#0000' } })
        .composite(overlays).png().toBuffer()
      return boundedImage(result).resize(output.width, output.height, { kernel: 'nearest' })
        .webp({ lossless: true }).toBuffer()
    },
  }
}

export async function composeDog(input: CompositionInput) {
  const { render, ...metadata } = await prepareComposition(input)
  const bytes = await render()
  return { ...metadata, format: 'webp' as const, bytes, sha256: hashBytes(bytes) }
}
