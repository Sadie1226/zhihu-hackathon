# A wiring 与 B 修订集成交付

2026-11-21。版本 **v6-1121**；A 独立修复提交 `37f86e197435c3244c75fd29c59636278a9e09d6`。本件为仓库集成与本地生产验证，未部署公网。首次完整闭环不作本日硬门槛，最终 P0 不变。

## 来源与顺序

| 顺序 | 来源 | 集成提交 | 纳入内容 |
|---|---|---|---|
| 1 | `c6-search-wire-1120@49e5bb9` | `8d58a34` | 可信搜索凭据、单条 Find 内部执行与持久化 |
| 2 | `c-message-read-1120@9819c6c` | `bdf42d2` | 按 trip/会话归属读取 Message 的独立 GET |
| 3 | `a-wiring-1120@6e78fff` | `a787fb0` | B 三组件、Find 读取、分块状态与刷新、通用端口和反馈消费 |
| 4 | `b4-new-modify@bf409c8` | `442a1a9` | 有效上传归属、压缩/取消、重试复用 URL、真实空态、图片结构校验 |
| 5 | A 独立修复 | `37f86e1` | WebP 小端/块边界修复、Message adapter 绑定、回归与 lint 覆盖 |

A wiring 中旧 B 精确来源为 **`b4-new@aca451f`**，经 `a4b4f9a` 进入 A 分支。用户已允许在兼容且审查跑通后合入；各源历史保留。`d4-gift@d64b6eb`、依赖 D4 的 `a-social-gate-1120@f80b879` 与 E 候选均未纳入，故本版门禁仍四道，不能套用隔离社交分支的五道结果。

## 冲突和实际修改

B 新修订是快照型分支，九个 add/add 文件逐项组合，保留 A 邀请 tripId/Find 关联过滤、PanelContext 公共类型、`onCommitted({resource:'wishes',id})` 局部刷新与 Host/Origin 同源适配；采用 B 新版错误/空态、上传归属、压缩/取消和 URL 复用逻辑。

九个文件：`app/(b)/api/dogs/[id]/invitations/route.ts`、`app/(b)/api/uploads/photo/route.ts`、`app/(b)/b4-invitations.tsx`、`b4-panel.module.css`、`b4-ports.ts`、`b4-wish-panel.tsx`、`b6-photo.ts`、`app/api/dogs/[id]/wishes/route.ts`、`app/api/wishes/[id]/revoke/route.ts`。无 schema、迁移或依赖新增。

A 独立修复 `b6-photo.ts`：RIFF/chunk 长度使用小端序与实际 byteOffset，遍历全部块、padding 和边界；VP8X 元数据不能替代 VP8/VP8L 图像。新增真实 Chrome WebP fixture 与三项回归，未撤掉完整性检查。

`content-reader.ts` / `wiring.tsx` 绑定 Message GET，带 cookie、no-store、AbortSignal；只有成功体的 `message:null` 是空分享，错误和异趟 DTO 保持失败。`package.json` 只补 `lib/messages` lint 覆盖，无依赖改动。`verify-wiring.mjs` 增加真实浏览器照片回归。

## 实际验收

Node `v24.11.1`，Windows；Chrome canvas 合成图片、临时测试库和随机会话，不含用户照片；本轮未调用真实知乎 provider/OAuth。

| 验收 | 结果 |
|---|---|
| `npm.cmd test` | **157/157**；后续契约/投递检查通过 |
| typecheck / lint / production build | 均 exit 0 |
| check-all | 契约、投递、密钥、禁词四道通过 |
| 浏览器 | 25 组功能/布局检查通过，另 1 组已知开发退出重放缺口复现；无页面脚本错误 |
| 照片主路径 | 3000×2000 PNG→浏览器压成最长边 1600 WebP→真实上传 200→`kind=both` 回应落库 |
| 取消/重试 | 取消不写 reply、保留文字；首次回应故障后重试只上传一次；重复回同一真实 reply |
| 生产上传 | PNG/JPEG/WebP 各 200；无/伪造归属会话 401；截断 PNG/WebP 415，拒绝不新增文件 |
| 生产回应 | 首次/重复均 200、同一记录且只有 1 行；他人来源 404、他人照片 409 |
| 生产 Message | 真 null、最新记录、归属、GET-only、no-store/Vary Cookie、无业务写入/状态变化通过 |
| 生产测试入口 | 临时 fixture 路由与开发身份登录均 404 |
| C6 合成冒烟 | 单条 provider→Find→finish→重开→认证 GET 通过；无 cookie 404、POST 405；非真实线上搜索 |

见[联合证据 JSON](1121-a-wiring联合验收-v1.json)。浏览器运行时尚有未提交修复，JSON 记录运行基线及最终代码提交/文件 blob，未把运行时 HEAD 冒充发布 SHA。生产 build 已恢复 `next-env.d.ts`，开发生成类型/临时路由未提交。

## 已关闭与剩余

B 评审 v2 的有效会话、压缩/取消、失败重试复用 URL、真实空态、结构/截断检查五项集成阻断以及新增 WebP 误拒已关闭。A Find/Message 与 B 三组件已绑定，旧文档“wiring 未接”只代表当时快照。

B5 真分享/邀请生成、共用 ReplyBody、偏好、回应入材料、真实聊天，以及 C6 自动执行/3–5 条/缓存仍待。Message 暂沿 C 的实际时间倒序、ID 破同分读取，不代定 B 写入策略。正式 owner/OAuth/过期撤销未接，退出旧开发 cookie 重放仍 200；图片 GET 仍凭链接可读，上传/引用归属不等于下载授权；重复回应 200 与旧说明 409 待对齐。正式角色、E 路由、静态视觉验收、生图、公网及完整 P0 未完成。

续接：[给 B/C](1121-a-给B与C-请求-已合集成取用与剩余接口收口-v1.md)、[给 D](1121-a-给D-请求-D4事务边界修订与回证-v1.md)。E 沿用[原对齐请求](../../2026-11-20/a/1120-a-给E-请求-E11与候选资产对齐-v1.md)，本轮不增 E 工作。未自动发群消息。
