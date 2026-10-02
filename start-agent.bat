@echo off
rem ===========================================================================
rem  Minecraft Survival Agent - Windows launcher
rem
rem  PCL2 (Plain Craft Launcher 2) is a *client* launcher: it can start a game
rem  window but it cannot host a dedicated server. For an unattended agent this
rem  script therefore runs the server headlessly with the same Java runtime PCL
rem  already uses, and starts the mineflayer bot against it. PCL2 is still used
rem  for the client side (see --with-client) so a human can join and watch.
rem
rem  Usage:
rem    start-agent.bat                 server + agent
rem    start-agent.bat --with-client   also open PCL2
rem    start-agent.bat --day           set daytime on spawn (needs bot op)
rem ===========================================================================
setlocal
chcp 65001 >nul
title Minecraft Survival Agent
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Install Node 18+ first: https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\mineflayer" (
  echo [setup] installing npm dependencies ^(first run^)...
  call npm install --no-audit --no-fund || goto :fail
)

if not exist "runtime\server\server-1.20.1.jar" (
  echo [setup] downloading the Minecraft server ^(first run^)...
  call node scripts\setup-server.js || goto :fail
)

echo [start] launching server + agent...
node scripts\run-all.js %*
goto :done

:fail
echo.
echo [ERROR] startup failed - see the messages above.
pause
exit /b 1

:done
echo.
echo [done] agent stopped.
pause
