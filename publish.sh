#!/bin/bash
# 安全发布到 GitHub：不强推、不覆盖远端历史；提交里不带旧名字、不带私人信息。
set -e
cd "$(dirname "$0")"
git fetch origin main
TS=$(date +%Y%m%d-%H%M%S)
git branch "backup-before-sync-$TS"
EM=$(git config user.email)
case "$EM" in *users.noreply.github.com) ;; *) echo "✗ 提交邮箱不是 noreply（现在是：${EM:-空}），已停止"; exit 1;; esac
# 新提交 = 本地最新内容，接在远端 main 后面（普通快进）
export GIT_INDEX_FILE="$(git rev-parse --git-dir)/tmp-index"; rm -f "$GIT_INDEX_FILE"
git read-tree origin/main                      # 先拿远端现有内容（它的 .gitignore / .env.example 会保留）
git ls-tree -r HEAD | git update-index --index-info   # 再把本地内容盖上去
git add -f scripts/check-legacy-name.sh
TREE=$(git write-tree); [ -n "${TREE}" ] || { echo "✗ 内容树为空，已停止"; exit 1; }; unset GIT_INDEX_FILE; rm -f "$(git rev-parse --git-dir)/tmp-index"
if [ "$TREE" = "$(git rev-parse origin/main^{tree})" ]; then echo "远端已是最新，无需推送"; exit 0; fi
C=$(git commit-tree "$TREE" -p origin/main -m "chore: sync public release and add repo checks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WySNg1WtPPZ9s43U4G3hht")
echo "将推送提交 ${C} （普通推送，不强推）。检查钩子会先运行。"
[ -n "${C}" ] || { echo "✗ 提交编号为空，已停止，没有推送"; exit 1; }
git push origin "${C}:refs/heads/main"
git reset -q --hard "${C}"
echo "✓ 完成。旧本地记录保存在分支 backup-before-sync-$TS"
