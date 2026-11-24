# D5接口基线READY：C/D统一取用交接 v1

状态：**G2 接口基线 READY**（以A请求入口公布并独立回读的本分支完整SHA为准）。分支`a-d5-interface-ready-1124`。**不是执行基线READY、数据库READY、主干合并或D5最终验收通过。** 本件允许C/D基于同一SHA开始各自接线。

## 输入来源及A审查结果

| 已纳入 | 精确源SHA |
| --- | --- |
| main基线 | dd5f53ebb214bc5f8ee4959b95bfeac74a055200 |
| K6（已在A-E5祖先中，不重复取） | 008a88b439d5079c2aa389b6765982526639aa17 |
| A-E5及滑块布局候选 | 0aee5efb6818b9c6e7dda44bbc0e9d4ff5a9169c（含e80b6c2、a698cc3） |
| D历史+A null修补 | 832b0e8d90b306ea784e80682da81d3891db3afa（含f772da6、6db1622） |
| C事实/绑定/种子scope候选 | 39da31bb4ac2b511ebbc303b1f9ab8d95d64826a |
| C7 | d548a03b07a299a6a04f41af7c72b5812d2ce6fd |
| C8可信种子 | 3d26d81fe282fc121cd8ca3aec4a356a8838508a |

保留原Git祖先/合并提交。C6多发现、A6语义、D6/E6不在本批基线，不擅自宣称它们一并合验。请求分支的最新文档不等于本分支业务已实现。

C39da31b原样不能直接称READY：v7未登记、只有视图SQL没有TS reader，测试还使用占位v6。A复验C实际SQL方向可用，并补下方最小接口实现、处理C8的TripScope与C4 builder冲突；不改C7语义筛选/默认权限，不提前启用自动执行器。

## 冻结的开发接口

### 1. 独立接口数据库：显式v6→v7

`lib/db/d5-interface.ts`：

```ts
import { d5InterfaceMigrations, openD5InterfaceDatabase } from './lib/db/d5-interface.ts'
// 必须传独立验证库的明确路径；缺省、空或:memory:会拒绝，不回退默认应用库。
const db = openD5InterfaceDatabase(validationPath)
```

该**显式接口注册表**包含真实2/3/4/5/6/7，fresh库通过现有schema+同一迁移初始化，旧5库按真实6/7升级。没有重复把v7 DDL再塞进schema.sql，避免fresh重复建表。已验证fresh与升级路径v7对象一致、失败完整回滚、重开不重复、20狗旧装配原字节保留。原种子SQL必须在历史v5初始化时导入后再升级，禁止向严格v6/v7新库强插旧装配。

**默认HTTP运行时的`lib/db/migrations.ts`仍到v6，默认start也未启用builder。** 这是G2范围边界：仅明确指定的接口验证库升级v7，主业务库/HTTP不能误报已接D5。G3由C统一完成默认登记/连接入口/start：正式登记v7时必须同步消除显式注册表的重复v7，不同时在fresh schema和无条件迁移里重放DDL；沿同一迁移内容，不重占v6。库升v7后不能再用只识别到v6的默认openDatabase去读，D只读用DatabaseSync readOnly，写侧使用本入口或C后续统一v7入口。

### 2. 唯一不可变事实adapter

`lib/trips/occurrence-facts.ts`导出：

```ts
import { readOccurrenceFact } from './lib/trips/occurrence-facts.ts'
// OccurrenceFactReader: (db, tripId, dogId) => {text,sourceId,capturedAt} | null
```

读取`v_trip_event_history`，同trip+dog，按`julianday(happened_at),event_id`只取最早记录。frozen映射发生时公开text；sourceId固定为`trip_event_fact:${JSON.stringify([tripId,eventId])}`，capturedAt取不可变happened_at（捕获同一插入语句）。不存在或最早记录unverifiable返回null，不读当前模板，不跳到后条凑摘要；损坏形状抛错。SELECT only，不授权公开调用方；消费者先完成自身owner/可信seed授权。

此函数是C视图到D契约的唯一adapter，由A本次补齐供C维护；D直接import，不另写SQL副本。若后续需要修改C视图或adapter，由C单独回修订交A，再更新共同基线，D不边读边猜。

### 3. 正式快照转换

```ts
const result = deriveSnapshot(db, dogId, { occurrenceFacts: readOccurrenceFact })
const snapshot = toFixedSnapshot(result, { dogId, version: nextVersion, createdAt: at })
```

保留完整result/evidence，未固定历史会拒绝，旧toSnapshot只验形状不够。C的`BuildDepartureSnapshot`适配位可用此组合，C负责在同一C4写事务实际接入；已保留C8 TripScope与build选项，尚未替C开启默认builder或种子runner传递。

## 本轮实际验证

- 主测试240/240、契约检查、投递检查通过；C5+C7十+C8五专项20项已单独复验。
- 新接口4项回归：显式路径防误开默认库；真实5→6→7/fresh对象一致/重开/故障回滚/20狗装配不变；真实C7选事件触发捕获→reader→D派生，改模板旧摘要不变；混合UTC格式按实际时间取最早，旧最早缺失不跳后条。
- 类型、全量lint及额外D脚本lint、webpack生产构建、207社交检查、D4 E2E现有断言通过。没有声称default Turbopack构建或全产品/真人HTTP联合验收。
- D自检20/20通过。为K6修了诊断fixture初始化（`scripts/d5-diagnostic-seeds.mjs`）：原种子先在历史5导入再迁6；不改原名册字节。旧无reader历史诊断探针仍按事实退出1，说明诊断模板会变；不伪造它已接新reader，G3由D适配CLI/探针。
- 已有测试中的占位v6及旧装配夹具会在真实K6上失败，A已修为真实迁移/合法装配或按原始5→6导入，保留行为断言。首次新测试清理hook顺序导致Windows锁文件失败，已关闭连接后再清理，最终4项通过。
- Git diff检查与跟踪文本密钥模式扫描通过；独立审查指出路径缺省会误开默认库，已加运行时校验和回归。源码/接口审查不是五狗库证据。

## G3分工：同一READY SHA开各自新分支

**C唯一写**：v7默认登记及连接启用、`lib/trips/occurrence-facts.ts`后续维护、C4 start/权限/快照绑定、seed-runner/seed-event-scope、C7种子权限接线。正式主人与可信种子复用同一受控builder；重试/并发先识别已有绑定、版本只分配一次、失败连快照/绑定/投递整体回滚。C7在running独立事务，不嵌套start事务。旧不可恢复记录明确null/拒正式转换的兼容行为，不能补造文本。

**D唯一写**：派生CLI、历史探针/演练导出；派生器的历史读取/逐趟event证据/时间排序范围本回执明确交D接续。`snapshot-derive.ts`当前earliestEvent还JOIN当前event.code/text并按字符串排序，D须改为冻结视图并与adapter时间顺序一致；不可保留“摘要固定但来源证据跟模板变”的错位。A已有null留缺/toFixedSnapshot保护保留，不重写、不复制第二派生器。需改共享类型或C adapter先回A协调。

**A唯一写**：wiring、共同基线、共享冲突、最终组合/主干；此接口分支发布后固定，不让C/D直接推它。A接两份回交后才发**执行基线READY**（组合SHA/schema/批次命令）。届时C才能跑指定五狗正式批次→停写→一致备份/hash/回执→A核库READY→D只读。当前五狗库仍NOT_READY，用户跨机器批准继续有效。

B聊天支线：C在事实接口提交之后应单独提交POST /api/chat正式契约；A审合main后B从含契约精确main SHA接真实发送，不等五狗完成。本接口READY不代替聊天契约已合main。E可并行精确滑块版本真机复测/E7联网回看，E6新发件仍关闭。

每人先保留本地已有改动，fetch A分支、核A回执完整SHA，在未占用新目录用git worktree add -b创建自己的接入分支。不reset、不强推、不互相merge整支、不重复取K6/D旧祖先；具体精确命令随A请求分支READY回执公布。
