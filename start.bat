@echo off
rem MeshLLM one-click launcher (Windows)
cd /d %~dp0
where npm >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js / npm not found. Install Node.js 20+ first: https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo [setup] First run - installing dependencies (npm install)...
  call npm install || (echo [error] npm install failed & pause & exit /b 1)
)
echo [run] Starting server on http://127.0.0.1:4011 and web on http://127.0.0.1:5173
call npm run dev
