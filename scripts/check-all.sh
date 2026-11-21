#!/usr/bin/env bash
# 提交前自检。跑这一条，全绿才能推。
#
#   bash scripts/check-all.sh
#
# 五件事：契约一致 + 投递器正确 + 无密钥泄漏 + 禁词干净 + 社交回归。
# 在仓库根跑。需要 Node 24+，与 package.json 的支持环境一致。

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
FAIL=0

echo "══ 1/5 契约自检（schema + fixtures + 邀请三态）"
node scripts/check-contracts.mjs || FAIL=1

echo
echo "══ 2/5 投递器自检（时间语义 + 幂等）"
node scripts/check-mailbox.mjs || FAIL=1

echo
echo "══ 3/5 密钥扫描"
bash scripts/check-secrets.sh || FAIL=1

echo
echo "══ 4/5 禁词检查"
# 12 个禁词，出现在用户可见的地方就算违规，包括按钮、空状态、toast、报错文案。
# 「太棒了」也在里面 —— 表扬同样是评价，会让「不回应」显得像做错了事。
PAT='连续|打卡|天数|坚持|别忘|快回来|还剩|已过期|差一点|加油|你还没|已经很久|太棒'
# contracts/ 和 team/ 是规则文档，会引用禁词本身来解释规则，所以检查代码和页面。
HITS=$(grep -rnE "$PAT" app/ components/ lib/ 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "$HITS"
  echo "❌ 上面这些词不许出现在用户可见的地方"
  FAIL=1
else
  echo "✅ 禁词检查通过"
fi

echo
echo "══ 5/5 社交回归（相遇 + 礼物 + 存储契约 + 双连接事务）"
bash scripts/check-social.sh || FAIL=1

echo
echo "══════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  echo "✅ 全部通过，可以提交。"
else
  echo "❌ 有检查没通过，修完再提交。"
fi
exit "$FAIL"
