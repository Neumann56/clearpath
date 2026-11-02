@echo off
rem ============================================================
rem  Tantu CLEARPATH - stop the server
rem  Do not type Chinese in this file: cmd.exe reads it in GBK.
rem ============================================================
setlocal enableextensions
cd /d "%~dp0"
set "APP_PORT=4173"

echo Stopping Tantu CLEARPATH ...
rem tell the keeper window not to restart
type nul > ".stop-server"

set "HIT="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%APP_PORT% .*LISTENING"') do (
  set "HIT=1"
  taskkill /F /PID %%p >nul 2>&1
  if not errorlevel 1 echo   stopped process PID %%p
)

if not defined HIT (
  del /q ".stop-server" >nul 2>&1
  echo   nothing was listening on port %APP_PORT%.
)

echo Done.
>nul timeout /t 2 /nobreak
exit /b 0
