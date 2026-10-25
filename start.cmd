@echo off
title Odkrywca krakowskich parkow
cd /d "%~dp0"
set "URL=http://localhost:7777"

netstat -an | findstr ":7777" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo Aplikacja juz dziala lokalnie.
  start "" "%URL%"
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Nie znaleziono Node.js. Zainstaluj Node 18+ z https://nodejs.org
  pause
  exit /b 1
)

node server.js
if errorlevel 1 pause
