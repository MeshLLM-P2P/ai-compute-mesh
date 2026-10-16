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

rem ---------- 1. locate node.exe ----------
rem  IMPORTANT : do NOT trust  where npm  here. The WHERE command searches
rem  the CURRENT DIRECTORY before PATH, so a stray npm.cmd sitting in the
rem  project folder would win and then look for itself in the wrong place.
rem  We therefore locate node.exe first and take npm from next to it.
call :say [step1] looking for node.exe ...
set "NODE_DIR="
set "NODE_EXE="
set "NPM_CMD="
set "NPM_CLI="

if exist "C:\Program Files\nodejs\node.exe" set "NODE_DIR=C:\Program Files\nodejs"
if not defined NODE_DIR if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_DIR=C:\Program Files (x86)\nodejs"
if not defined NODE_DIR if exist "%USERPROFILE%\AppData\Roaming\nvm\node.exe" set "NODE_DIR=%USERPROFILE%\AppData\Roaming\nvm"
if not defined NODE_DIR if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs"
if not defined NODE_DIR if exist "%USERPROFILE%\AppData\Local\Microsoft\WindowsApps\node.exe" set "NODE_DIR=%USERPROFILE%\AppData\Local\Microsoft\WindowsApps"
for /d %%D in ("%USERPROFILE%\AppData\Roaming\nvm\v*") do (
    if not defined NODE_DIR if exist "%%D\node.exe" set "NODE_DIR=%%D"
)

rem this folder with a trailing backslash, used to reject a node.exe
rem that lives inside the project itself
set "CDSLASH="
for %%Q in ("%CD%\.") do set "CDSLASH=%%~dpQ"

if not defined NODE_DIR (
    for /f "delims=" %%N in ('where node 2^>nul') do (
        if not defined NODE_DIR if not "%%~dpN"=="!CDSLASH!" set "NODE_DIR=%%~dpN"
    )
)

rem ---- diagnostics : show everything the machine can see ----
call :say [step1] folder with backslash : !CDSLASH!
call :say [step1] where npm sees :
for /f "delims=" %%W in ('where npm 2^>nul') do call :say [step1]     npm at %%W
call :say [step1] where node sees :
for /f "delims=" %%W in ('where node 2^>nul') do call :say [step1]     node at %%W
if exist "%CD%\npm.cmd" call :say [step1] WARN a stray npm.cmd sits in the project folder
if exist "%CD%\npm.bat" call :say [step1] WARN a stray npm.bat sits in the project folder
if exist "%CD%\node.exe" call :say [step1] WARN a stray node.exe sits in the project folder

if not defined NODE_DIR (
    call :say [step1] node.exe was NOT found anywhere
    echo.
    echo   +--------------------------------------------------------------+
    echo   +  ERROR : Node.js was not found on this computer              +
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
call :say [step1] NODE_DIR : !NODE_DIR!
set "NODE_EXE=!NODE_DIR!\node.exe"
call :say [step1] NODE_EXE : !NODE_EXE!

rem ---------- 2. node version ----------
call :say [step2] checking node version ...
set "NODE_VER="
for /f "delims=" %%a in ('"!NODE_EXE!" -v 2^>nul') do set "NODE_VER=%%a"
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

rem ---------- 3. choose a working way to call npm ----------
rem  Take npm.cmd from right next to node.exe, never from the project folder.
set "NPM_CMD=!NODE_DIR!\npm.cmd"
if not exist "!NPM_CMD!" set "NPM_CMD=!NODE_DIR!\npm"
call :say [step3] npm.cmd : !NPM_CMD!
set "NPM_VER="
for /f "delims=" %%V in ('call "!NPM_CMD!" -v 2^>nul') do set "NPM_VER=%%V"
if defined NPM_VER (
    call :say [step3] npm -v answers : !NPM_VER!
) else (
    call :say [step3] npm.cmd does not work, falling back to npm-cli.js
    set "NPM_CLI=!NODE_DIR!\node_modules\npm\bin\npm-cli.js"
    if not exist "!NPM_CLI!" (
        call :say [step3] npm-cli.js is missing too
        echo.
        echo   +--------------------------------------------------------------+
        echo   +  ERROR : npm is broken in this Node.js installation         +
        echo   +                                                              +
        echo   +  Reinstall Node.js LTS from   https://nodejs.org            +
        echo   +--------------------------------------------------------------+
        echo.
        exit /b 2
    )
    call :say [step3] using npm-cli.js : !NPM_CLI!
)

rem ---------- 4. registry that matches the lockfile ----------
rem  npm 11.x / 12.x refuse to fetch tarballs when the configured registry
rem  origin differs from the "resolved" origin stored in package-lock.json
rem  (npm error code EALLOWREMOTE). The lockfile here points at a mirror,
rem  so we pass that exact registry to npm and the origins then match.
set "NPM_REGISTRY="
if exist package-lock.json (
    rem  "resolved": "https://HOST/path"  split on / gives token 1 = ...https:
    rem  and token 2 = HOST, because cmd collapses the double slash.
    for /f "tokens=2 delims=/" %%H in ('findstr /I /C:"resolved" package-lock.json ^| findstr /I /C:"https://"') do (
        if not defined NPM_REGISTRY (
            rem  accept only if it really looks like a host name, has a dot
            for /f "tokens=1,2 delims=." %%X in ("%%H") do (
                if not "%%Y"=="" set "NPM_REGISTRY=https://%%H"
            )
        )
    )
)
set "NPM_EXTRA="
if defined NPM_REGISTRY (
    call :say [setup] lockfile registry : !NPM_REGISTRY!
    set "NPM_EXTRA=--registry=!NPM_REGISTRY!"
) else (
    call :say [setup] no registry found in package-lock.json, using default
)

rem ---------- 5. install dependencies ----------
rem  A previously failed install can leave a node_modules folder that exists
rem  but is missing packages, which then breaks 'npm run dev' with
rem  'concurrently' is not recognized. Do not trust the folder alone:
rem  npm writes node_modules\.package-lock.json only when an install
rem  completes, and the dev script needs node_modules\.bin\concurrently.cmd.
set "NEED_INSTALL=0"
if not exist node_modules (
    set "NEED_INSTALL=1"
    call :say [setup] no node_modules yet
) else (
    if not exist "node_modules\.package-lock.json" (
        set "NEED_INSTALL=1"
        call :say [setup] node_modules exists but has no .package-lock.json
    )
    if not exist "node_modules\.bin\concurrently.cmd" (
        set "NEED_INSTALL=1"
        call :say [setup] node_modules exists but concurrently is missing
    )
)

if "!NEED_INSTALL!"=="0" (
    call :say [setup] node_modules looks complete, install skipped
) else (
    echo.
    echo   [setup] Installing dependencies. This can take 1 to 3 minutes.
    echo   [setup] Full npm output is written to start.bat.log
    echo.
    if exist node_modules (
        call :say [setup] removing the broken node_modules first
        call :cleanup
        rmdir /s /q node_modules >nul 2>nul
        if exist node_modules (
            call :say [setup] WARN node_modules could not be fully removed
        ) else (
            call :say [setup] node_modules removed
        )
    )
    call :say [setup] npm install BEGIN
    call :npmRun install
    set "IRC=!errorlevel!"
    if not "!IRC!"=="0" (
        call :say [setup] attempt 1 failed, killing stale node processes and retrying
        call :cleanup
        call :npmRun install
        set "IRC=!errorlevel!"
    )
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
    if not exist "node_modules\.bin\concurrently.cmd" (
        call :say [setup] WARN concurrently is still missing after install
    )
)

rem ---------- 6. ports ----------
call :say [step6] checking ports ...
set "FAIL=0"
call :freePort %PORT_API%
if "!FAIL!"=="1" exit /b 4
call :freePort %PORT_WEB%
if "!FAIL!"=="1" exit /b 4
call :say [step6] ports ready

rem ---------- 7. run ----------
rem  dev does not need the registry override
set "NPM_EXTRA="
echo.
echo   Server / API : http://127.0.0.1:4011
echo   Web  UI      : http://127.0.0.1:5173
echo.
echo   Starting now ... press Ctrl+C to stop.
echo.
call :say [run] npm run dev BEGIN
call :npmRun run dev
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
:npmRun
rem   run npm with all arguments. Uses npm.cmd, or npm-cli.js directly
rem   when npm.cmd is broken. Output goes to the log.
rem ===================================================================
set "NRC=0"
if defined NPM_CLI (
    call "!NODE_EXE!" "!NPM_CLI!" %* !NPM_EXTRA! >> "%LOG%" 2>&1
    set "NRC=!errorlevel!"
) else (
    call "!NPM_CMD!" %* !NPM_EXTRA! >> "%LOG%" 2>&1
    set "NRC=!errorlevel!"
)
exit /b !NRC!


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
