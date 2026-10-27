#!/usr/bin/env bash
# 一键安装：检查 Node → 装依赖 → 生成 .env → 装币安钱包命令行（baw）。装完用 ./start.sh 启动。
set -e
cd "$(dirname "$0")"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
need_node=22
if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node.js。请先安装 Node ${need_node} 或更新版本：https://nodejs.org （macOS 也可以 brew install node）"; exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt "$need_node" ]; then echo "Node 版本太旧（当前 $(node -v)），需要 ${need_node} 以上：https://nodejs.org"; exit 1; fi
say "1/3 安装依赖…"
npm install --no-audit --no-fund
say "2/3 生成配置文件…"
if [ -f .env ]; then echo ".env 已存在，不动它"; else cp .env.example .env && echo "已生成 .env（默认就能用，想改再编辑）"; fi
say "3/3 币安钱包命令行（baw）…"
if command -v baw >/dev/null 2>&1; then echo "已安装：$(command -v baw)"; else
  if npm i -g @binance/agentic-wallet >/dev/null 2>&1; then echo "已安装 baw"; else
    echo "自动安装 baw 失败（多半是权限）。请手动运行：  sudo npm i -g @binance/agentic-wallet"; fi
fi
say "完成。启动： ./start.sh   （然后在打开的页面里点「登录币安钱包」，用币安 App 扫码确认）"
