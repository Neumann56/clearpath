@echo off
cd /d %~dp0
del .stop-server 2>nul
echo 正在启动通途 CLEARPATH...
start http://localhost:4173
node server.js
pause