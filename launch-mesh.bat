@echo off
setlocal EnableExtensions
set "PROJECT=D:\deepseek-worker\ai-compute-mesh"
set "LOG=C:\Users\.workbuddy-ai\memory\meshllm-launch.log"
if not exist "%LOG%" (mkdir "C:\Users\.workbuddy-ai\memory\" 2>nul)
echo. >> "%LOG%"
echo [start] %date% %time%  npm run dev @ %PROJECT% >> "%LOG%"
cd /d "%PROJECT%" >> "%LOG%" 2>&1
call "C:\Program Files\nodejs\npm.cmd" run dev >> "%LOG%" 2>&1
echo [end] %date% %time%  npm run dev exit code=%ERRORLEVEL% >> "%LOG%"
endlocal
