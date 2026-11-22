import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { Assembly } from '../../contracts/types.ts'

export const processingVersion = `c14-v1/sharp-${sharp.versions.sharp}/vips-${sharp.versions.vips}/webp-${sharp.versions.webp}`
export const maxImageBytes = 16 * 1024 * 1024
const maxImagePixels = 4096 * 4096
export const layerOrder = ['body', 'cloth', 'face', 'hat', 'glasses'] as const
type Layer = typeof layerOrder[number]
export type Dimensions = Readonly<{ width: number; height: number }>

export type Placement = Dimensions & Readonly<{
  asset: string
  left: number
  top: number
  scale?: number
}>

export type AssetMapping = Readonly<{
  version: string
  status: 'approved' | 'synthetic'
  canvas: Dimensions
  body: Placement
  cloth: Partial<Record<Assembly['cloth'], Placement>>
  face: Partial<Record<Assembly['face'], Placement>>
  hat: Partial<Record<Exclude<Assembly['hat'], 'none' | null>, Placement>>
  glasses: Partial<Record<Exclude<Assembly['glasses'], 'none' | null>, Placement>>
}>

/** Server-side adapter. Identifiers are opaque, and the adapter supplies bytes. */
export type ResolveAsset = (asset: string) => Promise<Buffer>

const choices = {
  cloth: ['hoodie', 'jacket', 'sweater', 'raincoat', 'apron', 'scarf-coat'],
  face: ['happy', 'tired', 'hopeful', 'waiting'],
  hat: ['beanie', 'cap', 'straw'],
  glasses: ['round', 'square', 'sun'],
}

type CanonicalAssembly = Omit<Assembly, 'hat' | 'glasses'> & {
  hat: Exclude<Assembly['hat'], 'none'>
  glasses: Exclude<Assembly['glasses'], 'none'>
}

export function normalizeLegacyAccessories(assembly: Assembly): CanonicalAssembly {
  return {
    ...assembly,
    hat: assembly.hat === 'none' ? null : assembly.hat,
    glasses: assembly.glasses === 'none' ? null : assembly.glasses,
  }
}

function validateAssembly(assembly: CanonicalAssembly): void {
  if (!assembly || typeof assembly !== 'object' || Object.keys(assembly).sort().join(',') !== 'cloth,face,glasses,hat') {
    throw new Error('Expected the four Assembly fields')
  }
  for (const layer of ['cloth', 'face', 'hat', 'glasses'] as const) {
    const value = assembly[layer]
    if (value === null && (layer === 'hat' || layer === 'glasses')) continue
    if (typeof value !== 'string' || !choices[layer].includes(value)) throw new Error(`Invalid Assembly ${layer}`)
  }
}

export function hashBytes(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function validateDimensions({ width, height }: Dimensions): void {
  if (![width, height].every(side => Number.isSafeInteger(side) && side > 0 && side <= 4096)) {
    throw new Error('Invalid image dimensions')
  }
}

export function boundedImage(bytes: Buffer) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxImageBytes) throw new Error('Invalid image byte size')
  return sharp(bytes, { limitInputPixels: maxImagePixels, failOn: 'warning' })
}

export function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && !value.includes('..')
}

export function placedLayers(assembly: CanonicalAssembly, mapping: AssetMapping): [Layer, Placement][] {
  validateAssembly(assembly)
  validateDimensions(mapping.canvas)
  if (!validIdentifier(mapping.version) || !['approved', 'synthetic'].includes(mapping.status)) {
    throw new Error('Invalid asset mapping version or status')
  }
  return layerOrder.flatMap((layer): [Layer, Placement][] => {
    let placement: Placement | undefined
    if (layer === 'body') placement = mapping.body
    else {
      const choice = assembly[layer]
      if (choice === null) return []
      const table: Partial<Record<string, Placement>> = mapping[layer]
      placement = Object.hasOwn(table, choice) ? table[choice] : undefined
    }
    if (!placement || !validIdentifier(placement.asset)) throw new Error(`Missing or invalid ${layer} asset`)
    validateDimensions(placement)
    const { width, height, left, top, scale = 1 } = placement
    if (![left, top, scale].every(Number.isSafeInteger) || left < 0 || top < 0 || scale < 1 ||
        left + width * scale > mapping.canvas.width || top + height * scale > mapping.canvas.height) {
      throw new Error(`Invalid ${layer} placement`)
    }
    return [[layer, { asset: placement.asset, width, height, left, top, scale }]]
  })
}

export type CompositionAssembly = CanonicalAssembly
