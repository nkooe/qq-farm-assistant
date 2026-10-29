@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "FARM_NODE=node.exe"
if exist "%~dp0runtime\node.exe" set "FARM_NODE=%~dp0runtime\node.exe"
"%FARM_NODE%" "%~dp0scripts\farm.cjs" stop
exit /b %errorlevel%
