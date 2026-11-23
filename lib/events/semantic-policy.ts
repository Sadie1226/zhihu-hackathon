import { createHash } from 'node:crypto'
import type { SceneFile } from './scene-context.ts'

type Policy = { textHash: string; scenes: readonly SceneFile[] }

// The reviewed D v1 text is pinned. A reworded or new event needs a semantics review.
const policies: Readonly<Partial<Record<string, Policy>>> = {
  any_lost_dog_poster: { textHash: "25cd73ad28ea91b3c0c04a8bb139cd8d70e1e2136febf392fc48c18c8383914d", scenes: [] },
  any_market_scale: { textHash: "33bd3bca190a5b6fb7594bf4aa7a030cbffed316f409ba3199795e0fdf6bc4a1", scenes: [] },
  any_moon_ring: { textHash: "a532ec103d4144d30097a43900923cfe82592da7a34dfb758b6b42fd1b90dc0d", scenes: [] },
  any_shop_cat: { textHash: "8da4841131321e7b2c6ccf6979adcde07cdf2b4173649f5f3917346a43d7c7f0", scenes: ["scenes/nantou.png","scenes/late-night-corner.png","scenes/beijing-road.png"] },
  any_slow_walker: { textHash: "1e9706dc9335d024bc64c4635f6cb07bc998ea21bcb229d28eb26af9f1b16cc3", scenes: ["scenes/nantou.png","scenes/late-night-corner.png","scenes/beijing-road.png","scenes/city-community-park.png"] },
  any_street_music: { textHash: "362fd12cf0d8b1a7fd8918aa77fd7585bcb688720dd8154efbfb11b825f1b7fa", scenes: ["scenes/nantou.png","scenes/late-night-corner.png","scenes/beijing-road.png","scenes/city-community-park.png"] },
  autumn_birds: { textHash: "6fdfe3bbb0d2efe9aaa7624a7fe05053112b7074f004bd10d0bb29598ddf06cc", scenes: [] },
  autumn_book_box: { textHash: "856f768b25982f651efec23f8ebd3cc331d7df44aefc2a3065bbf851e6bcdbcb", scenes: [] },
  autumn_chestnut: { textHash: "9b750e66f1eb9c4d6d570c2a1434432c01941e3c748672152b1b681d35a9c180", scenes: ["scenes/nantou.png","scenes/late-night-corner.png","scenes/beijing-road.png"] },
  autumn_ginkgo: { textHash: "f68295ccde6c4631825b2f4c38542375d2acabcecefb739bb266870c1fb200a9", scenes: ["scenes/nantou.png","scenes/late-night-corner.png","scenes/beijing-road.png","scenes/city-community-park.png"] },
  autumn_radio: { textHash: "3722d6cb3e60520ff4c02d5c930c8a71d80fdb265c7c434082216db4b7bb0b52", scenes: ["scenes/nantou.png","scenes/late-night-corner.png","scenes/beijing-road.png"] },
  autumn_river_fog: { textHash: "626c6fa118fbcf4879cf88016d8cd5c126f7166423706b968c6dedaf6dcdd370", scenes: [] },
  spring_cat_undercar: { textHash: "afff740294bf3d9fb009ef36855b2202c07bf47b34024f421353a4e2c3ddfbea", scenes: ["scenes/late-night-corner.png"] },
  spring_first_green: { textHash: "70d081e522aa2b9ca769dc8c4834c2c0a24621311f3ad4c8c0a9772b1de1830e", scenes: ["scenes/nantou.png","scenes/late-night-corner.png","scenes/beijing-road.png"] },
  spring_kite: { textHash: "720ee3f4153a4e48795033187a869585d636bcfb5db2dbabd4c107262ee22737", scenes: ["scenes/changbai.png","scenes/kanas.png","scenes/sanya.png","scenes/panjin-red-beach.png","scenes/guilin-li-river.png"] },
  spring_laundry: { textHash: "887d7bd6641bdf8341f6aa7d047179969d45e06d88603e343ce082cd7ebf163b", scenes: [] },
  spring_plum_rain: { textHash: "8bf1b9568ea2ac9752103a424ce20501d7fbea37859f833d53a33e64e8294ec7", scenes: ["scenes/nantou.png","scenes/beijing-road.png"] },
  spring_seed_stall: { textHash: "9a04af01af7fff3989ce5dc81fa013656beca787f3d9accaf3b6f921d5a97677", scenes: ["scenes/nantou.png","scenes/late-night-corner.png","scenes/beijing-road.png"] },
  summer_bookstore_ac: { textHash: "6511fa3ad616eda116e2159f4a2ed5dddd5a31daebb62975d8bc5b8bcfdd9e50", scenes: [] },
  summer_cicada: { textHash: "1664ec1dbc09a73ac1305352b0e0745ccf1b34e14f09353afb8be4ac87003078", scenes: ["scenes/nantou.png","scenes/late-night-corner.png","scenes/beijing-road.png","scenes/city-community-park.png"] },
  summer_icecream: { textHash: "424e0da2af1b111be4804468854cf2b21227b61889bb529113eb9b67975a03b1", scenes: ["scenes/nantou.png","scenes/late-night-corner.png","scenes/beijing-road.png"] },
  summer_night_stall: { textHash: "f76c7cfcc40b658e8c23e3a91e3307c0918bce742e21bce43a55718c05f66f3c", scenes: [] },
  summer_river_fish: { textHash: "06f3637b30e2349753b361b8d3f81a523c72eb84814e3d810e95c2b0557da9be", scenes: ["scenes/guilin-li-river.png"] },
  summer_shower: { textHash: "23c9486f1dea71bd3f2b09c5a7fc0c951f01ece338882296725fad9b862dea75", scenes: ["scenes/nantou.png","scenes/late-night-corner.png","scenes/beijing-road.png","scenes/city-community-park.png"] },
  winter_bookstore_chair: { textHash: "56f45b2e5c2e2263890ce67b14b0152ed34ac7217f2fff713e2626b724988be7", scenes: [] },
  winter_first_snow: { textHash: "7f3e8d0b07dbeadef859e16b5468f32bfbd6b84d05902355079e60a3ead6e65b", scenes: ["scenes/nantou.png","scenes/late-night-corner.png","scenes/beijing-road.png","scenes/city-community-park.png"] },
  winter_one_glove: { textHash: "fd2dec745d31823572b36affeb98376fac35e8999fe12c43d7888a504c07149c", scenes: ["scenes/city-community-park.png"] },
  winter_river_ice: { textHash: "847fadf5f9a93c1b583910395904ba8b7f221bb8252f2880dbaf51664007e1b6", scenes: [] },
  winter_sweet_potato: { textHash: "6d0e11415941050041f8049c95940226e31c500a99ad76da3ec491faa8b18c97", scenes: ["scenes/late-night-corner.png","scenes/beijing-road.png"] },
  winter_window_steam: { textHash: "4334aa0b77dbcff12c33cb4795c8ec69a225685afaba62ba50c4ef337ea343c7", scenes: [] },
}

export function sceneAllowsEvent(sceneFile: SceneFile, event: { code: string; text: string }): boolean {
  if (!Object.hasOwn(policies, event.code)) return false
  const policy = policies[event.code]!
  return policy.scenes.includes(sceneFile) && createHash('sha256').update(event.text).digest('hex') === policy.textHash
}
