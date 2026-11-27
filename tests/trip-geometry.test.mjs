import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actorPlacement } from '../lib/appearance/trip-geometry.ts'
import map from '../team/2026-11-22/e/e2c/scene-map.json' with { type: 'json' }
import bookstore from '../team/2026-11-23/e/bookstore-backgrounds-v1/scene-map.json' with { type: 'json' }
import { chooseWear, wardrobeDefault, wardrobeCatalogue } from '../lib/adoption/wardrobe.ts'
import { isTspfAssembly } from '../contracts/assembly.ts'
import { tripSceneFor } from '../lib/appearance/trip-scenes.ts'

test('all scene feet align on source-ratio stages at mobile and desktop widths', () => {
  for (const width of [284, 339, 750]) for (const scene of [...map.scenes, ...bookstore.scenes]) {
    const foot = { x: scene.foot[0] / 750 * 100, y: scene.foot[1] / 640 * 100, width: 27 }
    const p = actorPlacement(foot)
    const height = width * 640 / 750, size = width * .27
    assert.ok(Math.abs(p.left / 100 * width + size * 522 / 1024 - scene.foot[0] * width / 750) < 1e-9)
    assert.ok(Math.abs(p.top / 100 * height + size * 950 / 1024 - scene.foot[1] * height / 640) < 1e-9)
    assert.ok(p.left >= 0 && p.top >= 0 && p.left + p.width <= 100)
  }
})
test('T/S/P atomic choice keeps valid dressed state and never revives old accessory', () => {
  let a = chooseWear(wardrobeDefault, 'accessory', 'P13-blue-cap')
  a = chooseWear(a, 'outfit', 'T02-winter-post')
  assert.equal(a.cloth, null); assert.equal(a.accessory, null)
  assert.deepEqual(chooseWear(a, 'accessory', 'P16-mint-sunglasses'), a)
  a = chooseWear(a, 'cloth', 'S01-yellow-cardigan')
  assert.equal(a.outfit, null); assert.equal(a.accessory, null)
  assert.ok(isTspfAssembly(a))
  assert.throws(() => chooseWear(a, 'cloth', null))
  assert.equal(wardrobeCatalogue.face.items.some(([id]) => id?.startsWith('F09')), false)
})
test('only known scene assets become trip visuals; absent facts stay visibly illustrative', () => {
  assert.equal(tripSceneFor([]).illustrative, true)
  assert.equal(tripSceneFor([{ kind: 'scene', assetPath: 'https://outside.example/scene.png' }]).illustrative, true)
  const inside = tripSceneFor([{ kind: 'scene', assetPath: '/assets/trip-scenes-v1/scenes/bookstore-interior-750w.png' }])
  assert.equal(inside.illustrative, false)
  assert.equal(inside.foot.x, 400 / 750 * 100)
})
