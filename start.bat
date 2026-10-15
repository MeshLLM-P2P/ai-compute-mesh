@echo off
setlocal EnableExtensions EnableDelayedExpansion
:: 统一 UTF-8, 让中文提示不乱码
chcp 65001 >nul 2>nul

set "PORT_API=4011"
set "PORT_WEB=5173"
set "LOG=%~dp0start.bat.log"
set "ERROR_MSG="

:: 初始化日志
echo ============================================= 1> "%LOG%"
echo === start  %date% %time%  === 1> "%LOG%"
echo ============================================= 1> "%LOG%"
echo. >> "%LOG%"
echo  ====== MeshLLM one-click launcher ====== >> "%LOG%"
echo   Project : %cd%  >> "%LOG%"
echo. >> "%LOG%"
echo [step1] locating npm... 1>> "%LOG%"
echo.
echo  ====== MeshLLM one-click launcher ======
echo   Project : %cd%
echo.

:: ---------- 1. 找 npm ----------
set "NPM_CMD=npm"
set "NODE_DIR="
set "FOUND=0"

:: 1a) 优先在 PATH 中找
where npm >nul 2>nul
if errorlevel 0 (
    set "FOUND=1"
    echo [step1] npm found in PATH 2>> "%LOG%"
)

:: 1b) 若 PATH 没找到, 逐个常见安装目录找
if not defined FOUND (
    set "NODE_DIRS="
    :: 64 位主目录
    for %%D in (
        "C:\Program Files\nodejs"
        "C:\Program Files (x86)\nodejs"
        "%USERPROFILE%\AppData\Roaming\nvm\dev"
        "%USERPROFILE%\AppData\Roaming\nvm"
        "%USERPROFILE%\AppData\Local\Microsoft\WindowsApps"
    ) do (
        if exist "%%D\npm.cmd" (
            if not defined NODE_DIR set "NODE_DIR=%%D"
        )
    )
    :: nvm-windows 各版本目录
    for /d %%D in ("%USERPROFILE%\AppData\Roaming\nvm\v*" ) do (
        if exist "%%D\npm.cmd" (
            if not defined NODE_DIR set "NODE_DIR=%%D"
        )
    )
    :: 64 位 nodejs (x86) 再试一次 (上面已含)
    if not defined NODE_DIR (
        for %%D in (
            "C:\Program Files (x86)\Program Files\nodejs"
        ) do if exist "%%D\npm.cmd" set "NODE_DIR=%%D"
    )
    if defined NODE_DIR (
        set "NPM_CMD=%NODE_DIR%\npm.cmd"
        set "FOUND=1"
        echo [step1] npm found at:  %NPM_CMD%  2>> "%LOG%"
    ) else (
        echo [step1] npm NOT found in PATH nor in common dirs  2>> "%LOG%"
    )
)

echo [step1] searching node at:  2>> "%LOG%"
echo [step1]   PATH search result = 1a  2>> "%LOG%"
echo [step1]   scanned dirs:  2>> "%LOG%"
echo [step1]     - C:\Program Files\nodejs  2>> "%LOG%"
echo [step1]     - C:\Program Files (x86)\nodejs  2>> "%LOG%"
echo [step1]     - %USERPROFILE%\AppData\Roaming\nvm (dev & versions)  2>> "%LOG%"
echo [step1]     - %USERPROFILE%\AppData\Local\Microsoft\WindowsApps (MS Store)  2>> "%LOG%"
echo [step1]   NODE_DIR =  !NODE_DIR!  2>> "%LOG%"

if not defined FOUND (
    echo. 2> "%LOG%"
    echo [step1] npm NOT found  2> "%LOG%"
    :: 写一个清晰、英文为主的错误框(即使中文乱码也一眼能懂)
    echo. >> "%LOG%"
    echo. 2> "%LOG%"
    echo +--------------------------------------------------------------+ 2>> "%LOG%"
    echo |  ERROR - Node.js / npm not found                            |  2>> "%LOG%"
    echo +--------------------------------------------------------------+  2>> "%LOG%"
    echo |                                                              |  2>> "%LOG%"
    echo |  此电脑未安装 Node.js, 或 npm 不在 PATH 中。               |  2>> "%LOG%"
    echo |  (This computer has no usable Node.js / npm.)               |  2>> "%LOG%"
    echo |                                                              |  2>> "%LOG%"
    echo |  解决方法 / Fix:                                            |  2>> "%LOG%"
    echo |  1. 安装 Node.js LTS (20+, 64-bit):                         |  2>> "%LOG%"
    echo |     https://nodejs.org/download                             |  2>> "%LOG%"
    echo |  2. 安装时务必勾选 "Add to PATH" (推荐).                    |  2>> "%LOG%"
    echo |     装完重启本窗口 -> 重新双击本文件。                       |  2>> "%LOG%"
    echo |     (可 在 cmd 输入  'npm -v'  验证)                        |  2>> "%LOG%"
    echo |                                                              |  2>> "%LOG%"
    echo +--------------------------------------------------------------+  2>> "%LOG%"
    echo. >> "%LOG%"

    echo.
    echo +--------------------------------------------------------------+
    echo |  ERROR - Node.js / npm not found                            |
    echo +--------------------------------------------------------------+
    echo |  此电脑未安装 Node.js, 或 npm 不在 PATH 中。                |
    echo |  (This computer has no usable Node.js / npm.)               |
    echo |                                                              |
    echo |  解决方法 / Fix:                                            |
    echo |  1. 安装 Node.js LTS (20+, 64-bit):                         |
    echo |     https://nodejs.org/download                             |
    echo |  2. 安装时务必勾选 "Add to PATH" (推荐).                    |
    echo |     装完重启本窗口 -> 重新双击本文件。                       |
    echo |     (可在 cmd 输入  'npm -v'  验证)                         |
    echo |                                                              |
    echo +--------------------------------------------------------------+
    echo.
    echo. >> "%LOG%"
    pause >nul
    endlocal
    exit /b 2
)

:: 记录检测到的 node 版本(用于诊断)
set "NODE_VER="
if defined NODE_DIR (
    for /f %%a in ('"%NODE_DIR%\node.exe" -v 2^>nul') do set "NODE_VER=%%a"
) else (
    for /f %%a in ('node -v 2^>nul') do set "NODE_VER=%%a"
)
echo [step1] node version =  !NODE_VER!  2>> "%LOG%"
if not defined NODE_VER (
    echo.
    echo +--------------------------------------------------------------+
    echo |  ERROR - node.exe 无法执行 (-v 失败).                        |
    echo |  Node.js 可能损坏. 重装: https://nodejs.org/download         |
    echo +--------------------------------------------------------------+
    echo. >> "%LOG%"
    pause >nul
    endlocal
    exit /b 2
)
:: 简易检查版本号 >= 18
for /f "tokens=1 delims=." %%a in ("!NODE_VER!") do (
    if "%%a" LSS "18" (
        echo.
        echo +--------------------------------------------------------------+
        echo |  ERROR - Node.js 版本过低: !NODE_VER!  (需要 18+)           |
        echo |  请安装 Node.js 18 以上 LTS: https://nodejs.org/download    |
        echo +--------------------------------------------------------------+
        echo.
        echo. >> "%LOG%"
        pause >nul
        endlocal
        exit /b 2
    )
)
echo [step1] npm OK:  !NODE_CMD!  (node !NODE_VER!)  2>> "%LOG%"

:: ---------- 2. 安装依赖(仅首次) ----------
if not exist node_modules (
    echo.
    echo [setup] 首次运行 - 安装依赖(一次性, 可能需 1~3 分钟)...
    echo   (出错信息会写进 start.bat.log)
    echo.
    call "%NPM_CMD%" install 1>> "%LOG%" 2>> "%LOG%"
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install 失败. 请检查 网络 / 代理 / 镜像.
        echo 详细原因见 start.bat.log 末尾.
        echo. >> "%LOG%"
        pause >nul
        endlocal
        exit /b 3
    )
    echo [setup] Dependencies installed. 2>> "%LOG%"
) else (
    echo [info] node_modules found - skipping install. 2>> "%LOG%"
)
echo.

:: ---------- 3. 端口预检 ----------
echo  ---- checking ports ---- 2>> "%LOG%"
echo [step3] checking ports... 2>> "%LOG%"
set "FAIL=0"
call :freePort %PORT_API%  "Server / API"
if !FAIL! EQU 1 goto :badport
call :freePort %PORT_WEB%  "Web dev server (Vite)"
if !FAIL! EQU 1 goto :badport
echo.
echo  ---- all ports ready ----
echo.

:: ---------- 4. 启动 ----------
echo [run] Starting MeshLLM... 2>> "%LOG%"
echo.
echo       Server / API  : http://127.0.0.1:4011
echo       Web UI        : http://127.0.0.1:5173
echo.
echo       按  Ctrl+C  停止。
echo.
echo [run]  starting: npm run dev  2>> "%LOG%"
call "%NPM_CMD%" run dev 1>> "%LOG%" 2>> "%LOG%"
set "RC=!errorlevel!"
echo [end]  npm run dev exit=!RC!  2>> "%LOG%"
echo.
echo [stop] Stopping MeshLLM... 2>> "%LOG%"
call :cleanupOurProcesses

:badport
set "RC=4"
goto :finish

:finish
echo.
echo  ============================
echo  运行结束 (exit = !RC!)
echo  若出错, 看  start.bat.log
echo  ============================
echo. >> "%LOG%"
echo === done %date% %time% exit=!RC! === 2>> "%LOG%"

pause >nul
endlocal
exit /b %RC%

rem ===========================================================================
rem :freePort  arg1=port arg2=label
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

echo [warn] port !port! in use.  (label: !label!) 2>> "%LOG%"
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
    echo [cancel] Aborting - free the port manually and re-run. 2>> "%LOG%"
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
endlocal