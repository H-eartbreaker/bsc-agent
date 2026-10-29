@echo off
chcp 65001 >nul
rem 启动并自动打开浏览器。关闭这个窗口或按 Ctrl+C 退出。
cd /d "%~dp0"
if not exist node_modules ( echo 还没安装依赖，请先双击 install.bat & pause & exit /b 1 )
set PORT_=8787
if exist .env for /f "tokens=2 delims==" %%p in ('findstr /b /c:"PORT=" .env') do set PORT_=%%p
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:%PORT_%"
node server.js
pause
