# C-Chat v9 存储迁移与交接

## 取用依据

| 输入 | 固定提交 | 用途 |
| --- | --- | --- |
| `main` | `92c1ee57780dd0a1e6199156273bbee852ddc632` | `c-chat-v9-storage-1125` 的父基线。默认 registry 至 v5 |
| C 正式聊天契约 | `56c634743a5fdc8ba4cb2f86b41ef5aa2006f4e3` | 包含 `contracts/chat.ts`、API、共享类型及 C 原交付报告 |
| 已审 C6 v8 候选 | `a6ad71d43edb4adbf34c791d73fe303472c52cff` | 隔离工作树的验证基线，含 G3 和 v8 回执 |
| B `b-1125` | `4cafc6d9ca7a753fd91841ae78c50af35c8878b8` | 远端实际 HEAD。核对最小存储设计及 `lib/chat/{types,write-decision,send}.ts` |

按 A 的 11/25 分批合并交付，v8 用于 Trip 发现回执，v9 用于聊天消息。基于 v5 的候选交付独立增量。连续升级在 detached v8 工作树里叠加正式聊天契约和 v9 增量进行验证，正式运行基线由 A 发布。已读本机根 `AGENTS.md`；CONTRIBUTING 指向的仓库外 `CLAUDE.md` 与 `PROJECT_STATE.md` 在本机可查位置未找到。

## 六字段与约束

```sql
CREATE TABLE IF NOT EXISTS chat_message (
  id                TEXT NOT NULL PRIMARY KEY CHECK (id <> ''),
  owner_id          TEXT NOT NULL REFERENCES owner(id),
  client_message_id TEXT NOT NULL COLLATE BINARY CHECK (
    instr(client_message_id, char(0)) = 0
    AND length(client_message_id) BETWEEN 1 AND 128
    AND substr(client_message_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND client_message_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  dog_id            TEXT NOT NULL,
  text              TEXT NOT NULL CHECK (text <> ''),
  created_at        TEXT NOT NULL,
  UNIQUE (owner_id, client_message_id),
  FOREIGN KEY (dog_id, owner_id) REFERENCES dog(id, owner_id)
) STRICT;
```

- `dog` 的 `uniq_dog_id_owner` 在实际 fresh schema 与 v5 迁移中存在。SQLite 确认父键顺序为 `(id, owner_id)` 并接受合法组合。不存在的 owner 或 dog、跨主人、无主狗及种子狗均被外键拒绝。既有 dog 约束也禁止将已绑定 owner 的狗改为种子狗。外键保证引用关系，由 B 在事务内验证真实会话和请求授权。
- 幂等键区分大小写，同一 owner 的同键只允许首次插入，不修剪、不设过期。ASCII 规则与 parser 一致，另显式检查 NUL，避免用 SQLite `length()` 和 `GLOB` 判断时忽略其后的字符。
- `chat_message_v9_insert_guard` 在主键或 owner/key 已存在时中止 INSERT，进而阻止 `REPLACE` 与 `INSERT OR REPLACE` 覆盖首存。两条触发器错误的扩展码同为 `1811`，分别指明 `chat_message.id` 或 `chat_message.owner_id, chat_message.client_message_id`。移除触发器的隔离事务另证明底层仍分别执行原生 `1555` 与 `2067` 约束。保留常规删除能力，隐私删除与保留周期由后续政策确定。
- 数据库检查 text 非空。B 的 HTTP 层在解析前限制 UTF-8 请求体为 16 KiB，并拒绝重复 JSON 键。共享 parser 限制原始 text 为 2,048 个 UTF-16 码元，检查字符合法性，并做 JavaScript `trim()`。规范化文本按 `countChars` 去 ECMAScript 空白后计 UTF-16 码元，限 1–200。保存内部空白、换行和原 Unicode 码元。SQLite `trim()` 与 `length()` 无法复现这些规则。B 分配非空不透明 ID，和以 `Z` 结尾、毫秒精度的 `Date.toISOString()` 时间。
- SQLite 专项使用合成文本。写入后检查 Snapshot、Find、事件、邀请、归来 Message、Reply、Exchange 与 Wish 仍无聊天副本。正式路由继续按契约限制日志、错误响应和内容用途。

## B 的 POST 写事务

1. 按正式聊天 API 验证同源、内容类型、请求体大小、JSON 和字段，调用 `parseChatRequest`。owner 来自 Cookie 解析出的真实会话。
2. 开启现有项目的 `BEGIN IMMEDIATE`。在同一事务内重新解析有效且未撤销的会话，用 `dog.id`、`dog.owner_id = auth.ownerId` 和 `dog.is_sample = 0` 校验目标。授权失败返回 `404 NOT_FOUND`，在任何幂等查询之前结束。
3. 用 `(auth.ownerId, clientMessageId)` 查询首存。相同 dog 和逐码元相同的规范化文本回放首存；换已授权 dog 或改文本返回 `409 CONFLICT`。同键回放只读，不刷新 `created_at`。无旧记录时分配 ID 与 UTC 时间后执行普通 INSERT。
4. 只有明确命中目标 owner/key 唯一冲突才可在合法事务边界内回读并重新比较。当前 guard 的消息为 `UNIQUE constraint failed: chat_message.owner_id, chat_message.client_message_id`，主键为 `UNIQUE constraint failed: chat_message.id`。单凭 `1811` 或 `2067` 不足以认定可回放。主键、外键、CHECK、锁超时和实际提交异常等不得当作幂等成功。实际数据库故障回滚，按正式契约返回 `503 NETWORK`。错误详情保持受控。
5. COMMIT 成功后才返回 HTTP 200，且只投影 `id, dogId, text, createdAt`。保留 `Cache-Control: no-store`、`Vary: Cookie`，正文不得输出 owner、key、诊断或生成字段。客户端结果不明时用原 key、dog 和文本重试。

C 维护 DDL、迁移顺序与数据库约束。B 负责路由、会话、授权、事务业务、回执和 UI。AI 回复仍待独立契约。专项的简化 SQL 和 worker 只验证 SQLite 持久化、锁和约束行为。

## 迁移、历史与隐私实证

- fresh 由项目初始化器在同一事务执行 schema 与顺序 registry。已验证合成 fresh 与真实 v8→v9、v7→v8→v9 的 v9 表、索引和触发器等价，迁移后重开两次稳定。schema 增量与迁移 DDL 做换行归一化后匹配。两种升级路径均通过 `integrity_check` 和 `foreign_key_check`。
- 在 v9 完整 DDL 后注入非法 SQL。对 v8 起点，v9 对象和版本未提交；对 v7 起点，同事务内尚未提交的 v8 对象也回滚。新连接确认原版本、schema、数据和回执均原样保留，随后成功升级。
- 从 v7 和 v8 用实际服务生成出发前 Snapshot、延迟投递、C7 冻结事件等历史。v8 的 C6 回执由正式运行入口和注入的离线提供方生成。升级与重开后逐行比对原数据，对 running Trip 使用 v8 入口再次读取首存回执，Find ID 一致且不需要提供方。已审 v8 专项另覆盖跨 OS 进程回放及并发确认。
- 唯一性覆盖同 owner 同键、不同 owner 同键、大小写不同的键、主键冲突、目标键冲突及 REPLACE 拦截。独立 worker 各用自己的 SQLite 连接争抢同一 owner/key，实际仅一条提交，独立只读连接读回首存。AFTER INSERT 故障与 SQLite 延迟外键引发的实际 COMMIT 故障均经回滚验证。
- 全部测试使用隔离临时 SQLite、合成数据和离线提供方。项目进程的 `DATABASE_PATH` 指向各自隔离路径。正式五狗数据库未用于验证。

## 实际改动与 A 取用

实现与专项提交为 `bd9f92d2a5e47dbd28b31985122e53902e3a8626`。

| 文件 | 内容 |
| --- | --- |
| `contracts/schema-v9-chat.sql` | 权威 fresh schema 增量 |
| `lib/db/migrations/009-chat-message.ts` | v9 迁移及待注册的 `chatMessageMigration` |
| `tests/chat-v9-migration.test.mjs` | DDL 比较、连续升级、重开、原有历史与回执、迁移原子性 |
| `tests/chat-v9-constraints.test.mjs` | parser 边界、SQLite 约束、双连接、故障回滚、持久性和业务表隔离 |
| 本文 | 验证记录、启用顺序及 B 接线事项 |

1. A 发布含 v6、v7、v8 和正式聊天契约的组合点，再取本候选提交。在该组合点把 `chatMessageMigration` 追加到 registry 末尾一次，将 `contracts/schema-v9-chat.sql` 的增量并入权威 fresh schema。候选基于 v5 验证时只运行 fresh DDL 与约束，两个依赖真实 v8 的用例有明确跳过原因。
2. 本次临时组合只叠加聊天契约 API 段落、共享类型、parser 和原专项，以及 v9 文件。已审 v8 的既有对象快照比较在 Windows 有 CRLF/LF 差异，临时组合仅在比较端归一化换行。A 组合时保留比较端归一化，数据库 DDL 原文不因换行验证修改。
3. 在 A 的组合点用默认数据库入口重跑全量门禁和 C9 组合回归，验证由默认 registry 产生 v9 及从真实 v8 升级。随后 B 接入正式 POST，并补真实 HTTP 授权、持久化幂等、并发和响应丢失重试用例。

## 门禁记录

Node `24.15.0`、SQLite `3.51.3`、npm `11.12.1`。两工作树分别使用 lockfile 安装 127 个包。

| 命令 | 独立 v5 候选 | 隔离 v8 组合验证 |
| --- | --- | --- |
| `node --test tests/chat-v9-*.test.mjs tests/chat-contract.test.mjs`，组合另加 `tests/discovery-receipt*.test.mjs` | 退出 0，12 项，10 通过、2 跳过 | 退出 0，37 项全过（v9 迁移 3、约束 5、聊天契约 4、v8 回执 25） |
| `npm.cmd run test` | 退出 0，225 项，223 通过、2 跳过 | 串行复跑退出 0，289 项全过 |
| `npm.cmd run lint` | 退出 0 | 退出 0 |
| `npm.cmd run typecheck` | 退出 0 | 退出 0 |
| `npm.cmd run build` | 退出 0，Next.js 16.4.6 Turbopack | 退出 0，Next.js 16.4.6 Turbopack |
| `node scripts/check-contracts.mjs` | 退出 0 | 退出 0 |
| `node scripts/check-mailbox.mjs` | 退出 0 | 退出 0 |
| `bash scripts/check-all.sh` | 退出 0，社交分项共 207 条通过 | 退出 0，社交分项共 207 条通过 |
| `git diff --check` | 退出 0，另检查暂存差异 | 退出 0 |

首次在两个工作树并行跑门禁时，组合全量退出 1，289 项中 287 项通过，v8 意图竞争和 C4 双进程各有一项超过 15 秒。两套构建和门禁结束后，单独重跑原命令通过。补测 session token 哈希不能充当 owner 后，两树再次通过专项、全量与 lint，数量同表。测试超时值及运行时代码保持原样。正式组合的默认 registry、C9 与真实 HTTP 接线仍需独立验收。

## 待办状态

- `A_OFFICIAL_BASELINE_PENDING`
- `CHAT_REAL_POST_PENDING`
- `CHAT_REAL_HTTP_IDEMPOTENCY_PENDING`
- `CHAT_UI_WIRING_PENDING`
- `CHAT_AI_GENERATION_PENDING`
