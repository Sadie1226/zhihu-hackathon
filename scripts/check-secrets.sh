#!/usr/bin/env bash
# 提交前密钥扫描。任何一项命中就退出码 1，不许提交。
#
# 用法：bash scripts/check-secrets.sh
# 也会被 check-all.sh 调用。

set -u
FAIL=0

PATTERNS=(
  'github_pat_[A-Za-z0-9_]{20,}'          # GitHub fine-grained PAT
  'ghp_[A-Za-z0-9]{36}'                  # GitHub classic PAT
  'gho_[A-Za-z0-9]{36}'                  # GitHub OAuth
  'ghs_[A-Za-z0-9]{36}'                  # GitHub server-to-server
  'sk-ant-[A-Za-z0-9_-]{20,}'            # Anthropic
  'sk-[A-Za-z0-9]{32,}'                  # OpenAI 类
  'AKIA[0-9A-Z]{16}'                     # AWS
  'xox[baprs]-[A-Za-z0-9-]{10,}'         # Slack
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'   # 私钥
)

echo "== 密钥扫描 =="

# 1. 扫所有会被提交的文件（排除 .git 和 node_modules）
for p in "${PATTERNS[@]}"; do
  hits=$(grep -rEn "$p" . \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=.next \
    --exclude="check-secrets.sh" \
    2>/dev/null)
  if [ -n "$hits" ]; then
    echo "❌ 命中模式: $p"
    echo "$hits" | head -5
    FAIL=1
  fi
done

# 2. 检查暂存区（防止 .gitignore 漏掉的被 add 进来）
if git rev-parse --git-dir >/dev/null 2>&1; then
  staged=$(git diff --cached --name-only 2>/dev/null)
  if [ -n "$staged" ]; then
    for f in $staged; do
      case "$f" in
        .env|.env.*|*credentials*|*secret*|*.pem|*.key)
          if [ "$f" != ".env.example" ]; then
            echo "❌ 暂存区里有疑似密钥文件: $f"
            FAIL=1
          fi
          ;;
      esac
    done
  fi
fi

# 3. 检查 .env 是否真的被忽略
if git rev-parse --git-dir >/dev/null 2>&1; then
  if [ -f .env ] && ! git check-ignore -q .env 2>/dev/null; then
    echo "❌ .env 存在但没有被 .gitignore 忽略"
    FAIL=1
  fi
fi

if [ $FAIL -eq 0 ]; then
  echo "✅ 无密钥泄漏"
else
  echo ""
  echo "修法：删掉命中的内容，或把文件加进 .gitignore。"
  echo "如果已经提交过：先去对应平台吊销该密钥，再清历史。顺序不能反。"
fi

exit $FAIL
