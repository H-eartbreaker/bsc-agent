#!/usr/bin/env bash
# 一键开启历史数据缓存（可选）：装依赖、用 Docker 起 MySQL + Redis（端口只开在本机）、把连接地址写进 .env。
# 可以重复运行：.env 里已经有 MYSQL_URL 就沿用里面的密码（数据库第一次建好后密码就定了，换密码会连不上）。
# 关掉缓存：把 .env 里的 MYSQL_URL / REDIS_URL 清空再重启；删数据：docker compose -f docker/cache-compose.yml down -v
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "没找到 docker：先装 Docker Desktop 或 OrbStack，再运行这个脚本"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker 没在运行：先打开 Docker Desktop / OrbStack"; exit 1; }

touch .env
pw=$(sed -n 's#^MYSQL_URL=mysql://bscagent:\([^@]*\)@.*#\1#p' .env | tail -1)
if [ -z "$pw" ]; then
  pw=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
  printf '\n# 历史数据缓存（scripts/enable-cache.sh 写的；清空这两行再重启就关掉）\nMYSQL_URL=mysql://bscagent:%s@127.0.0.1:13306/bscagent\nREDIS_URL=redis://127.0.0.1:16379\n' "$pw" >> .env
  echo "已写进 .env：MYSQL_URL / REDIS_URL（密码随机生成，只在 .env 里）"
else
  grep -q '^REDIS_URL=redis' .env || printf 'REDIS_URL=redis://127.0.0.1:16379\n' >> .env
  echo ".env 里已经有 MYSQL_URL，沿用原来的密码"
fi

echo "安装依赖（mysql2 / ioredis）…"
npm install --no-audit --no-fund >/dev/null

echo "启动 MySQL + Redis…"
BSC_AGENT_DB_PASSWORD="$pw" docker compose -f docker/cache-compose.yml up -d

printf '等 MySQL 初始化'
for i in $(seq 1 60); do
  if docker exec bsc-agent-mysql mysqladmin ping -h 127.0.0.1 -ubscagent -p"$pw" --silent >/dev/null 2>&1; then echo " 好了"; break; fi
  printf '.'; sleep 2
  [ "$i" = 60 ] && echo " 还没好（第一次可能要拉镜像）。不影响使用：程序会每 30 秒自动重连"
done

echo "完成。重启 BSC Agent（npm start 或你平时的启动命令）后，打开 /api/cache-status 能看到 mysql / redis 都是 up"
