@echo off
title Odkrywca krakowskich parkow
cd /d "%~dp0"
set "URL=http://localhost:7777"

netstat -an | findstr ":7777" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo Serwer juz dziala w tle.
  start "" "%URL%"
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Nie znaleziono Node.js. Zainstaluj Node 18+ z https://nodejs.org
  pause
  exit /b 1
)

where tailscale >nul 2>nul
if not errorlevel 1 (
  tailscale serve --bg 7777 >nul 2>&1
)

node server.js
if errorlevel 1 pause
