@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

if not defined DEEPSEEK_API_KEY if not defined ORCH_API_KEY (
  echo.
  echo  [!] No API key found.
  echo      Set it before running, for example:
  echo        set DEEPSEEK_API_KEY=sk-xxxxxxxx
  echo.
)

echo.
echo  Starting AI Orchestrator ...
echo  Open http://127.0.0.1:5180 in your browser.
echo.

"%NODE_EXE%" server.js

endlocal
