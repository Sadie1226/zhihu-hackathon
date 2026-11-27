# 给CD：G3执行基线READY与五狗批次请求

**执行基线READY**，2026-11-25 16:56 CST。分支`a-d5-execution-ready-1125`，完整组合SHA **`51775b5e1b6a975140e818d35ca17299cfb4fece`**，默认schema **v7**（本轮默认HTTP已升级，不再沿用G2默认v6说法）。main仍dd5f53e，未合main/部署。执行READY不等于正式五狗库READY。

## 纳入及核验

C `c-d5-start-wire-1124@f70212d38fe1b13f48094d8989801229eaf74829`和D `d-g2-facts-1124@94462a74636f03818125b0e1e9fad703ad9dfcde`同基582376e，A串行合并没有产品文件冲突。保留G2所有K6/A-E5/C7/C8/D历史祖先，未混入C6/D6/B7/聊天。

A实际复验243主测试+契约投递、17项C组合专项、构建后2项隔离生产HTTP、类型/lint、webpack生产构建、207社交和D4通过；D自检22/22及真实历史探针三问退出0。两处脚本组合问题已由A修：v7触发器不允许shape自检直接插终态历史，所以诊断夹具明确停在v6；真实G3 probe的start已存v1，后续派生保存改为MAX+1，拒覆盖保护保留。不是重做业务或放宽v7。

本轮裁定：D正式event.code=null可接受，不要求现在扩adapter；稳定eventId/factSourceId可追溯冻结视图，不能读当前code补过去。code展示若后续确需，再走独立增量。

## 取用与C唯一正式执行

先在自己的克隆取精确分支，保留已有修改，不reset、不强推；新分支和目录须未占用：

```powershell
git fetch origin refs/heads/a-d5-execution-ready-1125:refs/remotes/origin/a-d5-execution-ready-1125
if ((git rev-parse origin/a-d5-execution-ready-1125) -ne '51775b5e1b6a975140e818d35ca17299cfb4fece') { throw '执行基线SHA不匹配，请核A最新回执' }
git worktree add -b c-d5-batch-1125 ..\c-d5-batch-1125 51775b5e1b6a975140e818d35ca17299cfb4fece
Set-Location ..\c-d5-batch-1125
npm.cmd ci
node scripts/c4/d5-acceptance-batch.mjs --out-dir ..\d5-1125-c01 --batch d5-1125-c01 --code-sha 51775b5e1b6a975140e818d35ca17299cfb4fece
```

`..\d5-1125-c01`必须是本机未存在的独立目录；可替换成自己机器的路径，不要求E盘。非Windows用本机包管理命令。Node若找不到git，可将GIT_EXE设为本机实际git执行文件，不照抄别人的路径。脚本核HEAD/干净跟踪文件，拒覆盖目录；失败保留现场、回A分新批次，不force清原库。

批次ID固定**d5-1125-c01**。脚本按历史v5导原种子→真实v6/v7保装配→导事件池及两条补丁→dog_seed_01/05/07/12/18真实create/start/selectEvent(null)/finish→验证绑定/重试→SQLite backup→关闭连接→产manifest/hash。五只各1趟done，时间为受控演练，未提供可信天气/场景因此C7正常空，种子不做真实搜索因此Find为空，逐只写原因；不编经历凑事件。有事件固定另由受控probe/专项证明。

C回交：进程退出0、组合SHA、schema7、5狗Trip/seq/status/time/绑定版本/事件Find来源或空原因、app.sqlite字节数与SHA256、manifest.json、SHA256.txt及复跑命令。源source.sqlite仅本机工具库，交一致备份app.sqlite。A冒烟脚本已跑一独立a-smoke批次验证工具，但**不替代C正式批次**。

## 跨机与D只读的后半程

用户跨机器批准有效：C本地独立目录完成→SQLite一致备份+SHA256→私下渠道交A→A核hash/integrity/foreign-key/schema/Trip/代码SHA后放`E:\Hackathon\validation-1124\d5-acceptance\app.sqlite`并发**数据库READY**→D只读。目标库目前仍NOT_READY，C不需有E盘，不上传DB或私人内容至GitHub。

D现在可取本SHA自检，但等A数据库READY后才跑正式证据：

```powershell
node scripts/d5-derive-snapshot.mjs --db '<A确认的同一备份路径>' --out '<独立证据输出路径>'
```

带组合SHA/schema/hash及五狗historyFixed/来源；读前后hash一致。不在D读时C继续写同一批库；要重跑由A另分批次。之后A收尾组合门禁再合main。旧unverifiable历史会409拒下一次start且不半投递，不能冒称已恢复旧原文。

完整说明在执行分支`team/2026-11-25/a/1125-a-G3执行基线READY与五狗批次-v1.md`。
