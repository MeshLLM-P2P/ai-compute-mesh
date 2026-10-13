@echo off
rem MeshLLM provider agent - auto-restart loop
rem crash auto-restart; logs: loop.log per cycle, agent.log all node output
:loop
echo [%date% %time%] starting node >> "%~dp0loop.log"
node "%~dp0src\index.js" >> "%~dp0agent.log" 2>&1
echo [%date% %time%] node exited code=%errorlevel%, restarting in 3s >> "%~dp0loop.log"
rem ping delays 3s (timeout.exe is unreliable headless)
ping -n 4 127.0.0.1 >nul
goto loop