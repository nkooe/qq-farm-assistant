@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "FARM_NODE=node.exe"
if exist "%~dp0runtime\node.exe" set "FARM_NODE=%~dp0runtime\node.exe"
"%FARM_NODE%" "%~dp0scripts\farm.cjs" start
if errorlevel 1 (
    echo [ERROR] Startup failed. Run: node scripts\farm.cjs doctor
    exit /b 1
)
exit /b 0
