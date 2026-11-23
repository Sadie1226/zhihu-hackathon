import type { PlaceTag } from '../../contracts/types.ts'
import compatibility from './scene-compat.json' with { type: 'json' }

export type SceneFile = keyof typeof compatibility.scenes
export type SceneContext = { sceneFile: SceneFile; availablePlaces: readonly PlaceTag[] }

function isSceneFile(value: string): value is SceneFile {
  return Object.hasOwn(compatibility.scenes, value)
}

function placeTag(value: string): PlaceTag {
  if (value === 'street' || value === 'stall' || value === 'riverside') return value
  throw new Error('Unexpected tag in the approved scene mapping')
}

/** The key is E2c's relative file value. Unknown values have no context. */
export function resolveSceneContext(sceneFile: string): SceneContext | null {
  if (typeof sceneFile !== 'string' || !isSceneFile(sceneFile)) return null
  return { sceneFile, availablePlaces: compatibility.scenes[sceneFile].map(placeTag) }
}
