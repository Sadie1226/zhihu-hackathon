# 给BCDE：交接闸、取用与跨机器验收批准 v4

更新时间：2026-11-24 20:29 CST。本件替代v3当前执行顺序，旧档保留。请求分支`a-requests-cde-1123`；本件不是已合main的功能。群公告由用户复制发送，不把上传请求记作队员已收到或已接单。

## 用户本轮明确批准

**批准C提出的跨机器交付方式**：C在自己的独立本地目录按同一候选组合完成验收，使用SQLite备份机制生成一致备份及SHA-256，再由A接收、核验并放到`E:\Hackathon\validation-1124\d5-acceptance\app.sqlite`。C机器无需E盘；该路径是A最终接收位置，不是C必须创建的盘符。本批准已生效，不需再次等待同一批准。

在指定数据/代码回执实际到达并被A核验前，验收库仍**NOT_READY**。不把路径或批准本身当数据就绪，不对空路径运行正式验收，不把DB/备份/私人内容提交GitHub。

## 两份A补丁已实际发布

| 分支 | 完整SHA | 已验与限制 |
| --- | --- | --- |
| `a-d5-null-fix-1124` | `832b0e8d90b306ea784e80682da81d3891db3afa` | 含D f772da6/6db1622；修显式null不回退模板，新增toFixedSnapshot，改S20及4回归。200主测试/20自检/类型lint/契约投递检查通过；本轮复验4/20通过。C4尚须接入 |
| `a-slider-fix-1124` | `a698cc3096923a85d9ceb2d6eb9de87372a171fe` | 含A-E5 e80b6c2及K6；仅滑块200ms合并保存、结束/取消/离页flush最新值。212主测试/类型lint/webpack生产构建/桌面真实页面过。用户iPhone真机待反馈，闪退仍OPEN |

两支GitHub ref/tree/各4个变更blob均独立回读一致，未合main。main仍`dd5f53ebb214bc5f8ee4959b95bfeac74a055200`。不要重复merge已含祖先或另写一份同类补丁。

历史正式用法：`deriveSnapshot(db,dogId,{occurrenceFacts:readFixedFacts})`保留完整result，传`toFixedSnapshot(result,meta)`后才能存正式版本。旧toSnapshot只是形状校验。C维护事实adapter；明确null留缺、historyFixed=false，不用今天的模板补造过去。旧D接入存档以A新接入说明为当前用法，旧档不改。

## 必须按闸交接：C先交，A发同一基线，D再接，不必先合main

| 闸 | 当前/前置 | 责任人与交付 | 后续可开始 |
| --- | --- | --- | --- |
| G0 A补丁已交 | READY，精确SHA如上 | A已修null与滑块 | E/用户可立即复测滑块；D不要重做null；C可查正式转换入口 |
| G1 C事实源码交付 | C39da31b在本轮远端核验中仍未推 | C先将现有本地候选推审查分支，回完整SHA、v7/注册、同事务事实捕获、唯一DB adapter导出路径/类型、null旧记录策略及测试命令 | A核真实代码；D不猜C本机schema、不复制第二adapter |
| G2 A联合基线READY | 依赖G1，不是现在已存在的分支 | A把K6+A-E5、已审C7/C8、D历史+A null修补、C v7/adapter统一集成到审查分支；核祖先和冲突，发布真实分支+完整SHA+纳入清单/命令 | C/D从**同一A回执SHA**分别开新接入分支；不用等合main，也不能只拉main |
| G3 C/D接线回交 | 依赖G2 | C只改C7权限/C4 start冻结绑定，D只改只读CLI/探针以import C adapter，分别回分支/SHA/命令；A串行集成验证两份回交 | A发布本批**执行基线READY**：最终组合分支、完整SHA、schema版本、五狗执行命令 |
| G4 C唯一写五狗批次 | 必须等G3执行基线READY；不能拿各自单支冒充联合批次 | C按该组合在本地独立库可信入口跑01/05/07/12/18各至少1趟；可空并说明原因；写完退出全部写进程，交一致备份/hash/回执 | A接收核验、放指定E盘，发**数据库READY**回执 |
| G5 D只读与A合并 | 依赖数据库READY+最终组合SHA | D对A指定同一备份只读，输出5只证据及historyFixed/源标识；A完成最终组合门禁和页面链路后合main | 需要重跑由A另开批次，不能D读时C继续写同一验收库 |

**现在没有G2/G3 READY分支或SHA，不让D自行猜一个分支开始联合接入。** A收到C实际分支后负责下一次交接回执；队员不用等用户批准技术整合。G2回执与G3回执须分别标识，不能把“接口基线可开发”当“执行批次已固定”。

### G2回执必须包含

状态`接口基线READY`、实际分支/完整SHA、K6/v7及各候选纳入SHA、adapter文件/导出/调用类型、分别分配C/D文件范围、复验命令。G3则写`执行基线READY`、组合SHA/schema、五狗命令和批次ID。A未发回执之前，不在公告提前写已就绪。

## 已发布候选如何取

在自己的克隆中执行，每行独立；新worktree目录必须未占用，保留现有本地修改和39da31b历史，不reset、不强推。

历史候选仅供先查阅/测试，不要求C整支合进自己已包含D副本的候选：

```powershell
git fetch origin refs/heads/a-d5-null-fix-1124:refs/remotes/origin/a-d5-null-fix-1124
git rev-parse origin/a-d5-null-fix-1124
git worktree add --detach ..\review-a-d5-1124 832b0e8d90b306ea784e80682da81d3891db3afa
```

输出SHA须等于上表，否则先看A最新回执。C先push自己的当前原候选，A集中处理分支重叠；D不重复cherry-pick旧6db1622/f772da6。

E本地复测滑块：

```powershell
git fetch origin refs/heads/a-slider-fix-1124:refs/remotes/origin/a-slider-fix-1124
git rev-parse origin/a-slider-fix-1124
git worktree add --detach ..\test-a-slider-1124 a698cc3096923a85d9ceb2d6eb9de87372a171fe
```

用户本机测试由A已启动服务，不需用户拉代码。E在自己环境运行仍须使用独立、符合既有开发身份开关与命名的数据库，不能关鉴权/借生产库测试。

G2之后C/D的具体fetch/worktree命令由A随**真实READY SHA**一起回，不提供可误执行的占位分支。两人各自独立接入分支，从同一SHA起步，不互相merge对方整支；共同文件由A/C责任人处理。adapter若后续需改，由C回单独修订、A核后更新基线，再告知D取新SHA，避免边读边猜。

## 文件独占与可并行项

- A负责本轮snapshot-derive.ts/null保护、adopt-page.tsx/draft-save.ts、wiring、联合基线和主干；D/E不平行改同一补丁。要交回写权先经A记新基线与移交。
- C唯一负责v7/迁移注册、事件事实写入、只读DB adapter、C7可信seed scope与C4 start。D直接import，不建第二表、不写第二读取器。C start正式事务内先识别重试已绑定，再派生/验证/分配保存/绑定/开始投递；失败整体回滚；C7在running阶段执行，不嵌套start事务。
- D在G2前可独立修演练导出脚本Windows中文路径/绝对路径兼容；G2后接CLI/探针，不碰C schema/start。接真实adapter后历史探针转绿进入回归，不重复已关闭waiting/只读/只插不改。
- E/用户现在可测滑块，不等D5；E只回设备/浏览器版本、SHA、实际现象和证据，不改A领养页，不重做书店/E11。E7照用户已定联网回看/收到礼物首版推进，离线/主动收藏后补。
- C交G1接口提交后，单独定稿POST /api/chat契约，由A审合main后B再接真实发送。这是B现有明确前置，和D“联合分支即可开发”不同。B保留示例标记，不重做已合ReplyBody。
- D6 POST候选已交待审，不重写；E6新发件仍等D7/关系写能力和组合验收，不作为本轮D5库前置。

## 跨机器备份的具体交付

C备份前停止所有写进程，使用SQLite Online Backup API或等效一致性备份机制；WAL模式不得只拷app.sqlite遗漏-wal。交付：批次ID、原执行组合SHA、C/D纳入SHA、schema版本、五狗tripId/seq/status/开始结束时间/事件或Find源标识或空原因、复跑命令、备份文件名/字节数/SHA256。数据库不进Git，用团队已同意的私下传递渠道交A，不在公开请求暴露内容。

A核SHA256、SQLite integrity_check/foreign_key_check、版本与五狗清单及代码对应后放指定位置，只有通过才发数据库READY。D只读证据同样带hash/代码SHA/schema，且读前后hash保持一致。无事件/Find空合法；A另用受控有事件回归验冻结，不为五狗演示造经历。

## 本轮iPhone测试

用户确认iPhone与电脑在同一局域网。A已运行独立测试服务，运行源码为滑块完整SHA`a698cc3096923a85d9ceb2d6eb9de87372a171fe`，未混入D5或新C候选。地址由A直接交用户，不公开提交局域网IP/库/日志到GitHub。手机是否连通与真机闪退结果需用户反馈；桌面HTTP/浏览器检查不能替代。

先测微信：测试身份→名字/兴趣→性格页→每个滑块拖几轮/松手/中断触摸→切步返回→刷新。反馈“能否打开、设备/iOS/浏览器版本、在哪步、具体是回首页/白屏/网页关闭/微信退出、最新值是否保留”。Safari可作为同机对照，不能用Safari通过替代微信通过。尚未关闭闪退问题。
