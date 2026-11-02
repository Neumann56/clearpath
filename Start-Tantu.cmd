@echo off
rem ============================================================
rem  Tantu CLEARPATH - double-click launcher
rem  - starts the server if it is not running (auto-restarts on crash)
rem  - opens the browser as soon as /healthz answers
rem  - if already running, just opens the browser (no 2nd instance)
rem  Do not type Chinese in this file: cmd.exe reads it in GBK.
rem ============================================================
setlocal enableextensions
cd /d "%~dp0"
set "APP_PORT=4173"
set "APP_URL=http://127.0.0.1:4173/"

rem ---- locate node ----
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE (
  echo [ERROR] Node.js not found. Install Node 18+ or add it to PATH.
  echo.
  pause
  exit /b 1
)

if /i "%~1"=="serve" goto serve

rem ---- already running? ----
call :probe
if not errorlevel 1 goto open

echo [1/2] Starting Tantu CLEARPATH ...
if not exist "logs" mkdir "logs"
del /q ".stop-server" >nul 2>&1
start "Tantu CLEARPATH server - do not close" /min cmd /c ""%~f0" serve"

set /a n=0
:wait
call :probe
if not errorlevel 1 goto open
set /a n+=1
if %n% GEQ 40 goto fail
>nul timeout /t 1 /nobreak
goto wait

:fail
echo [ERROR] Server did not answer within 40 seconds.
echo         Last lines of logs\server.log:
echo ------------------------------------------------------------
powershell -NoProfile -Command "if (Test-Path 'logs\server.log') { Get-Content -Tail 25 'logs\server.log' }" 2>nul
echo ------------------------------------------------------------
echo.
pause
exit /b 1

:open
echo [2/2] Ready: %APP_URL%
start "" "%APP_URL%"
>nul timeout /t 2 /nobreak
exit /b 0

rem ------------------------------------------------------------
rem  serve: keep the server alive; restart it if it ever dies
rem ------------------------------------------------------------
:serve
title Tantu CLEARPATH server - do not close (run Stop-Tantu.cmd to stop)
echo Working dir : %CD%
echo Log file    : %CD%\logs\server.log
echo Press Ctrl+C or run Stop-Tantu.cmd to stop.
echo.
:loop
if exist "%~dp0.stop-server" goto bye
for %%A in ("%~dp0logs\server.log") do if %%~zA GTR 5242880 move /y "%~dp0logs\server.log" "%~dp0logs\server.old.log" >nul 2>&1
echo [%TIME:~0,8%] server starting ...
"%NODE%" server.js >> "%~dp0logs\server.log" 2>&1
echo [%TIME:~0,8%] server exited (code %ERRORLEVEL%), restarting in 3s ...
>nul timeout /t 3 /nobreak
goto loop
:bye
del /q "%~dp0.stop-server" >nul 2>&1
echo stopped.
>nul timeout /t 1 /nobreak
exit /b 0

rem ------------------------------------------------------------
rem  probe: 0 = /healthz answers 200, 1 = not up
rem ------------------------------------------------------------
:probe
"%NODE%" -e "fetch('http://127.0.0.1:%APP_PORT%/healthz',{signal:AbortSignal.timeout(2500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>&1
exit /b %ERRORLEVEL%
