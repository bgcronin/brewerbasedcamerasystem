@echo off
rem Double-click on Windows to start Lumen with the Canon connected.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org ^(LTS^), then double-click this again. & pause & exit /b 1)
if not exist node_modules call npm install --omit=dev
rem Rebuild Lumen so it always matches the latest code (takes a few seconds).
pushd ..
if not exist node_modules call npm install
call npm run build --silent >nul || echo Could not rebuild Lumen - using the previous build.
popd
node src\main.js --open %*
pause
