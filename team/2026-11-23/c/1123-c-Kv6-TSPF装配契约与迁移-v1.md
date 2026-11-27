# K v6 · T/S/P/F 装配契约与迁移

2026-11-23。GitHub 主干基线 `dd5f53ebb214bc5f8ee4959b95bfeac74a055200`（v9-1123，数据库 v5）。交付分支 `c-k6-tspf-1123`，实现提交 `f4746d48a4b5e6709fe302f93b0e52896efebc79`，待 A 审阅。

## 契约与校验

新写入使用 `TspfAssembly`。四键固定为 `outfit/cloth/accessory/face`。T 模式要求 S 和 P 都为 JSON `null`。S 模式要求 T 为 `null`，P 可为一件或 `null`。F 必填。ID 逐项对齐 `wardrobe-fit-r2-tspf-20261123`，验证使用精确成员关系。缺键、额外键、数组、非法 null、类别互换、F09、旧名和未知 ID 均拒绝。

| 类别 | 采用的 ID |
| --- | --- |
| T（6） | `T01-frog`、`T02-winter-post`、`T05-cloud-onesie`、`T06-starry-cloak`、`T07-striped-knit`、`T10-cowboy` |
| S（9） | `S01-yellow-cardigan`、`S02-leaf-cape`、`S03-apron`、`S04-olive-vest`、`S05-cream-vest`、`S06-navy-varsity`、`S07-blue-cloud-hoodie`、`S08-blue-check-pajamas`、`S09-seaside-shell-cape` |
| P（9） | `P05-daisy-crown`、`P12-orange-thermos`、`P13-blue-cap`、`P15-star-bag`、`P16-mint-sunglasses`、`P19-blue-wings`、`P22-gold-round-glasses`、`P23-black-sunglasses`、`P25-blue-check-nightcap` |
| F（9） | `F01-neutral`、`F02-wink`、`F03-teary`、`F04-smile`、`F05-unimpressed`、`F06-sparkle`、`F07-shiny`、`F08-sleepy`、`F10-closed-smile` |

`StoredAssembly = LegacyAssembly | TspfAssembly`，`parseStoredAssembly` 读取两种有效结构，保留旧帽、镜、服装、表情及原选项。数据库保留历史 JSON 原字节。按 C 的最终裁定，相近款式只能用于主人重新选择时的建议。旧 `raincoat`、`straw`、`square` 没有直接对应，原帽和镜也可能同时存在。主人明确选择并确认后才保存新版。本迁移没有候选映射或历史装配转换。

`resolveTspfPlan(assembly)` 是 C11b/C14 共用的纯函数。它读取 A 的版本化清单，返回素材相对路径、SHA-256、1024×1024 画布、脚底点 (522,950) 和逐层坐标 (0,0)。P19 放在背部，其余 P 在前。F01 使用原中性底身，其余 F 先用 expression-ready 底身再叠 F 层。T/S 在表情之上。路径供消费者按同一资产根解析，已烘焙的调整参数无需重算。[A r2 清单](../a/wardrobe-fit-r2/wardrobe.json) · [共享计划](../../../lib/appearance/tspf-plan.ts) · [契约](../../../contracts/api.md)

## SQLite v5 → v6

新增 `006-tspf-assembly.ts`，在现有 bootstrap 事务内替换 `dog_assembly_ins` 和 `dog_assembly_upd`。不重建表，002–005 保持原文件。fresh schema 与升级后的触发器定义相同。SQL 拦截畸形 JSON、BLOB、重复键及含尾部 NUL 的输入。新增狗或显式写入 `dog.assembly` 必须通过 v6 校验。旧行的其他更新（例如改名）照常执行。

历史 `dog.json` 和 20 只种子的原始 SQL 用于迁移测试，fresh 测试使用独立 `dog-v6.json`。实测老种子脚本在 v5 执行两次仍为 20 只，升级后每条旧装配原样保留。v6 库直接运行旧脚本会被拒绝。注入迁移失败后，触发器、`user_version=5` 及 Dog、Trip、Exchange、Snapshot、Wish、Owner 数据完整回滚。正常升级、再次打开和外键检查通过。

## 给 A 的接入清单

1. `lib/adoption/development.ts` 的 `parseAssembly` 和 `lib/adoption/view.ts` 的 `CreateDogInput` 切换到 `TspfAssembly`，在持久化前用公共校验器返回明确的输入错误。当前旧 writer 在严格 v6 库的新领养写入会被拒绝，已有合法收据仍能重放。部署 v6 写入需同时接入新版领养。
2. `components/app-shell/adopt-page.tsx` 的草稿、选择器和默认值切换到 r2。选择 T 清除 S/P，选择 S 清除 T，P 可卸下后重选，保持必选 F。旧草稿保留旧值后由用户明确重新选择。
3. `lib/adoption/view.ts` 的读取 DTO 及 `components/app-shell/ports.ts`、`visuals.tsx` 的读取/渲染边界采用 `StoredAssembly`，按结构识别历史与新版。当前 `Assembly` 保留为 `LegacyAssembly` 的编译过渡别名，存储行提供 `StoredDog`。A 可单独提供历史外观读取适配，正式 C11b/C14 只使用新版 ID 和共享计划。
4. 提供 r2 的运行时素材映射。共享计划的路径相对版本化资源根，当前 A 素材从交付目录取用。用户确认旧狗重新选装后写入完整新版四键。

C14 后续在 K v6 合入后将旧合成入口改为由 `resolveTspfPlan` 提供图层，并把修订版本、选择和图层哈希纳入缓存键。与 C11b 比对实穿和裁切，透明像素 RGB 不计入视觉差异，半透明舍入与实际遮挡分别核验。旧 C14 分支保留在 `485677f397861127f61e257ccb21e811cc370fff`。

## 实跑结果

生产变更为 `contracts/{api.md,schema.sql,types.ts,assembly.ts,tspf-ids.ts}`、`contracts/fixtures/dog-v6.json`、`lib/db/migrations.ts`、`006-tspf-assembly.ts`、`lib/appearance/tspf-plan.ts`。其余代码变更为专项测试、存储版本断言和现有门禁的测试数据，包含 D4 测试夹具。

| 命令 | 实测结果 |
| --- | --- |
| `npm.cmd run test` | exit 0，200 通过，0 失败，0 跳过。旧领养业务回归使用明确的 v5 隔离库，另有严格 v6 库拒绝旧新写入的测试。 |
| `node --test tests/tspf-assembly.test.mjs` | exit 0，3 项通过，含 864 种组合逐条写入 fresh 与升级库、非法写入、渲染计划及历史迁移。 |
| `python team/2026-11-23/a/wardrobe-fit-r2/render.py --verify` | exit 0，33 图层、864 合法组合、8 个官方反例通过。TS 测试额外验证两种底身文件和更多非法输入。 |
| `npm.cmd run lint`、`npm.cmd run typecheck` | exit 0。新增公共模块另跑 ESLint，exit 0。 |
| `npm.cmd run build` | exit 0，Next.js 16.4.6 生产编译及类型检查通过。 |
| `node scripts/check-contracts.mjs`、`bash scripts/check-all.sh` | exit 0，契约和五道门禁通过，含社交 207 项。 |
| `node scripts/c4/smoke.mjs`、`node scripts/e2e-d4.ts` | exit 0，本地生产出行、投递和重启读取通过，D4 端到端断言通过。 |
| `git diff --check`、`git diff --cached --check` | exit 0。 |

组合枚举验证选装规则，浏览器与 C14 正式实穿、部署及新领养联调另待验收。
