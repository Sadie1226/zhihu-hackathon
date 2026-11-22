import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import sharp from 'sharp'

export async function fixtureDirectory(t) {
  const root = resolve('.local', 'c14-tests')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'fixture-'))
  t.after(async () => {
    assert.ok(dir.startsWith(root + sep))
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

export function rgbaPng(width, height, pixels) {
  const rgba = Buffer.alloc(width * height * 4)
  for (const [x, y, color] of pixels) rgba.set(color, (y * width + x) * 4)
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

export async function assemblyFixture() {
  const red = [255, 0, 0, 255]
  const green = [0, 255, 0, 255]
  const blue = [0, 0, 255, 255]
  const gold = [255, 191, 0, 255]
  const white = [255, 255, 255, 255]
  const sources = {
    body: await rgbaPng(4, 4, [[1, 1, red], [2, 1, red], [1, 2, red], [2, 2, red], [3, 3, red]]),
    cloth: await rgbaPng(2, 2, [[0, 0, green], [0, 1, green], [1, 0, green]]),
    face: await rgbaPng(2, 1, [[0, 0, blue], [1, 0, blue]]),
    hat: await rgbaPng(1, 1, [[0, 0, gold]]),
    glasses: await rgbaPng(1, 1, [[0, 0, white]]),
  }
  return {
    sources,
    red, green, blue, gold, white,
    input: {
      assembly: { cloth: 'hoodie', face: 'happy', hat: 'beanie', glasses: 'round' },
      mapping: {
        status: 'synthetic', version: 'test-fixtures-v1', canvas: { width: 5, height: 5 },
        body: { asset: 'body', width: 4, height: 4, left: 0, top: 0 },
        cloth: { hoodie: { asset: 'cloth', width: 2, height: 2, left: 1, top: 1 } },
        face: { happy: { asset: 'face', width: 2, height: 1, left: 1, top: 1 } },
        hat: { beanie: { asset: 'hat', width: 1, height: 1, left: 1, top: 1 } },
        glasses: { round: { asset: 'glasses', width: 1, height: 1, left: 1, top: 1 } },
      },
      options: { format: 'webp', size: { width: 5, height: 5 } },
      resolveAsset: async key => sources[key],
    },
  }
}

export async function readPixels(bytes) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { ...info, data, pixel: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)] }
}
