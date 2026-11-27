# 给CD：接口基线READY回执与精确取用

回执时间：2026-11-24 22:46 CST。**G2 接口基线 READY**。

- 联合分支：`a-d5-interface-ready-1124`
- 精确完整SHA：`582376e46de365dcd72ff324676662e2c3cdab75`
- 本回执替代v4中“G2尚未发布/等A回执”的状态；C/D现在可以从同一SHA开始各自G3接线。
- **不是G3执行基线READY，不是验收数据库READY，没有合main。** 主干仍`dd5f53ebb214bc5f8ee4959b95bfeac74a055200`。

## A实际审查及补接

C原39da31bb4ac2b511ebbc303b1f9ab8d95d64826a已推，A逐Git对象核验。冻结SQL/旧历史NULL/种子scope方向通过；原候选只有视图SQL，没有可导入TS reader、v7未登记且测试用占位v6，不能原样标READY。

A已统一纳入A-E5/K6/滑块0aee5ef、D历史+A null832b0e8、C39da31b、C7 d548a03、C8 3d26d81，保留原祖先。补唯一reader及显式独立v7初始化入口，解决C8 TripScope与C4 builder冲突，修真实K6下测试夹具兼容。C6多发现/A6/D6/E6未纳本次基线，不重复合旧D/K6。

完整接口/验证/分工文档位于本联合分支：`team/2026-11-24/a/1124-a-D5接口基线READY-交接-v1.md`。

## 固定接口

1. `lib/trips/occurrence-facts.ts` → `readOccurrenceFact(db,tripId,dogId)`，类型OccurrenceFactReader，返回`{text,sourceId,capturedAt} | null`。只读C v7视图，按实际时间最早事件取；旧最早不可验证就null，不跳后条、不补当前模板。
2. `lib/db/d5-interface.ts` → `d5InterfaceMigrations`、`openD5InterfaceDatabase(explicitPath)`。显式独立库真实v6→v7，必须传路径，缺省拒绝，fresh/升级共用迁移。**默认HTTP库仍v6，start默认未启用builder**；G3由C正式启用/登记，届时同步消除显式注册表重复v7，不双加DDL。不得用只支持v6的默认openDatabase打开此v7库。
3. 正式builder保留`deriveSnapshot(...,{occurrenceFacts:readOccurrenceFact})`完整result，再`toFixedSnapshot(result,meta)`，不使用旧`toSnapshot(result.body,meta)`冒充历史闸。只读调用用DatabaseSync readOnly；授权仍由各调用方先检查。

## 现在如何取用

每人先保留现有工作，不切有修改的旧分支，不reset、不强推；以下新目录和新分支名需未占用。PowerShell逐行执行。

共同核验：

```powershell
git fetch origin refs/heads/a-d5-interface-ready-1124:refs/remotes/origin/a-d5-interface-ready-1124
git rev-parse origin/a-d5-interface-ready-1124
if ((git rev-parse origin/a-d5-interface-ready-1124) -ne '582376e46de365dcd72ff324676662e2c3cdab75') { throw '接口基线SHA不匹配，先看A最新回执' }
```

C独立工作树：

```powershell
git worktree add -b c-d5-wire-from-a-1124 ..\c-d5-wire-from-a-1124 582376e46de365dcd72ff324676662e2c3cdab75
```

D独立工作树：

```powershell
git worktree add -b d-d5-reader-from-a-1124 ..\d-d5-reader-from-a-1124 582376e46de365dcd72ff324676662e2c3cdab75
```

安装依赖后，可先运行：

```powershell
node --test tests/d5-interface-ready.test.mjs
node --test tests/d5-integration.test.mjs tests/event-selector.test.mjs tests/seed-runner.test.mjs
node scripts/d5-derive-snapshot.mjs --selftest
npm.cmd run typecheck
```

不要直接取main开工，也不要将自己的旧候选整支反复merge到这条A基线；已纳入部分均有祖先，直接在新分支交增量。已有同类本地修改先保留并回差异，由A取一次。

## G3写入分工与下一回执

| 人 | 独占范围 | 回交要求 |
| --- | --- | --- |
| C | v7默认登记/连接、唯一事实adapter维护、C4 start/seed-runner/种子scope、C7权限接线 | 主人/种子同builder，running重试复用既有版本，先保存绑定再投递，失败整体回滚；C7在running独立事务；回分支/完整SHA/契约差异/命令 |
| D | 派生CLI/历史探针/演练导出；派生器历史查询、逐趟event证据与排序明确交D接续 | 直接import唯一reader；event证据改冻结视图，不让摘要固定而来源仍跟模板变；排序与reader一致；保留A null/toFixed保护，修真实reader探针进回归；回分支/SHA/命令 |
| A | 共同基线、共享冲突、wiring/主干 | 接C/D增量后串行整合验证，发**G3执行基线READY**（最终组合SHA/schema/五狗批次命令） |

C/D可从现在同SHA并行改不同文件；D不改C schema/start、不造第二adapter，C不复制D派生器。适配器若需修改由C单独提交交A协调；双方需共同类型变动先回A，不抢同一文件。A本轮已修D自检/诊断fixture按历史5导种子再迁6，D不再重做；种子演练Windows导出兼容及正式reader接入仍由D完成。

**五狗正式批次尚不能现在跑成验收READY。** 等A把两份G3接线集成为执行基线后，C再唯一写库→停写→一致SQLite备份+SHA256/Trip/schema/代码回执→A核放指定E盘并发数据库READY→D只读→A最终门禁合main。跨机器批准已生效，不再要求C有E盘；库仍NOT_READY。

## B聊天支线的位置

事实接口本轮已经交到A并完成G2，**C现在应单独定稿/提交POST /api/chat契约**，不等五狗整链。A独立审合main后，B取含契约精确main SHA接真实发送；聊天与D5接线分提交，不能将G2接口分支替代“聊天契约已合main”。B前置未到继续示例，不重做已合ReplyBody。

## 验证事实

240主测试/0失败、契约投递、接口4专项、C/C7/C8组合20专项、D自检20、类型/全量lint及额外脚本lint、webpack最终生产构建、207社交和D4现有E2E断言通过；无禁词命中，跟踪文本密钥模式扫描通过，独立源码与接口审查已做。原模板诊断探针未接reader仍按事实退出1，不能当成正式冻结探针已绿；新接口回归已证明真实C7捕获后D跨模板摘要稳定。

仍未完成：正式HTTP/可信种子冻结绑定、D冻结逐趟来源证据/排序与CLI、五狗库、最终执行组合门禁、真实模型/OAuth/公网闭环。上述没有用接口READY掩盖。
