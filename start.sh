#!/bin/sh
# MeshLLM one-click launcher (Linux / macOS)
cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "[error] Node.js / npm not found. Install Node.js 20+ first: https://nodejs.org"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[setup] First run - installing dependencies (npm install)..."
  npm install || exit 1
fi

echo "[run] Starting server on http://127.0.0.1:4011 and web on http://127.0.0.1:5173"
npm run dev
