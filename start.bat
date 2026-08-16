@echo off
REM 로컬 웹서버로 앱 실행 (http://localhost:8000)
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8000
  python -m http.server 8000
  goto :eof
)
where npx >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8000
  npx --yes http-server -p 8000 -c-1
  goto :eof
)
echo Python 또는 Node.js가 필요합니다.
pause
