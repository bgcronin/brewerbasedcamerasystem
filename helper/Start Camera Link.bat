@echo off
setlocal
title Lumen Camera Link
rem Double-click on Windows to start Lumen with the Canon connected.

rem pushd rather than cd, so that this also works from a network folder (\\server\share\...).
pushd "%~dp0" 2>nul
if errorlevel 1 goto :nofolder

rem Started from inside the ZIP? Windows then unpacks only this one file, and nothing else is here.
if not exist "src\main.js" goto :incomplete

where node >nul 2>nul
if errorlevel 1 goto :nonode
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 goto :oldnode

rem Camera Link's own parts. They are checked by loading them, so an install that
rem stopped half way is noticed and done again instead of being skipped for ever.
node -e "require('ws'); require('koffi')" >nul 2>nul
if not errorlevel 1 goto :ready
echo Setting up Lumen Camera Link. This happens once, takes about a minute and needs the internet...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto :installfailed
node -e "require('ws'); require('koffi')" >nul 2>nul
if errorlevel 1 goto :installfailed

:ready
rem Build Lumen if it has changed since the last start. The build is made in a spare
rem folder and only replaces the working one when it succeeded; if it fails, the
rem reason is shown and the previous build is used.
node src\build-lumen.js
node src\main.js --open %*
goto :done

:nofolder
echo Could not open the folder this file is in:
echo   %~dp0
goto :done

:incomplete
echo Lumen Camera Link cannot start from here: the rest of its files are missing.
echo.
echo If you double-clicked this file inside the downloaded ZIP, unpack the ZIP first:
echo right-click the ZIP, choose "Extract All", then open the extracted folder and
echo double-click "Start Camera Link.bat" in its "helper" folder.
echo.
echo A plain folder such as C:\Lumen works best. Avoid Desktop and Documents if they
echo are kept in OneDrive.
goto :done

:nonode
echo Node.js is not installed on this computer.
echo Get the LTS version from https://nodejs.org and install it, then double-click this again.
goto :done

:oldnode
echo The Node.js on this computer is too old for Lumen Camera Link, which needs version 20 or newer.
echo This computer has version:
node --version
echo Get the LTS version from https://nodejs.org and install it, then double-click this again.
goto :done

:installfailed
echo.
echo Lumen Camera Link could not be set up: installing its parts failed. The reason is in the lines above.
echo Check that this computer is connected to the internet, then double-click this again.
goto :done

:done
popd 2>nul
echo.
pause
