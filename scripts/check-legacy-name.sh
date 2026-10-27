#!/bin/bash
# 推送前检查：旧项目名不能出现在「文件内容 / 文件名 / 提交信息」里。用法：bash scripts/check-legacy-name.sh [提交号，默认 HEAD]
REF="${1:-HEAD}"; PAT='t[m]tn'; bad=0
f=$(git grep -Iil -E -e "$PAT" "$REF" -- . ':!scripts/check-legacy-name.sh' 2>/dev/null | sed "s#^$REF:##"); [ -n "$f" ] && { echo "✗ 这些文件内容里有旧名字："; echo "$f" | sed 's/^/    /'; bad=1; }
n=$(git ls-tree -r --name-only "$REF" | grep -iE "$PAT"); [ -n "$n" ] && { echo "✗ 这些文件名里有旧名字："; echo "$n" | sed 's/^/    /'; bad=1; }
exit $bad
