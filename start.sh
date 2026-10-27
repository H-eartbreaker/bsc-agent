#!/usr/bin/env bash
# 启动并自动打开浏览器。Ctrl+C 退出。
cd "$(dirname "$0")"
[ -d node_modules ] || { echo "还没安装依赖，先运行 ./install.sh"; exit 1; }
PORT_=$(sed -n 's/^PORT=\([0-9]*\).*/\1/p' .env 2>/dev/null | tail -1); PORT_=${PORT_:-8787}
( sleep 3; { command -v open >/dev/null && open "http://localhost:${PORT_}"; } || { command -v xdg-open >/dev/null && xdg-open "http://localhost:${PORT_}"; } ) >/dev/null 2>&1 &
exec node server.js
