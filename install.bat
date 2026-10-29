@echo off
chcp 65001 >nul
rem 一键安装（Windows）：检查 Node -> 装依赖 -> 生成 .env -> 装币安钱包命令行 baw。装完双击 start.bat 启动。
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没找到 Node.js。请先安装 Node 22 或更新版本：https://nodejs.org  ^(装完重新打开这个窗口^)
  pause & exit /b 1
)
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo Node 版本太旧，需要 22 以上：https://nodejs.org
  pause & exit /b 1
)
echo.
echo 1/3 安装依赖...
call npm install --no-audit --no-fund
if errorlevel 1 ( echo 依赖安装失败，请检查网络后重试 & pause & exit /b 1 )
echo.
echo 2/3 生成配置文件...
if exist .env ( echo .env 已存在，不动它 ) else ( copy /y .env.example .env >nul && echo 已生成 .env，默认就能用 )
echo.
echo 3/3 币安钱包命令行 ^(baw^)...
where baw >nul 2>nul
if errorlevel 1 (
  call npm i -g @binance/agentic-wallet
  if errorlevel 1 ( echo 自动安装 baw 失败。请用「管理员」打开命令提示符手动运行：npm i -g @binance/agentic-wallet ) else ( echo 已安装 baw )
) else ( echo baw 已安装 )
echo.
echo 完成。双击 start.bat 启动，然后在页面里点「登录币安钱包」，用币安 App 扫码确认。
pause
