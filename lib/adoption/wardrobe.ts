import manifest from '../../team/2026-11-23/a/wardrobe-fit-r2/wardrobe.json' with { type: 'json' }
import { isTspfAssembly } from '../../contracts/assembly.ts'
import type { TspfAssembly } from '../../contracts/assembly.ts'

export const wardrobeRoot = '/assets/wardrobe-r2'
const entries = [...manifest.items, ...manifest.expressions]
const faceNames: Record<string, string> = {
  'F01-neutral': '自然', 'F02-wink': '眨眼', 'F03-teary': '泪光', 'F04-smile': '微笑',
  'F05-unimpressed': '淡定', 'F06-sparkle': '星光', 'F07-shiny': '亮晶晶', 'F08-sleepy': '困困', 'F10-closed-smile': '眯眼笑',
}
const group = (category: string): [string | null, string][] => manifest.items.filter(item => item.category === category).map(item => [item.id, item.name])
export const wardrobeCatalogue = {
  outfit: { label: '套装', items: group('sets') },
  cloth: { label: '衣服', items: group('singles') },
  accessory: { label: '饰品', items: [[null, '不戴饰品'], ...group('accessories')] as [string | null, string][] },
  face: { label: '表情', items: manifest.expressions.map(item => [item.id, faceNames[item.id] ?? '自然'] as [string | null, string]) },
}
export const wardrobeDefault: TspfAssembly = { outfit: null, cloth: 'S02-leaf-cape', accessory: null, face: 'F01-neutral' }
export function chooseWear(current: TspfAssembly, key: keyof TspfAssembly, value: string | null): TspfAssembly {
  if (key === 'accessory' && current.outfit !== null) return current
  const next = { ...current, [key]: value }
  if (key === 'outfit') { next.cloth = null; next.accessory = null }
  if (key === 'cloth') next.outfit = null
  if (!isTspfAssembly(next)) throw new Error('这组穿搭不能一起选择')
  return next
}
export function wardrobeThumbnail(id: string | null): string {
  const item = entries.find(item => item.id === id)
  return item ? `${wardrobeRoot}/${item.layer}` : `${wardrobeRoot}/${manifest.base}`
}
