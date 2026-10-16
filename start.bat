@echo off
rem ===================================================================
rem  MeshLLM one-click launcher
rem
rem  ASCII-only on purpose : no codepage switching and no UTF-8 BOM,
rem  so this file behaves the same on every Windows machine.
rem
rem  Log file : start.bat.log   (created next to this file)
rem  Every step is written to BOTH the screen and the log, so if the
rem  window ever closes too fast, open start.bat.log to see how far it ran.
rem ===================================================================
setlocal EnableExtensions EnableDelayedExpansion

set "PORT_API=4011"
set "PORT_WEB=5173"
set "LOG=%~dp0start.bat.log"
set "MESH_DIR=%~dp0"

cd /d "%~dp0"
title MeshLLM Launcher

rem ---- start a fresh log ----
>  "%LOG%" echo ==========================================================
>> "%LOG%" echo === MeshLLM launcher start   %date% %time%
>> "%LOG%" echo === folder : %CD%
>> "%LOG%" echo === user   : %USERNAME%
>> "%LOG%" echo ==========================================================

rem ---- run the real work, then ALWAYS pause so the window never vanishes ----
call :main
set "RC=%errorlevel%"

echo.
echo  ==========================================================
echo   MeshLLM launcher finished.   exit code = %RC%
echo   log file : %LOG%
echo   press any key to close this window
echo  ==========================================================
echo.
>> "%LOG%" echo === done %date% %time% exit=%RC% ===
pause >nul
endlocal
exit /b %RC%


rem ===================================================================
:main
rem ===================================================================
echo.
echo   ====== MeshLLM one-click launcher ======
echo   folder : %CD%
echo.

rem ---------- 1. find npm ----------
call :say [step1] looking for npm ...
set "NPM_CMD=npm"
set "NODE_DIR="
set "FOUND="

where npm >nul 2>nul
if not errorlevel 1 (
    set "FOUND=1"
)

if not defined FOUND (
    if exist "C:\Program Files\nodejs\npm.cmd" set "NODE_DIR=C:\Program Files\nodejs"
    if not defined NODE_DIR if exist "C:\Program Files (x86)\nodejs\npm.cmd" set "NODE_DIR=C:\Program Files (x86)\nodejs"
    if not defined NODE_DIR if exist "%USERPROFILE%\AppData\Roaming\nvm\npm.cmd" set "NODE_DIR=%USERPROFILE%\AppData\Roaming\nvm"
    if not defined NODE_DIR if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd" set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs"
    if not defined NODE_DIR if exist "%USERPROFILE%\AppData\Local\Microsoft\WindowsApps\npm.cmd" set "NODE_DIR=%USERPROFILE%\AppData\Local\Microsoft\WindowsApps"
)
for /d %%D in ("%USERPROFILE%\AppData\Roaming\nvm\v*") do (
    if not defined NODE_DIR if exist "%%D\npm.cmd" set "NODE_DIR=%%D"
)
if defined NODE_DIR (
    set "NPM_CMD=!NODE_DIR!\npm.cmd"
    set "FOUND=1"
)

if not defined FOUND (
    call :say [step1] npm was NOT found anywhere
    echo.
    echo   +--------------------------------------------------------------+
    echo   +  ERROR : Node.js / npm was not found on this computer        +
    echo   +                                                              +
    echo   +  Do this, in order :                                         +
    echo   +   1. Download Node.js LTS 64-bit :  https://nodejs.org        +
    echo   +   2. Run the installer and tick the box  Add to PATH         +
    echo   +   3. Close this window                                       +
    echo   +   4. Double-click  start.bat  again                          +
    echo   +                                                              +
    echo   +  To check it worked : open a cmd window and type   npm -v    +
    echo   +--------------------------------------------------------------+
    echo.
    exit /b 2
)
call :say [step1] npm found : !NPM_CMD!

rem ---------- 2. node version ----------
call :say [step2] checking node version ...
set "NODE_VER="
if defined NODE_DIR (
    for /f "tokens=* delims=" %%a in ('"!NODE_DIR!\node.exe" -v 2^>nul') do set "NODE_VER=%%a"
) else (
    for /f "tokens=* delims=" %%a in ('node -v 2^>nul') do set "NODE_VER=%%a"
)
if not defined NODE_VER (
    call :say [step2] node.exe did not answer
    echo.
    echo   +--------------------------------------------------------------+
    echo   +  ERROR : node.exe could not be started                      +
    echo   +                                                              +
    echo   +  Node.js is installed but broken, or the PATH is wrong.      +
    echo   +  Reinstall Node.js LTS from   https://nodejs.org            +
    echo   +--------------------------------------------------------------+
    echo.
    exit /b 2
)
call :say [step2] node version : !NODE_VER!
set "NODE_MAJOR=!NODE_VER!"
set "NODE_MAJOR=!NODE_MAJOR:v=!"
set "NODE_MAJOR=!NODE_MAJOR:V=!"
for /f "tokens=1 delims=." %%a in ("!NODE_MAJOR!") do set "NODE_MAJOR=%%a"
set "NODE_OK="
if defined NODE_MAJOR (
    if !NODE_MAJOR! GEQ 18 set "NODE_OK=1"
)
if not defined NODE_OK (
    call :say [step2] node too old or unreadable : !NODE_VER!
    echo.
    echo   +--------------------------------------------------------------+
    echo   +  ERROR : Node.js is too old : !NODE_VER!                    +
    echo   +                                                              +
    echo   +  MeshLLM needs Node.js 18 or newer.                         +
    echo   +  Install the LTS version from   https://nodejs.org          +
    echo   +--------------------------------------------------------------+
    echo.
    exit /b 2
)

rem ---------- 3. install dependencies ----------
if not exist node_modules (
    echo.
    echo   [setup] First run : installing dependencies. One time only.
    echo   [setup] This usually takes 1 to 3 minutes. Please wait.
    echo   [setup] Full npm output is written to start.bat.log
    echo.
    call :say [setup] npm install BEGIN
    call "%NPM_CMD%" install >> "%LOG%" 2>&1
    set "IRC=!errorlevel!"
    if not "!IRC!"=="0" (
        call :say [setup] npm install FAILED with code !IRC!
        echo.
        echo   [ERROR] npm install failed with code !IRC!
        echo   [ERROR] The npm error text is at the end of start.bat.log
        echo   [ERROR] Common causes : offline, proxy, or blocked registry.
        echo.
        echo   [ERROR] Opening start.bat.log in Notepad now.
        echo.
        start "" notepad "%LOG%"
        exit /b 3
    )
    call :say [setup] npm install OK
) else (
    call :say [setup] node_modules already present, install skipped
)

rem ---------- 4. ports ----------
call :say [step4] checking ports ...
set "FAIL=0"
call :freePort %PORT_API%
if "!FAIL!"=="1" exit /b 4
call :freePort %PORT_WEB%
if "!FAIL!"=="1" exit /b 4
call :say [step4] ports ready

rem ---------- 5. run ----------
echo.
echo   Server / API : http://127.0.0.1:4011
echo   Web  UI      : http://127.0.0.1:5173
echo.
echo   Starting now ... press Ctrl+C to stop.
echo.
call :say [run] npm run dev BEGIN
call "%NPM_CMD%" run dev >> "%LOG%" 2>&1
set "RC=!errorlevel!"
call :say [run] npm run dev END, exit code = !RC!
call :cleanup
exit /b !RC!


rem ===================================================================
:say
rem   print a line on screen AND append it to the log
rem ===================================================================
echo %*
>> "%LOG%" echo %*
exit /b 0


rem ===================================================================
:freePort
rem   arg1 = port number
rem ===================================================================
set "port=%~1"
set "pids="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /I "LISTENING" ^| findstr /I /C:":!port! "') do set "pids=!pids! %%P"
if not defined pids (
    call :say [ok] port !port! is free
    exit /b 0
)
echo.
echo   [warn] port !port! is already used by another program.
echo          PID list :!pids!
echo.
set "ans=Y"
set /p "ans=Kill it and continue ?  Y or N, default Y : "
if /i "!ans!"=="n" (
    call :say [cancel] user chose not to free port !port!
    echo.
    echo   [cancel] Aborted. Free the port yourself, then run start.bat again.
    echo.
    set "FAIL=1"
    exit /b 0
)
for %%P in (!pids!) do taskkill /F /T /PID %%P >nul 2>nul
ping -n 3 127.0.0.1 >nul 2>nul
call :say [ok] freed port !port!
exit /b 0


rem ===================================================================
:cleanup
rem   stop leftover node / vite processes started by this launcher
rem ===================================================================
powershell -NoProfile -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like ('*' + $env:MESH_DIR + '*') } | ForEach-Object { Start-Process -FilePath taskkill.exe -ArgumentList ('/F /T /PID ' + $_.ProcessId) -WindowStyle Hidden -NoNewWindow -ErrorAction SilentlyContinue }" >nul 2>nul
exit /b 0
