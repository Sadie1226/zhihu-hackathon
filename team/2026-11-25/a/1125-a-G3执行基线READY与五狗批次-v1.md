# G3执行基线READY与五狗批次 v1

状态：**执行基线READY**（以A请求分支的精确完整组合SHA回执为准）。分支`a-d5-execution-ready-1125`，schema **v7**。默认HTTP、主人/可信种子start均已接正式快照builder。不是正式五狗数据库READY，不是main已合，不代表完整P0闭环完成。

## 纳入与审查

- 共同接口基线`582376e46de365dcd72ff324676662e2c3cdab75`及其K6/A-E5/滑块/D历史/C7/C8祖先。
- C G3 `f70212d38fe1b13f48094d8989801229eaf74829`（含实现8e81255），默认v7登记、单一正式builder、快照绑定/start/投递同事务、owner/seed共用、C7 forSeed运行态授权。
- D读取 `94462a74636f03818125b0e1e9fad703ad9dfcde`，最早occurrence不JOIN当前模板、时间按julianday，CLI默认唯一reader、探针走真实C4/C7捕获。
- A组合修补：shape自检夹具仅保留v6诊断（不冒充v7业务写入）；真实链探针分配新快照版本而非与G3 start已有v1冲突。加入受控批次脚本，不重写C/D业务。

组合源码没有冲突但原诊断脚本存在上述运行冲突，A实际复现并修复，未直接沿用成员自报绿灯。原243主测试/契约投递、17项C专项、2项构建后隔离生产HTTP、类型/lint、webpack生产构建、207社交、D4 E2E均由A/独立审查按范围核验；D自检22/22和真实历史探针三项转绿。A受控脚本已在独立**工具冒烟批次**运行5狗及SQLite backup、D CLI只读通过；该批不是C正式验收，不交到指定库、不替代C回执。

## D的code字段裁定

本批接受正式evidence.event.code=null。event.id、factSourceId中的trip/event标识及v7冻结视图可追溯，摘要/文本固定，不用今天code伪装当时code。不要求C/D为了补一个展示字段再次改adapter；后续若确需显示code，另交可选增量，读取event_code_at_occurrence，不影响本轮执行READY。

## C现在执行：唯一正式批次

批次ID：`d5-1125-c01`。A在请求回执给出本分支完整SHA后，C从该SHA建新的独立工作树，安装依赖，不带未提交源码改动。脚本会核HEAD/干净跟踪文件并拒绝已存在输出目录；不支持force删除，不操作默认应用库。

```powershell
node scripts/c4/d5-acceptance-batch.mjs --out-dir '<你机器上未存在的独立目录>' --batch d5-1125-c01 --code-sha '<A回执完整组合SHA>'
```

该命令的路径和SHA是待替换参数，具体执行示例在A精确回执。Windows如Node找不到git，可先设`$env:GIT_EXE`为本机实际git.exe；不要将别人的Windows路径硬用于其他系统。

脚本：历史v5初始化并导原20狗→真实v6/v7迁移保留旧装配→导原事件池及已审两条条件补丁→5只01/05/07/12/18用稳定意图真实create/start/selectEvent/finish→验证绑定与同意图重试→SQLite Online Backup→关闭源/备份连接→写manifest及SHA256。五狗各一趟done，受控时钟每狗间隔1小时，每狗只一趟，遵守原配额和间隔。

**不编真实场景/天气**：本批无可信环境输入，selectEvent(null)正常为空；种子禁真实搜索，Find为空。manifest逐狗说明原因。有事件链由已通过的受控专项及真实C4/C7历史探针另证，不为每狗凑事件。若要演练真实条件批次，由A另定新ID与事实来源，不改此批参数去造天气。

输出`source.sqlite`为本机工具源库，交付只用一致备份`app.sqlite`、`manifest.json`、`SHA256.txt`及命令退出0记录。manifest带组合SHA、schema7、5狗tripId/seq/status/开始结束/快照版本/事件Find标识或空原因、字节数/hash。运行进程退出后再交接，不再写此批。若失败保留目录供排错，不删已验库重跑；A分配新批次/新目录。

## 跨机接收与D只读

用户已批准：C本地独立目录→一致SQLite备份+SHA256→A核后放`E:\Hackathon\validation-1124\d5-acceptance\app.sqlite`，C不需E盘。DB/私人内容不进Git，用团队现有私下渠道传A。**A指定位置当前未就绪，只有接收核验后才发数据库READY。**

A核hash、integrity/foreign-key、schema、5狗回执和执行代码SHA后放目标，D收到数据库READY才对同一备份只读：

```powershell
node scripts/d5-derive-snapshot.mjs --db '<A确认的备份路径>' --out '<独立证据文件>'
```

D带组合SHA、库hash/版本、五狗historyFixed及来源证据；读前后hash不变，不更新/补造/覆盖snapshot。C需要重跑先交A另开批次，不能D读同库时继续写。无事件的historyFixed=true只表示无可变文本污染，不算“有事件路径验收”，有事件证据另列。

## 剩余边界与每日顺序

旧unverifiable历史会使下一次正式start返回409/HISTORY_UNVERIFIABLE，事务不留半快照/投递；旧running/终态不回填绑定。此为诚实拒写，不是恢复旧文案，不可隐瞒存量体验限制。

C6 Phase3原59fac52存在当前模板JOIN、owner/seed scope及C9 cache producer缺口，未纳本执行基线；C新兼容审计是方案不是修复实现。先以本G3稳定SHA供C6单独修复，避免抢start/adapter/迁移文件。C10/C11正式执行器/时间拨盘尚未接，脚本受控时钟不当正式调度。B5/Message真实生成、D6 POST/组件、C14真实模型也不随本批自动通过。

聊天契约与B7独立：聊天契约审合main后给B SHA解锁真实POST，B7当前错误态/取消恢复需定向修正，A不先绑用户入口；两项都不阻塞C本批跑五狗。A接收库/D只读后再做每日主干集成，不现在强合全部候选。
