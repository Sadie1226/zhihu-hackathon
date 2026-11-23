# A/E 装配交接 · S02 叶片披肩

- 来源为衣柜 v4 的 `../../wardrobe/base-front.png`、`../../wardrobe/singles/S02-leaf-cape.png`、`../../wardrobe/try-on/S02-leaf-cape.png`。
- 画布 1024 × 1024 px，左上原点，脚底参考点 (522, 950)。底身在下，披肩在上，偏移均为 (0, 0)。
- 披肩、领扣及雏菊装饰同属一个服装层。预期披肩覆盖双肩领口，双眼、鼻子、下腹、双脚和左侧尾巴保留可见。
- 归档去重：原先 `assets/base-front.png`、`assets/S02-leaf-cape.png` 与衣柜内同名文件字节相同（SHA-256 分别为 `90f85098…c0729`、`139e7e3f…95c0a`），已删除副本，`assembly.json` 改为引用衣柜内权威文件。`assets/` 只保留 `expected.png`。
- 离线验收已通过。运行 python render.py（需 Pillow）复现 rendered.png，与参考图比较时忽略全透明像素的隐藏 RGB。
- 浏览器样例需以 `team/2026-11-22/e/` 为站点根目录启动，否则 `../../wardrobe/` 落在站点外会 404：在该目录运行 python -m http.server 8623，打开 http://127.0.0.1:8623/e12/minimum-assembly/ 。页面会对比穿上、脱下、再穿三帧。
- 原包记录：当前环境 Chromium 在打开页面前因 ProcessSingleton 的 socket 权限失败，浏览器样例未实跑。A 待回交项目实际浏览器叠图及服务端合成结果，附版本和使用的部件/定位。
