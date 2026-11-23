#!/usr/bin/env bash
# 社交自检（d4 / d5）—— 相遇 / 礼物 / 捎话 / 存储契约 / 双连接事务 / 快照形状
#
#   bash scripts/check-social.sh
#
# 接进 check-all.sh 只需要一行（c 加，d 不改那个文件）：
#
#   bash scripts/check-social.sh || FAIL=1
#
# 为什么单独一个文件：`check-all.sh` 只有 c 能改，而这六个用例是 d 的。
# 单独跑能让 d 每次提交前自查；接进总门禁时也不动 c 已有的四道编号。
#
# 这六个文件里的失败都会把退出码置 1（各自的 `process.exitCode = 1`），
# 所以只看退出码就够，解析输出只是为了打印一行给人看。

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

TESTS="rules meet gift store.contract tx.concurrency snapshot"
FAIL=0

for t in $TESTS; do
  f="lib/social/$t.test.ts"
  if [ ! -f "$f" ]; then
    printf '  %-16s 缺少 %s\n' "$t" "$f"
    FAIL=1
    continue
  fi

  out=$(node --experimental-strip-types "$f" 2>&1)
  code=$?

  # 汇总行两种写法：「通过 N 条，失败 0 条」与「结果：N 通过，0 失败」。取最后一条。
  summary=$(printf '%s\n' "$out" | grep -E '通过 [0-9]+ 条|结果：[0-9]+ 通过' | tail -1)

  if [ $code -ne 0 ]; then
    printf '  %-16s 失败  %s\n' "$t" "${summary:-（没有汇总行，可能启动就报错）}"
    printf '%s\n' "$out" | grep -E '❌|Error' | head -5 | sed 's/^/      /'
    FAIL=1
  else
    printf '  %-16s 通过  %s\n' "$t" "${summary:-}"
  fi
done

echo

if [ $FAIL -ne 0 ]; then
  echo "社交自检有失败用例，修完再提交。"
  exit 1
fi
echo "社交自检全部通过。"
