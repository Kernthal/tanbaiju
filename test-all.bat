@echo off
chcp 65001 >nul
title TanBaiJu Test Runner
cd /d "%~dp0"

echo.
echo   Running QR codec verification...
echo.
node test/qr-verify.js
if errorlevel 1 goto :fail

echo.
echo   Running API end-to-end tests...
echo.
node test/api-e2e.js
if errorlevel 1 goto :fail

echo.
echo   Running UI smoke tests...
echo.
node test/ui-smoke.js
if errorlevel 1 goto :fail

echo.
echo   ALL TESTS PASSED
echo.
pause
exit /b 0

:fail
echo.
echo   TESTS FAILED
echo.
pause
exit /b 1