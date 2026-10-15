@echo off
setlocal EnableExtensions EnableDelayedExpansion
:: keep Chinese readable
chcp 65001 >nul 2>nul

set "PORT_API=4011"
set "PORT_WEB=5173"
set "LOG=%~dp0start.bat.log"

cd /d "%~dp0"
title MeshLLM Launcher

echo ============================================= 1> "%LOG%"
echo === start %date% %time% === 1> "%LOG%"
echo ============================================= 1> "%LOG%"
echo. >> "%LOG%"
echo.
echo  ====== MeshLLM one-click launcher ======
echo   Project : %cd%
echo.

rem ---------- 1. locate npm ----------
echo [step1] locating npm...  2>> "%LOG%"
set "NPM_CMD=npm"
set "NODE_DIR="
set "FOUND=0"

where npm >nul 2>nul
if errorlevel 0 (
    set "FOUND=1"
) else (
    set "NODE_DIR="
    if exist "C:\Program Files\nodejs\npm.cmd" set "NODE_DIR=C:\Program Files\nodejs"
    if not defined NODE_DIR if exist "C:\Program Files (x86)\nodejs\npm.cmd" set "NODE_DIR=C:\Program Files (x86)\nodejs"
    if not defined NODE_DIR if exist "%USERPROFILE%\AppData\Roaming\nvm\dev\npm.cmd" set "NODE_DIR=%USERPROFILE%\AppData\Roaming\nvm\dev"
    if not defined NODE_DIR if exist "%USERPROFILE%\AppData\Roaming\nvm\npm.cmd" set "NODE_DIR=%USERPROFILE%\AppData\Roaming\nvm"
    if not defined NODE_DIR if exist "%USERPROFILE%\AppData\Local\Microsoft\WindowsApps\npm.cmd" set "NODE_DIR=%USERPROFILE%\AppData\Local\Microsoft\WindowsApps"
    if not defined NODE_DIR if exist "C:\Program Files (x86)\Program Files\nodejs\npm.cmd" set "NODE_DIR=C:\Program Files (x86)\Program Files\nodejs"
    for /d %%D in ("%USERPROFILE%\AppData\Roaming\nvm\v*") do (
        if not defined NODE_DIR if exist "%%D\npm.cmd" set "NODE_DIR=%%D"
    )
    if defined NODE_DIR (
        set "NPM_CMD=%NODE_DIR%\npm.cmd"
        set "FOUND=1"
    )
)
echo [step1] scanned common node dirs and nvm versions  2>> "%LOG%"
echo [step1] NODE_DIR = !NODE_DIR!  2>> "%LOG%"
echo [step1] NPM_CMD = !NPM_CMD!  2>> "%LOG%"

if defined FOUND (
    echo [step1] npm OK: !NPM_CMD!
    echo [step1] ok to continue  2>> "%LOG%"
) else (
    echo.
    echo [step1] npm NOT found  2>> "%LOG%"
    echo. >> "%LOG%"
    echo +----------------------------------------------------------+
    echo + ERROR : Node.js or npm not found                        +
    echo + This computer has no usable Node.js or npm.               +
    echo +                                                          +
    echo + Fix :                                                    +
    echo + 1. Install Node.js LTS 64-bit: https://nodejs.org/download+
    echo + 2. Tick Add to PATH during install. Recommended.         +
    echo + 3. Close this window then double-click this file again.   +
    echo + 4. Verify by typing npm -v in a new command window.       +
    echo +----------------------------------------------------------+
    echo. >> "%LOG%"
    echo +----------------------------------------------------------+ 2>> "%LOG%"
    echo + ERROR : Node.js or npm not found                        + 2>> "%LOG%"
    echo + This computer has no usable Node.js or npm.               + 2>> "%LOG%"
    echo + Fix :                                                    + 2>> "%LOG%"
    echo + 1. Install Node.js LTS 64-bit: https://nodejs.org/download+ 2>> "%LOG%"
    echo + 2. Tick Add to PATH during install. Recommended.         + 2>> "%LOG%"
    echo + 3. Close this window then double-click this file again.   + 2>> "%LOG%"
    echo + 4. Verify by typing npm -v in a new command window.       + 2>> "%LOG%"
    echo +----------------------------------------------------------+ 2>> "%LOG%"
    echo. >> "%LOG%"
    pause >nul
    endlocal
    exit /b 2
)

rem record node version for diagnostics
set "NODE_VER="
if defined NODE_DIR (
    for /f %%a in ('"%NODE_DIR%\node.exe" -v 2^>nul') do set "NODE_VER=%%a"
) else (
    for /f %%a in ('node -v 2^>nul') do set "NODE_VER=%%a"
)
echo [step1] node version = !NODE_VER!  2>> "%LOG%"
if not defined NODE_VER (
    echo.
    echo +----------------------------------------------------------+
    echo + ERROR : node.exe could not run. Node.js may be broken.   +
    echo + Reinstall Node.js: https://nodejs.org/download           +
    echo +----------------------------------------------------------+
    echo.
    echo. >> "%LOG%"
    pause >nul
    endlocal
    exit /b 2
)
rem simple check for version 18 or higher
for /f "tokens=1 delims=." %%a in ("!NODE_VER!") do (
    if "%%a" LSS "18" (
        echo.
        echo +----------------------------------------------------------+
        echo + ERROR : Node.js too old: !NODE_VER! . Need 18 or higher. +
        echo + Install newer Node.js: https://nodejs.org/download     +
        echo +----------------------------------------------------------+
        echo.
        echo. >> "%LOG%"
        pause >nul
        endlocal
        exit /b 2
    )
)
echo [step1] npm OK: !NPM_CMD!  node !NODE_VER!  2>> "%LOG%"

rem ---------- 2. install deps, first run only ----------
if not exist node_modules (
    echo.
    echo [setup] first run. Installing dependencies now. One time only.
    echo [setup] may take 1 to 3 minutes. Details in start.bat.log
    echo.
    call "%NPM_CMD%" install 1>> "%LOG%" 2>> "%LOG%"
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed. Check network or proxy or mirror.
        echo.
        echo [ERROR] details are at the end of start.bat.log
        echo.
        echo. >> "%LOG%"
        pause >nul
        endlocal
        exit /b 3
    )
    echo [setup] dependencies installed.  2>> "%LOG%"
) else (
    echo [info] node_modules found. Skipping install.  2>> "%LOG%"
)
echo.

rem ---------- 3. port pre-flight ----------
echo  ---- checking ports ----  2>> "%LOG%"
echo [step3] checking ports...  2>> "%LOG%"
set "FAIL=0"
call :freePort %PORT_API%  "Server / API"
if !FAIL! EQU 1 goto :badport
call :freePort %PORT_WEB%  "Web dev server"
if !FAIL! EQU 1 goto :badport
echo.
echo  ---- all ports ready ----
echo.

rem ---------- 4. run ----------
echo [run] Starting MeshLLM now...  2>> "%LOG%"
echo.
echo       Server / API  : http://127.0.0.1:4011
echo       Web UI        : http://127.0.0.1:5173
echo.
echo       Press Ctrl+C to stop.
echo.
echo [run] command: npm run dev  2>> "%LOG%"
call "%NPM_CMD%" run dev 1>> "%LOG%" 2>> "%LOG%"
set "RC=!errorlevel!"
echo [end]  npm run dev exit code = !RC!  2>> "%LOG%"
echo.
echo [stop] Stopping MeshLLM...
call :cleanupOurProcesses
goto :finish

:badport
set "RC=4"
goto :finish

:finish
echo.
echo  ============================
echo  done. exit code = !RC!
echo  if there was an error see start.bat.log
echo. >> "%LOG%"
echo === done %date% %time% exit=!RC! === 2>> "%LOG%"
pause >nul
endlocal
exit /b %RC%

rem ===========================================================================
rem :freePort  arg1=port  arg2=label
rem ===========================================================================
:freePort
set "port=%~1"
set "label=%~2"
set "pids="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /I "LISTENING" ^| findstr /I ":!port!  "') do set "pids=!pids! %%P"

if not defined pids (
    echo [ok] port !port! free.
    exit /b 0
)

echo [warn] port !port! in use. label is !label!  2>> "%LOG%"
for %%P in (!pids!) do (
    set "name="
    for /f "tokens=2 delims==" %%n in ('wmic process where "ProcessId=%%P" get Name /value /format:list 2^>nul ^| findstr /I "Name="') do if defined %%n set "name=%%n"
    if defined name (
        echo [warn]   PID %%P  --  %%name
    ) else (
        echo [warn]   PID %%P
    )
)
set "ans=Y"
set /p "ans=Kill stale process to free port !port! ?  Y or N default Y: "
if /i "!ans!" EQU "n" (
    echo [cancel] Aborting. Free the port manually then re-run.  2>> "%LOG%"
    set "FAIL=1"
    pause >nul
    exit /b 0
)
for %%P in (!pids!) do taskkill /F /T /PID %%P ^>nul 2^>nul
timeout /t 2 /nobreak >nul
echo [ok] freed port !port!.
exit /b 0

rem ===========================================================================
rem :cleanupOurProcesses
rem ===========================================================================
:cleanupOurProcesses
set "MESH_ME=%~dp0"
powershell -NoProfile -Command "$m=$env:MESH_ME; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $c=$_.CommandLine; if ($m -and $c -like '*' + $m + '*') { try { Start-Process -FileName taskkill.exe -ArgumentList ('/PID ' + $_.ProcessId + ' /T /F') -WindowStyle Hidden -NoNewWindow } catch {} }; try { Start-Process -FileName taskkill.exe -ArgumentList '/F /IM concurrently.exe' -WindowStyle Hidden -NoNewWindow -ErrorAction SilentlyContinue } catch {}" 2^>nul
exit /b 0