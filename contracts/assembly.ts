import type { LegacyAssembly } from './types.ts'
import { TSPF_IDS } from './tspf-ids.ts'

export type OutfitId = typeof TSPF_IDS.outfit[number]
export type ClothId = typeof TSPF_IDS.cloth[number]
export type AccessoryId = typeof TSPF_IDS.accessory[number]
export type FaceId = typeof TSPF_IDS.face[number]
export type TspfAssembly =
  | { outfit: OutfitId; cloth: null; accessory: null; face: FaceId }
  | { outfit: null; cloth: ClothId; accessory: AccessoryId | null; face: FaceId }

export type StoredAssembly = LegacyAssembly | TspfAssembly

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function hasId(ids: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && ids.includes(value)
}

export function isTspfAssembly(value: unknown): value is TspfAssembly {
  if (!exactKeys(value, ['outfit', 'cloth', 'accessory', 'face']) || !hasId(TSPF_IDS.face, value.face)) return false
  if (value.outfit === null) {
    return hasId(TSPF_IDS.cloth, value.cloth) && (value.accessory === null || hasId(TSPF_IDS.accessory, value.accessory))
  }
  return hasId(TSPF_IDS.outfit, value.outfit) && value.cloth === null && value.accessory === null
}

export function isLegacyAssembly(value: unknown): value is LegacyAssembly {
  return exactKeys(value, ['cloth', 'hat', 'glasses', 'face']) &&
    hasId(['hoodie', 'jacket', 'sweater', 'raincoat', 'apron', 'scarf-coat'], value.cloth) &&
    (value.hat === null || hasId(['beanie', 'cap', 'straw', 'none'], value.hat)) &&
    (value.glasses === null || hasId(['round', 'square', 'sun', 'none'], value.glasses)) &&
    hasId(['happy', 'tired', 'hopeful', 'waiting'], value.face)
}

/** Read either contract shape without translating legacy selections. */
export function parseStoredAssembly(json: string): StoredAssembly {
  const value: unknown = JSON.parse(json)
  if (isTspfAssembly(value) || isLegacyAssembly(value)) return value
  throw new Error('Invalid stored assembly')
}
