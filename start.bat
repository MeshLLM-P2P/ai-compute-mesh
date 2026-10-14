@echo off
:: ===========================================================================
:: MeshLLM one-click launcher (Windows)  -  FIXED
::
::  What it does:
::    1. Checks Node.js / npm are installed.
::    2. Runs `npm install` only when node_modules is missing (first run).
::    3. PORT PRE-FLIGHT: finds and kills stale processes still holding
::       4011 (server/API) and 5173 (web).  This fixes the crash:
::          "Error: listen EADDRINUSE: address already in use 0.0.0.0:4011"
::       which happens when a previous session left its processes running
::       (and Vite then bounces to a random port).
::    4. Starts `npm run dev` (server + web via concurrently).
::    5. On Ctrl+C, best-effort cleanup so ports are released next run.
::
::  Usage: double-click, or run from a console. Press Ctrl+C to stop.
:: ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion

set "PORT_API=4011"
set "PORT_WEB=5173"
set "LOG=%~dp0start.bat.log"
echo ============================================= >> "%LOG%"
echo === start %date% %time% === >> "%LOG%"
echo ============================================= >> "%LOG%"

cd /d "%~dp0"
title MeshLLM Launcher
echo.
echo  ====== MeshLLM one-click launcher ======
echo   Project : %cd%
echo.

rem ---------- 1. Locate npm (try PATH, then standard install dirs) ----------
set "NPM_CMD=npm"
where npm >nul 2>nul
if errorlevel 0 (
    set "NPM_OK=1"
) else (
    if exist "C:\Program Files\nodejs\npm.cmd" (
        set "NPM_CMD=C:\Program Files\nodejs\npm.cmd"
        set "NPM_OK=1"
    ) else if exist "C:\Program Files (x86)\nodejs\npm.cmd" (
        set "NPM_CMD=C:\Program Files (x86)\nodejs\npm.cmd"
        set "NPM_OK=1"
    )
)
echo [step1] locating npm... >> "%LOG%"

if not defined NPM_OK (
    echo.
    echo  [ERROR] 找不到 Node.js / npm。窗口会停在这里, 请按任意键关闭。
    echo.
    echo          解决方法: 安装 Node.js (LTS, 20+, 64-bit)   https://nodejs.org/download
    echo                  安装时默认勾选 "Add to PATH" 即可。
    echo.
    echo          装好后: 关闭本窗口 -> 重新双击本文件。
    echo                  (可在 cmd 里输入  'npm -v'  确认已生效)
    echo.
    echo          详细原因: 见  start.bat.log
    echo.
    pause
    exit /b 1
)
echo [info] npm found: %NPM_CMD%
echo [step1] npm=!NPM_CMD! OK >> "%LOG%"

rem ---------- 2. install dependencies (first run only) ----------
if not exist node_modules (
    echo [setup] First run - installing dependencies (one-time, may take a while)...
    echo.
    echo   (stderr goes to start.bat.log)
    call "%NPM_CMD%" install 2>> "%LOG%"
    if errorlevel 1 (
        echo [error] npm install failed. Check network / npm cache.
        echo  [error] details in start.bat.log
        echo.
        pause
        exit /b 1
    )
    echo [setup] Dependencies installed.
) else (
    echo [info] node_modules found - skipping install.
)
echo.

rem ---------- 3. port pre-flight (free 4011 & 5173) ----------
echo  ---- checking ports ----
echo [step3] checking ports... >> "%LOG%"
call :freePort %PORT_API%  "Server / API"
echo [step3] freePort API !FAIL_PORT! >> "%LOG%"
if !FAIL_PORT! EQU 1 goto :badport
call :freePort %PORT_WEB%  "Web dev server (Vite)"
echo [step3] freePort WEB !FAIL_PORT! >> "%LOG%"
if !FAIL_PORT! EQU 1 goto :badport

echo  ---- all ports ready ----
echo.

rem ---------- 4. start ----------
echo [run] Starting MeshLLM...
echo.
echo       Server / API  : http://127.0.0.1:4011
echo       Web UI        : http://127.0.0.1:5173
echo.
echo       Press  Ctrl+C  to stop.
echo.
echo [run] %date% %time% starting: npm run dev >> "%LOG%"
call "%NPM_CMD%" run dev 2>> "%LOG%"
set "rc=!errorlevel!"
echo [end] %date% %time% npm run dev exit=!rc! >> "%LOG%"

rem ---------- 5. cleanup ----------
echo.
echo [stop] Stopping MeshLLM...
call :cleanupOurProcesses
if !rc! EQU 0 (
    echo [info] MeshLLM stopped.
) else (
    echo [info] MeshLLM stopped (Ctrl+C).
)
echo.
echo.
echo  ============================
echo  Done. Press any key to close
echo  If it closes too fast: errors are in  start.bat.log
echo  ============================
pause
echo === done %date% %time% exit=%rc% === >> "%LOG%"
exit /b 0

:badport
echo.
echo [error] Could not free a required port. See the [warn] line above:
echo         stop the other program using that port, or change PORT_API / PORT_WEB.
echo.
pause
exit /b 1

rem ===========================================================================
rem :freePort  arg1=port  arg2=label
rem   Exit 0 = port free (or freed).  Exit 1 = abort (user said no).
rem ===========================================================================
:freePort
set "port=%~1"
set "label=%~2"
set "FAIL_PORT=0"
set "pids="

rem collect PID(s) listening on this port (netstat -ano 5th column = PID)
rem findstr ":!port!  " (two trailing spaces) so 4011 matches but 40115 does not
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /I "LISTENING" ^| findstr /I ":!port!  ") do set "pids=!pids! %%P"

if not defined pids (
    echo [ok] port !port! free.
    exit /b 0
)

echo [warn] port !port! in use.  (label: !label!)
for %%P in (!pids!) do (
    set "name="
    for /f "tokens=2 delims==" %%n in ('wmic process where "ProcessId=%%P" get Name /value /format:list 2^>nul ^| findstr /I "Name="') do if defined %%n set "name=%%n"
    if defined name (
        echo [warn]    PID %%P  --  %%name
    ) else (
        echo [warn]    PID %%P
    )
)
set "ans=Y"
set /p "ans=Kill stale process(es) to free port !port!?  [Y/N]  default Y: "
if /i "!ans!" EQU "n" (
    echo [cancel] Aborting - free the port manually and re-run.
    set "FAIL_PORT=1"
    pause
    exit /b 0
)
for %%P in (!pids!) do taskkill /F /T /PID %%P ^>nul 2^>nul
timeout /t 2 /nobreak >nul
echo [ok] freed port !port!.
exit /b 0

rem ===========================================================================
rem :cleanupOurProcesses  - best-effort: kill node.exe whose command line
rem   contains THIS project directory, plus concurrently.exe.  No-op if none.
rem ===========================================================================
:cleanupOurProcesses
set "MESH_ME=%~dp0"
powershell -NoProfile -Command "$m=$env:MESH_ME; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $c=$_.CommandLine; if ($m -and $c -like '*' + $m + '*') { try { Start-Process -FileName taskkill.exe -ArgumentList ('/PID ' + $_.ProcessId + ' /T /F') -WindowStyle Hidden -NoNewWindow } catch {} } }; try { Start-Process -FileName taskkill.exe -ArgumentList '/F /IM concurrently.exe' -WindowStyle Hidden -NoNewWindow -ErrorAction SilentlyContinue } catch {}" 2^>nul
exit /b 0

endlocal