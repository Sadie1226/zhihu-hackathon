# Chat v9 独立组合与回归

2026-11-26，负责人 C。分支 `c-travel-chat-v9-release-1126`，实现提交 `2462e7764e15a77ee62e3e03ada684da274a8191`。以独立旅途安全实现 `34b36a8a35ed4ef60693bad91fd2c8671fc71a55` 为父提交。

| 固定取用 | SHA |
| --- | --- |
| A 裁定 | `59c537eb836692758aa0220259b38a227387f87f` |
| C6/C9 原组合 | `cdff70309942c2c6c9e4aa254ee1dc2bfaa9bfad` |
| 正式聊天契约 | `56c634743a5fdc8ba4cb2f86b41ef5aa2006f4e3` |
| Chat v9 原候选 | `0a2a7df7f0fc8c2e9b570c9ac9809ea6f6b8ad5a` |
| B 最小存储及业务规则 | `4cafc6d9ca7a753fd91841ae78c50af35c8878b8` |
| main 参考 | `92c1ee57780dd0a1e6199156273bbee852ddc632` |

## 组合改动

- `lib/db/migrations.ts` 在连续 v8 后登记一次 `chatMessageMigration`。 `contracts/schema.sql` 纳入 `contracts/schema-v9-chat.sql` 增量；原候选的六字段 STRICT DDL、owner 与 dog 复合外键、二进制键语义、唯一约束、禁止插入覆盖保护全部保留。
- `009-chat-message.ts` 在执行 v9 前检查旅途安全 v8 的隔离表。无该表的原 v8 候选数据库属于另一应用/数据库配对，升级明确拒绝，原版本与数据保留。先确认 A 的切换路径再启用 v9。v7→v8→v9 在原迁移事务中先创建并捕获历史隔离，再创建聊天表。
- 只取正式聊天 API 小节、共享类型及 parser。文档将存储状态更新为 v9 候选。B 写事务仍应在会话与 dog 归属授权后查 `(owner_id,client_message_id)`，仅无首存时执行普通 INSERT。回放不 UPDATE，提交后响应固定四键。共享契约专项直接测试默认 v9 表，测试中的 SQL 是数据库验证，不是 B 的 POST。
- `tests/chat-v9-migration.test.mjs` 覆盖真实默认入口、fresh/升级 DDL 等价、v7 连续升级、经过旅途安全门禁的 v8 升级、失败回滚及重开，保留 G3 历史及真实已持久 C6 回执。 `tests/chat-v9-constraints.test.mjs` 使用默认 v9 入口覆盖权限引用、Unicode、唯一性、独立连接、失败回滚及隐私隔离。

## A 指定的 17 项默认假设

16 个采用当前默认 registry 的版本断言更新为 9，分布于 `tests/adoption.test.mjs`、`d5-integration.test.mjs`、`d5-interface-ready.test.mjs`、`d5-start-wire.test.mjs`、`discovery-composer.test.mjs`（2）、`events.test.mjs`、`owner-session.test.mjs`、`snapshot-v4.test.mjs`（2）、`tspf-assembly.test.mjs`（2）、`wishes.test.mjs`（2）、`search-cache.test.mjs` 及 `tests/helpers/mailbox-production.mjs`。第 17 项为 `chat-contract.test.mjs` 的旧「chat_message 缺失」及手动建表，已用默认 v9 的实际表和事务取代。

全量门禁还核对了 `db.test.mjs` 的版本、表数及测试专用下一迁移编号，G3 显式接口 registry 的完整版本列表，以及 `check-contracts.mjs` 的权威表集合。v8 回执迁移用例明确传 v8 registry 检验历史 v7→v8，原版应用回退试验仍固化 v8。权限、TTL、幂等、冻结事件、快照与投递的业务断言保持。

## 实际门禁

Node 24.15.0，隔离数据库、注入离线 provider。第一次组合全量退出 1，321 项中 320 通过，唯一失败为 `d5-interface-ready.test.mjs` 中默认 registry 列表仍止于 8。更新完整列表后以下门禁复跑。

| 命令 | 结果 |
| --- | --- |
| v9/C6/C9/切换/回退/数据库组合专项 | 78/78，退出 0，包含原 v8 reader 实测 |
| `npm.cmd run test` | 321/321，退出 0 |
| `npm.cmd run lint` 与新工具脚本专项 lint | 均退出 0 |
| `npm.cmd run typecheck` | 退出 0 |
| `npm.cmd run build` | 默认 Next.js Turbopack 构建，退出 0 |
| `node scripts/check-contracts.mjs`、`node scripts/check-mailbox.mjs` | 均退出 0 |
| `bash scripts/check-all.sh` | 退出 0 |
| `node scripts/e2e-d4.ts` | 退出 0 |
| `git diff --check` | 退出 0 |

`V9_DEFAULT_ENTRY_PASS` · `V9_CONTINUOUS_UPGRADE_PASS`

A 可先独立审查旅途 v8，再按父提交串行取用本候选。目标停写库、匹配备份、历史清单和部署权限仍需 A 核对。B 仍负责真实 POST、HTTP 幂等和界面接线，C10 与 B5 归来接线保持独立。

`A_TRAVEL_BASELINE_REVIEW_PENDING` · `A_V9_COMBINATION_REVIEW_PENDING` · `C10_EXECUTOR_PENDING` · `B5_FINISH_WIRING_PENDING` · `B8_REPLY_WISH_PENDING`
