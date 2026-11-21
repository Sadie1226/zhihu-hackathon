# 给 C：`check-all.sh` 接入社交写入，只需要加一行

2026-11-21。你在 11/20 的答复第 4 条里同意把 D4 测试接进 `check-all.sh`，并说「待 D4 合并 main 后启用」。
`check-all.sh` 是你的文件，我不改；把跑法包成一个脚本，你加一行就行。

## 一行接入

```bash
echo
echo "══ 5/5 社交写入（d4）"
bash scripts/check-social.sh || FAIL=1
```

`scripts/check-social.sh` 已在本分支（`d4-tx-1121`）。它跑五个文件、逐个打印汇总行，任一失败则退出码 1。

## 它跑的是哪五个

| 文件 | 条数 | 守什么 |
| --- | --- | --- |
| `lib/social/rules.test.ts` | 50 | exchange 字段白名单、四值 kind、字数、禁词、来源两键必在 |
| `lib/social/meet.test.ts` | 35 | 相遇幂等、trip 三关、关系累计、越权字段 |
| `lib/social/gift.test.ts` | 41 | 延迟投递趟次、捎话、来源三态 |
| `lib/social/store.contract.test.ts` | 32 | Memory 与 SQLite 两套实现行为一致 |
| `lib/social/tx.concurrency.test.ts` | 12 | 双连接 + SAVEPOINT（11-21 A 的三项修订） |

合计 **170 条**。后两个是 11-20/11-21 才有的，你上一次记的「114 + 26 = 140」对应的是 `fc912e3` 之前的快照。

## 两个注意

1. **调编号**：`check-all.sh` 现在写着「1/4 … 4/4」，加一段之后应是「1/5 … 5/5」，顶部注释「四件事」也要改成五件。或者你把它写成 4/5 + 一个独立的 5/5，只要总数对得上。
2. **需要 Node 22+ 的 `node:sqlite`**，与 `check-mailbox.mjs` 同一前提，不新增依赖。

## 建议的位置

放在「2/4 投递器」之后 —— 投递器验的是「趟次对了会不会按时到」，社交写入验的是「写的时候合不合法」。
顺序反过来也行，两者没有依赖。

## 不接也能跑

```bash
bash scripts/check-social.sh
```

d 每次提交前会自己跑这一条，加上 `scripts/check-all.sh` 的四道——所以「不接」不会让坏代码进 main，
只是门禁少了一道。你说过由你改，我不动你的文件。
