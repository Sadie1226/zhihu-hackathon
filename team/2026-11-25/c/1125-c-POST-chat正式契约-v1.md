# POST /api/chat 正式契约交付

2026-11-25，负责人 C。交付分支为 `c-chat-contract-1125`，主干基线为 `dd5f53ebb214bc5f8ee4959b95bfeac74a055200`，契约提交为 `1cfcaea8a8f311d19dc8a767b6596520abd35b4b`。报告随附在同分支的后续提交。A 的请求取自 `a-requests-cde-1123@8ffff5ac5455ddefab18770d29961b80f828ce95`。

## 契约裁定

主契约见 [api.md 第十一项日常交流](../../../contracts/api.md#11-日常交流post-apichat待-b-实现)。`contracts/types.ts` 增加 `ChatRequest`、`ChatResponse`。新增 `contracts/chat.ts` 作为可复用的请求体校验，沿用 `countChars`。`tests/chat-contract.test.mjs` 检查契约示例、类型、受控输入和存储提案。

- 请求固定为 `{ dogId, text, clientMessageId }`，身份来自 Cookie。服务端使用有效、未撤销的稳定 owner 会话并验证 `dog.owner_id`；种子、无 owner、未知狗和跨主人目标返回 404。请求要求 JSON UTF-8 与可信同源 Origin，体积限 16 KiB。
- 文本用 ECMAScript `trim()` 修剪首尾，保留内部空白和 Unicode 原样。以 `text.replace(/\s/g, '').length` 计 1–200 个 UTF-16 码元，标点计数，非 BMP emoji 通常计 2。原始字符串另限 2,048 码元。幂等 ID 限 1–128 个 ASCII 字符，首字为字母或数字，后续可用下划线和连字符。
- 200 固定返回 `{ id, dogId, text, createdAt }`，是首次实际提交的记录。服务器生成不透明 `id`，时间是首次保存的 UTC ISO 8601 毫秒时间。首版不含 `replyText`，真实回复扩展须后续定约。
- 幂等键为 `(owner_id, client_message_id)`，比较授权狗与去首尾空白后的文本。同键同值返回首次结果，同键更改有效目标或内容返回 409。目标权限先于幂等检查。B 在超时、丢响应和 503 时保留原 ID 和请求，收到 200 后用服务端 ID 确认乐观上屏项。
- `NOT_FOUND` 为 404，`CONFLICT` 为 409，`NETWORK` 为 503 且可重试。非法 JSON、字段、来源及长度沿用 K 的 409，B 建议稿中的 400 未采用。响应声明 `Cache-Control: no-store` 与 `Vary: Cookie`。

## 存储和范围

主干没有正式 Chat POST 或专用记录表。B 面板在本机用输入散列选取四句示例之一。现有 `message` 存储指定 Trip 的归来分享，邀请回应走 `reply`，跨狗捎话走延迟投递的 `exchange`。Chat 的私有原话及其摘要不得进入这些链路或 `snapshot`，闲聊不创建心愿和长期任务。

后续提案为独立 `chat_message`，主键为服务端 ID，`UNIQUE(owner_id, client_message_id)` 保证并发和重启后的幂等，复合外键 `(dog_id, owner_id)` 约束归属。将归属校验、查重和写入放进同一 SQLite 写事务，提交后才确认成功。迁移编号以届时获批顺序为准。当前只交契约、纯请求校验及自动化测试，真实路由、持久化迁移和模型接入仍待实施。测试中的 DDL 仅在临时库运行。

## 实际验证

Windows、Node.js 24.15.0。构建指定独立数据库路径，SQLite 验证使用临时库。

| 命令 | 退出码 | 实测 |
| --- | ---: | --- |
| `node --test tests/chat-contract.test.mjs` | 0 | 4 项通过，覆盖 JSON、类型、Unicode、临时库幂等、归属、会话撤销与现有表隔离 |
| `npm.cmd run test` | 0 | 200 项通过，0 项失败，含契约和投递检查 |
| `npm.cmd run lint` | 0 | 通过，新增模块单独 ESLint 同为 0 |
| `npm.cmd run typecheck` | 0 | 通过 |
| `npm.cmd run build` | 0 | Next.js 16.4.6 默认 Turbopack 构建通过 |
| `node scripts/check-contracts.mjs` | 0 | 通过 |
| `node scripts/check-mailbox.mjs` | 0 | 通过 |
| `bash scripts/check-all.sh` | 0 | Git Bash 五项通过 |
| `git diff --check` | 0 | 通过 |

## 给 A 和 B

A 审查契约与独立存储提案，合入后提供含契约的 main 精确 SHA。B 基于该提交接入真实发送及失败恢复，复用 `parseChatRequest` 和共享类型，并配合 A/C 完成持久化迁移、并发与 HTTP 安全验收后切换示例入口。

> A，POST /api/chat 契约已交 `c-chat-contract-1125`，真实 POST 尚未实现。请审查独立存储与幂等边界，待 A 审合后由 B 从含契约的 main 提交接入。
