@echo off
chcp 65001 >nul
title SteamLens - Steam 透镜（在线版）
cd /d "%~dp0"
rem 走盘符扫描，不调用 reg.exe（个别安全软件会拦截它并连带杀掉进程树）
set "STEAMLENS_NO_REG=1"

rem ---- 找 Node.js：优先用软件自带的便携运行时，没有再用系统安装的 Node.js ----
set "NODE_EXE="
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if not defined NODE_EXE (
  for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
)
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo.
  echo   [x] 在线版无法启动：没有找到 Node.js。
  echo       请安装 Node.js 18+ 后重试： https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   SteamLens 在线版正在启动...
echo   面板： http://127.0.0.1:8787/
echo.
echo   Node: "%NODE_EXE%"
echo.

rem ---- 1) 确保 24 小时常驻守护在跑（全机只跑一个，已在跑就什么都不做） ----
rem     守护会在后台无窗口拉起服务，且服务挂了会自动重拉；本窗口关掉不影响。
"%NODE_EXE%" "%~dp0keeper.js" --ensure >nul 2>&1

rem ---- 2) 等服务就绪，最多等约 30 秒 ----
set /a SL_TRIES=0
:wait
"%NODE_EXE%" "%~dp0healthcheck.js" >nul 2>&1
if not errorlevel 1 goto :open
set /a SL_TRIES+=1
if %SL_TRIES% GEQ 15 goto :fail
ping -n 3 127.0.0.1 >nul 2>&1
goto :wait

rem ---- 3) 只有确认服务健康，才打开「在线版」；绝不打开离线版 HTML ----
:open
echo   在线版已就绪，正在打开： http://127.0.0.1:8787/
start "" "http://127.0.0.1:8787/"
ping -n 2 127.0.0.1 >nul 2>&1
exit /b 0

rem ---- 4) 起不来就明确报错并停下 ----
:fail
echo.
echo   ============================================================
echo    [x] 在线版无法启动。
echo   ============================================================
echo    守护日志： "%~dp0data\keeper.log"
echo    服务日志： "%~dp0data\server.err.log"
echo    可能原因：
echo      1) 端口 8787 被其它程序占用；
echo      2) 安全软件拦截了 node.exe；
echo      3) Node.js 版本过低（需 18+）。
echo.
echo    手动排查（会显示具体报错）：
echo      "%NODE_EXE%" "%~dp0server.js"
echo.
echo    说明：本启动器只负责在线版，不会打开离线版。
echo          如需离线数据，请自行双击 SteamLens-Offline.html。
echo   ============================================================
echo.
pause
exit /b 1
