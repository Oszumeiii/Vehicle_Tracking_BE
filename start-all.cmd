@echo off
rem Double-click to start PostgreSQL, API, worker and FE. Options: -SkipBuild -NoBrowser
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-all.ps1" %*
if errorlevel 1 pause
