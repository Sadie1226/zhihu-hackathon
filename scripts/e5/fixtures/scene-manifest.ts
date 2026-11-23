// 生成自 team/2026-11-22/e/e2c/scene-map.json（12 张 750×640 场景 + 脚底点）。
// 仅供 E5 场景裁切验收夹具使用；不改动 A 的页面实现，也不是正式素材绑定。
export type SceneDef = { slug: string; place: string; file: string; footPx: [number, number] }
export const SCENE_CANVAS = { width: 750, height: 640 }
export const SCENES: SceneDef[] = [
  { slug: 'changbai', place: '长白山天池', file: '/e5-scene-fixture/changbai.png', footPx: [366, 551] },
  { slug: 'kanas', place: '阿勒泰·喀纳斯', file: '/e5-scene-fixture/kanas.png', footPx: [444, 543] },
  { slug: 'sanya', place: '三亚海滩', file: '/e5-scene-fixture/sanya.png', footPx: [339, 512] },
  { slug: 'nantou', place: '深圳南头古城', file: '/e5-scene-fixture/nantou.png', footPx: [395, 545] },
  { slug: 'late-night-corner', place: '深夜街角', file: '/e5-scene-fixture/late-night-corner.png', footPx: [375, 498] },
  { slug: 'dunhuang-mingsha', place: '敦煌鸣沙山', file: '/e5-scene-fixture/dunhuang-mingsha.png', footPx: [384, 542] },
  { slug: 'greater-khingan-birch', place: '大兴安岭白桦林', file: '/e5-scene-fixture/greater-khingan-birch.png', footPx: [377, 540] },
  { slug: 'panjin-red-beach', place: '盘锦红海滩', file: '/e5-scene-fixture/panjin-red-beach.png', footPx: [347, 550] },
  { slug: 'guilin-li-river', place: '桂林漓江', file: '/e5-scene-fixture/guilin-li-river.png', footPx: [326, 549] },
  { slug: 'beijing-road', place: '广州北京路', file: '/e5-scene-fixture/beijing-road.png', footPx: [390, 546] },
  { slug: 'city-community-park', place: '城市社区公园', file: '/e5-scene-fixture/city-community-park.png', footPx: [365, 540] },
  { slug: 'corner-tavern-interior', place: '街角小酒馆内景', file: '/e5-scene-fixture/corner-tavern-interior.png', footPx: [432, 548] },
]
