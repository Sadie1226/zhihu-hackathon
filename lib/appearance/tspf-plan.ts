import wardrobe from '../../team/2026-11-23/a/wardrobe-fit-r2/wardrobe.json' with { type: 'json' }
import hashes from '../../team/2026-11-23/a/wardrobe-fit-r2/SHA256SUMS.json' with { type: 'json' }
import { isTspfAssembly } from '../../contracts/assembly.ts'
import type { TspfAssembly } from '../../contracts/assembly.ts'

export const TSPF_ASSET_ROOT = 'team/2026-11-23/a/wardrobe-fit-r2'
export const TSPF_ASSET_REVISION = wardrobe.revision

type LayerRole = 'back-accessory' | 'body' | 'face' | 'clothing' | 'front-accessory'
type Entry = { id: string; layer: string; sha256: string; offset: number[]; renderPosition?: string }
type Layer = { role: LayerRole; path: string; sha256: string; width: number; height: number; left: number; top: number }
const entries = new Map<string, Entry>([...wardrobe.items, ...wardrobe.expressions].map(row => [row.id, row]))
const checksums: Readonly<Record<string, string>> = hashes

function layer(role: LayerRole, path: string, sha256 = checksums[path], offset = [0, 0]): Layer {
  if (!sha256 || offset[0] !== 0 || offset[1] !== 0) throw new Error('Invalid r2 layer metadata')
  return { role, path, sha256, width: wardrobe.canvas[0], height: wardrobe.canvas[1], left: 0, top: 0 }
}

function entry(id: string): Entry {
  const row = entries.get(id)
  if (!row) throw new Error('Missing r2 layer')
  return row
}

function itemLayer(role: LayerRole, row: Entry): Layer {
  return layer(role, row.layer, row.sha256, row.offset)
}

/** Paths are relative to the versioned asset root and can be mounted by either renderer. */
export function resolveTspfPlan(assembly: TspfAssembly) {
  if (!isTspfAssembly(assembly)) throw new Error('Invalid T/S/P/F assembly')
  const clothing = entry(assembly.outfit ?? assembly.cloth)
  const accessory = assembly.accessory === null ? null : entry(assembly.accessory)
  const neutral = assembly.face === 'F01-neutral'
  const behind = accessory?.renderPosition === 'behind-body'
  const layers: Layer[] = []
  if (accessory && behind) layers.push(itemLayer('back-accessory', accessory))
  layers.push(layer('body', neutral ? wardrobe.base : wardrobe.expressionBase))
  if (!neutral) layers.push(itemLayer('face', entry(assembly.face)))
  layers.push(itemLayer('clothing', clothing))
  if (accessory && !behind) layers.push(itemLayer('front-accessory', accessory))
  return { revision: TSPF_ASSET_REVISION, width: wardrobe.canvas[0], height: wardrobe.canvas[1],
    footAnchor: { x: wardrobe.footAnchor[0], y: wardrobe.footAnchor[1] }, layers }
}
