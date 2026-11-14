@echo off
chcp 65001 >nul
title SteamLens 悬浮面板

set "URL=http://127.0.0.1:8787/?overlay=1"
set "B="

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "B=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined B if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "B=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined B if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "B=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined B if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "B=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

echo.
echo   SteamLens 悬浮面板
echo   以独立无边框窗口打开，可放在 DeepSeek 窗口旁边。
echo   请先运行「启动 SteamLens.bat」启动本地服务。
echo.

if defined B (
  start "" "%B%" --app="%URL%" --window-size=470,780
) else (
  echo   未找到 Edge / Chrome，改用默认浏览器打开。
  start "" "%URL%"
)
timeout /t 2 >nul
exit /b 0
