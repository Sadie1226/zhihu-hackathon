# 给D：数据库READY与C批次接收回执

**数据库 READY**，核验时间2026-11-25 17:31 CST。批次 **d5-1125-c01**。

- 执行分支`a-d5-execution-ready-1125`，完整SHA `51775b5e1b6a975140e818d35ca17299cfb4fece`。
- schema **v7**；一致备份 **307200字节**。
- SHA-256：`442aeb3de567a32c2da9ea19fa9f62be9d7082729505b5f251fb58f4fa3a537e`。
- A接收位置：`E:\Hackathon\validation-1124\d5-acceptance\app.sqlite`，同目录已保留manifest.json和SHA256.txt；数据库及原始证据不在Git内。

## A实际核验

收到C三份交付文件，先只读检查原备份，再复制到指定E盘；没有修改或重跑C批次。数据库实际hash、manifest.sha256和SHA256.txt三方一致，bytes相同；`PRAGMA integrity_check=ok`，foreign_key_check空，user_version=7。

实际仅5条Trip，dog_seed_01/05/07/12/18各seq1、done、绑定Snapshot v1；逐条核Trip ID、开始/结束时间、快照时间与manifest相同。20只狗sample=1且无owner，未夹带主人记录。5条事件/Find均空，与回执一致：C7真实入口无可信条件传null、种子禁真实搜索，允许为空，没有凑造经历。manifest代码SHA/批次均为A指定值；C表示已退出写进程且不再修改，本地manifest记写连接已关闭。

源文件检查前后hash未变，E盘副本hash再核一致。A此前独立a-smoke不计本批，此READY只针对C正式备份。空结果不能证明有事件冻结路径；该路径已有真实C4/C7模板修改探针/专项证据，D报告分开列。

## D现在可只读验证

请从执行分支上述完整SHA取代码；不取旧G2/只拉main。使用只读CLI：

```powershell
node scripts/d5-derive-snapshot.mjs --db 'E:\Hackathon\validation-1124\d5-acceptance\app.sqlite' --out '<你选择的独立证据文件路径>'
```

D机器无E盘时，通过团队私下渠道取**同一hash的app.sqlite/manifest/SHA256.txt**到本地目录，命令--db改成本地路径；不得假设E盘是共享盘，也不得上传DB到GitHub。A本地路径是接收目标，不要求跨机器创建E盘。

请输出5只狗各自Trip/状态/绑定版本、historyFixed及事件Find空原因，带代码SHA/schema/数据库hash，读前后SHA256应一致。无事件historyFixed=true表示没有可变事件文本，不等于每狗都有冻结事件。不要调用写入口、改库、补事件/Find、覆盖快照；C已冻结本批，不重跑。若需数据重跑先由A另开批次。

**D独立只读验收仍待回交；本READY不自动宣告D5最终完成或main已合。** A没有将自己的核库/工具冒烟替代D回执。D现有正式event.code=null裁定保留，不为此阻塞本批，稳定eventId/factSourceId可追溯。
