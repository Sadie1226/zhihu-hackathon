# 1119-b4 · 评审 v2 回交提交回执（分支 b4-new-modify）

> **评审依据**：`team/2026-11-19/a/1119-a-给B-请求-b4-new评审修订-v2.md`（下称「请求 v2」）。
> **性质**：B 交付方回交；A 复验前不写「联合验收通过」。
> **一次性说明**：早上 `1119-b4-评审v2返工与回交说明-v1.md` 成文时按当时要求「只改本地、禁止推送 GitHub」，故其中「未推送任何远端分支」是当时的真实状态。本文件记录**本次已推送**的事实与回交材料索引；v1 原稿按 team 规则保留不动。

## 一、分支、基线与 commit

| 项 | 值 |
| --- | --- |
| 目标分支 | `b4-new-modify`（本次新建，此前不存在） |
| 基线 | `main@cb656378`（v5-1120；A React `4138f8c`、C K v4 `cd956ab` 已合入主干） |
| 组合方式 | 以 main 全量树为基础，叠加 B 交付文件（代码 + 文档 + 截图 + 验证结果） |
| 新 commit | 见分支 `b4-new-modify` 的 HEAD（提交信息：`b4: 按评审v2补齐上传会话/压图取消/失败分态/空态分离/图片完整性，并回交截图与验证`） |

选择 main 为基线而非旧 `b4-new@aca451fc`：请求 v2 §5 明确要求「实际组合基线（最新 main＋A 接口基线）」，本基线即 A 复验时组合出的同一套，避免 A 再次手工叠加。

## 二、五项修改逐条对照（请求 v2 §2）

| # | 请求项 | 交付文件（分支相对路径） | 落地要点 |
| --- | --- | --- | --- |
| 1 | 上传有效会话 | `app/(b)/api/uploads/photo/route.ts` | `readSessionId` 之后新增 `SELECT 1 FROM dog WHERE session_id = ? LIMIT 1`；无 Cookie/无归属均 401 且在写文件前返回，不落盘；消费开发边界归属，C 身份底座接入后只换这一处查询。 |
| 2 | B6 前端压图与取消 | 新增 `app/(b)/b4-photo-client.ts`；改 `app/(b)/b4-invitations.tsx` | `createImageBitmap`+canvas 压到最长边 ≤1600、`toBlob('image/webp',0.8)`；每条邀请独立 `AbortController` 绑定上传 fetch，「取消上传」只 abort 该条、不发回应、不标记已上传；服务端复核保留。 |
| 3 | 上传/回应失败分态与重试 | `app/(b)/b4-invitations.tsx`；`app/(b)/b4-panel.module.css` | 每条邀请一套 `Draft`（phase/uploadError/replyError/uploadedUrl）；上传失败写「图没传上去」+413/415/401 原因，回应失败写「回应没成功」；上传成功按邀请 id 保留 URL，重试不重传，换图/清除才失效；清除后可只交文字；网络不可用文案不承诺即时送达。 |
| 4 | 失败与真实空态分离 | `app/(b)/b4-invitations.tsx`、`app/(b)/b4-wish-panel.tsx` | 仅 `phase=ready` 显示真实空态；failed 显示错误+重试，unauthorized 显示返回路径；邀请侧区分「真实无邀请」与「最后一条刚处理完」。 |
| 5 | 损坏/截断图片 | `app/(b)/b6-photo.ts`、`app/(b)/api/uploads/photo/route.ts` | 新增 `validatePhotoIntegrity`：PNG 查 IDAT+IEND 及逐块 CRC32；JPEG 查 SOI/EOI 与 SOS；WebP 查 RIFF 声明长度与 VP8 块；读全字节校验，损坏/截断 415 不落盘；**不新增任何共享依赖**。 |

A 已确认的部分（心愿 HTTP 适配、回应归属幂等、完整 64 位哈希、统一 uploadDir、删除第二套入口、聊天显式示例）本轮未重复修改。

## 三、§3 待收口差异（请 A/C 决定，B 未自行改契约）

1. **读取权限边界**：`GET /uploads/<name>` 当前不读会话，凭合法链接即可读取（本人/无会话/另一主人持链接均 200），`private,max-age=3600` 只管缓存不是授权；完整哈希只约束「能否把照片引用进 reply」。请 A 结合场景收口是否限定可读对象。
2. **幂等响应 200 vs 409**：`POST /api/replies` 重复提交返回 200 + 库中真实 reply（带 duplicate 标识），已无假 ID；`contracts/api.md` 与部分 B6 说明仍写 409。B 保留真实回执与唯一性，请 A/C 统一正式契约文案。
3. **文档口径**：`1119-b1b2b3b4-可机检验收用例-v2.md` 已把「`v_wish_active` 未落地」改为「已在 main v5 落地」，v1 原稿保留；JSON 响应 `no-store`、图片 GET `private,max-age=3600` 已分开如实描述；`1121-b6` 是目标能力，不当前端完成证据。

## 四、回交材料索引（本分支 team/2026-11-20/b/）

| 文件 | 用途 |
| --- | --- |
| `1120-b4-评审v2提交回执-b4-new-modify-v1.md` | 本文件：分支/基线/commit/逐项对照/待收口 |
| `1120-b4-评审v2验证结果-v1.md` | typecheck/lint/test/build/check-all 与接口实证 14/14 |
| `1120-b4-评审v2截图-桌面-v1.png` | 1280px 桌面，8 状态卡片 |
| `1120-b4-评审v2截图-手机375-v1.png` | 375px 手机，8 状态卡片 |
| `1120-b4-评审v2最小预览入口-v1.html` | 最小预览入口，静态非真实数据 |

与请求 v2 同日的返工说明（`team/2026-11-19/b/1119-b4-评审v2返工与回交说明-v1.md`）与机检验收用例 v1/v2 一并在本分支。

## 五、需 A/C 关注

- **A**：读取权限边界、200/409 文案收口；wiring/挂载/returnTo/部署 `UPLOAD_DIR` 仍归 A，本轮未碰。
- **C**：正式会话底座接入后替换上传归属查询；`POST /api/chat` 契约仍待 C 定义，聊天继续显式示例，不宣称真实送达。
