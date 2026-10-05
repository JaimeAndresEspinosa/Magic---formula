@echo off
REM Arranca el Magic Formula Screener en http://localhost:8000
cd /d "%~dp0"
set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" -m pip install -q -r requirements.txt
start "" http://localhost:8000
"%PY%" -m uvicorn app:app --host 127.0.0.1 --port 8000
