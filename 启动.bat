@echo off
setlocal
cd /d "%~dp0"
title Yuketang Brush
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1"
if errorlevel 1 (
  echo.
  echo Something went wrong. Press any key to close.
  pause >nul
)
endlocal
