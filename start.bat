@echo off
chcp 65001 >nul
title TanBaiJu Server
echo.
echo   Starting TanBaiJu...
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js not found in PATH.
  echo   Please install Node.js from https://nodejs.org
  pause
  exit /b 1
)
echo   Opening http://127.0.0.1:8848
start "" http://127.0.0.1:8848
echo   Close this window or press Ctrl+C to stop the server.
echo.
node server.js
pause