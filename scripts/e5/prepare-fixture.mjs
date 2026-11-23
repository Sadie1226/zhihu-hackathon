// E5 场景裁切验收夹具的挂载/卸载脚本。
// 夹具本身不是产品路由：只在跑验收时临时挂到 app/(a)/a-scene-crop-fixture，跑完即删。
// 用法：
//   node scripts/e5/prepare-fixture.mjs          挂载（复制 12 张场景到 public/，写入临时路由）
//   node scripts/e5/prepare-fixture.mjs --clean  卸载（删临时路由与 public 副本）
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const scenes = path.join(root, 'team/2026-11-22/e/e2c/scenes')
const publicDir = path.join(root, 'public/e5-scene-fixture')
const routeDir = path.join(root, 'app/(a)/a-scene-crop-fixture')
const routeFile = path.join(routeDir, 'page.tsx')
const clean = process.argv.includes('--clean')

if (clean) {
  rmSync(routeDir, { recursive: true, force: true })
  rmSync(publicDir, { recursive: true, force: true })
  console.log('已卸载：删除临时路由与 public/e5-scene-fixture')
  process.exit(0)
}

if (!existsSync(scenes)) {
  console.error('找不到场景素材目录：', scenes)
  process.exit(1)
}
if (existsSync(routeDir)) {
  console.error('临时路由已存在，先执行 --clean：', routeDir)
  process.exit(1)
}

mkdirSync(publicDir, { recursive: true })
let copied = 0
for (const file of readdirSync(scenes)) {
  if (!file.endsWith('.png')) continue
  cpSync(path.join(scenes, file), path.join(publicDir, file))
  copied++
}
mkdirSync(routeDir, { recursive: true })
writeFileSync(routeFile, "export { default } from '@/scripts/e5/fixtures/scene-crop-preview'\n")
console.log(`已挂载：${copied} 张场景 → public/e5-scene-fixture，路由 /a-scene-crop-fixture`)
console.log('访问示例：/a-scene-crop-fixture?scene=changbai&actor=body')
