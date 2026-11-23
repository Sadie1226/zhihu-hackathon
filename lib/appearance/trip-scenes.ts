import map from '../../team/2026-11-22/e/e2c/scene-map.json' with { type: 'json' }
import bookstore from '../../team/2026-11-23/e/bookstore-backgrounds-v1/scene-map.json' with { type: 'json' }
import type { Find } from '../../contracts/types.ts'

/** Known scene identities only. A display fallback is explicitly illustrative, never a trip fact. */
export function tripSceneFor(finds: readonly Find[]) {
  for (const find of finds) {
    if (find.kind !== 'scene' || !find.assetPath) continue
    const entry = [...map.scenes, ...bookstore.scenes].find(scene => find.assetPath === `/assets/trip-scenes-v1/${scene.file}` ||
      find.assetPath === `/team/2026-11-22/e/e2c/${scene.file}` ||
      find.assetPath === `/team/2026-11-23/e/bookstore-backgrounds-v1/${scene.file}`)
    if (entry) return { src: `/assets/trip-scenes-v1/${entry.file}`, canvas: { width: 750, height: 640 },
      foot: { x: entry.foot[0] / 750 * 100, y: entry.foot[1] / 640 * 100, width: 27 }, illustrative: false }
  }
  const entry = map.scenes.find(scene => scene.file === 'scenes/late-night-corner.png') ?? map.scenes[0]
  return { src: `/assets/trip-scenes-v1/${entry.file}`, canvas: { width: 750, height: 640 },
    foot: { x: entry.foot[0] / 750 * 100, y: entry.foot[1] / 640 * 100, width: 27 }, illustrative: true }
}
