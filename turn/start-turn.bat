@echo off
rem ===================================================================
rem  MeshLLM TURN launcher
rem
rem  Pure-JS STUN/TURN server for cross-NAT calls.
rem  No Docker and no coturn needed - just Node.js.
rem
rem  ASCII-only on purpose : no codepage switching and no UTF-8 BOM,
rem  so this file behaves the same on every Windows machine.
rem ===================================================================
setlocal EnableExtensions EnableDelayedExpansion

set "PORT_TURN=3478"
set "RELAY_MIN=49160"
set "RELAY_MAX=49200"
set "LOG=%~dp0turn.log"

cd /d "%~dp0"
title MeshLLM TURN

>  "%LOG%" echo ==========================================================
>> "%LOG%" echo === MeshLLM TURN start   %date% %time%
>> "%LOG%" echo === folder : %CD%

call :main
set "RC=!errorlevel!"
>> "%LOG%" echo === exit code = !RC!

echo.
if "!RC!"=="0" (
  echo   TURN stopped.
) else (
  echo   TURN stopped with code !RC!. See turn.log for details.
)
echo.
pause >nul
exit /b !RC!


rem ===================================================================
:main

echo.
echo   ============================================================
echo    MeshLLM TURN server
echo   ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [error] node not found in PATH.
  echo   [error] Install Node.js 20 or newer, then run this again.
  >> "%LOG%" echo [error] node not found in PATH
  exit /b 2
)

if not exist "node_modules\turn-server\package.json" (
  echo   [setup] installing turn-server ...
  >> "%LOG%" echo [setup] npm install begin
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [error] npm install failed.
    >> "%LOG%" echo [error] npm install failed
    exit /b 3
  )
  echo   [setup] install OK
)

echo   listen      : UDP and TCP on 0.0.0.0:%PORT_TURN%
echo   relay ports : %RELAY_MIN%-%RELAY_MAX%
echo   credentials : meshllm / meshllm-devnet
echo.
echo   Tell the server about it in server\.env :
echo.
echo     MESH_TURN_URLS=turn:YOUR-LAN-IP:%PORT_TURN%?transport=udp,turn:YOUR-LAN-IP:%PORT_TURN%?transport=tcp
echo     MESH_TURN_USERNAME=meshllm
echo     MESH_TURN_CREDENTIAL=meshllm-devnet
echo.
echo   Starting now ... press Ctrl+C to stop.
echo.

node server.mjs
exit /b %errorlevel%
