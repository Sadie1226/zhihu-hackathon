import { readFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import wardrobe from '../../team/2026-11-23/a/wardrobe-fit-r2/wardrobe.json' with { type: 'json' }
import checksums from '../../team/2026-11-23/a/wardrobe-fit-r2/SHA256SUMS.json' with { type: 'json' }
import scenes from '../../team/2026-11-22/e/e2c/scene-map.json' with { type: 'json' }
import bookstore from '../../team/2026-11-23/e/bookstore-backgrounds-v1/scene-map.json' with { type: 'json' }

const pairs = [wardrobe.base, wardrobe.expressionBase, ...wardrobe.items.map(x => x.layer), ...wardrobe.expressions.map(x => x.layer)]
for (const file of new Set(pairs)) {
  const source = resolve('team/2026-11-23/a/wardrobe-fit-r2', file)
  const data = readFileSync(source)
  if (createHash('sha256').update(data).digest('hex') !== checksums[file]) throw new Error(`Hash mismatch: ${file}`)
  const target = resolve('public/assets/wardrobe-r2', file)
  if (process.argv.includes('--verify')) {
    if (!data.equals(readFileSync(target))) throw new Error(`Runtime asset differs: ${file}`)
  } else { mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target) }
}
for (const entry of [...scenes.scenes.map(s => ({ ...s, sourceRoot: 'team/2026-11-22/e/e2c' })),
  ...bookstore.scenes.map(s => ({ ...s, sourceRoot: 'team/2026-11-23/e/bookstore-backgrounds-v1' }))]) {
  const source = resolve(entry.sourceRoot, entry.file), target = resolve('public/assets/trip-scenes-v1', entry.file)
  if (process.argv.includes('--verify')) {
    if (!readFileSync(source).equals(readFileSync(target))) throw new Error(`Scene differs: ${entry.file}`)
  } else { mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target) }
}
console.log('PASS r2 hashes and 14 scene runtime copies')
