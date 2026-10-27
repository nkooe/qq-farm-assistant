@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "BOT_RUN_NAME=QQFarmBot"
set "BOT_PORT=3900"
if not "%ADMIN_PORT%"=="" set "BOT_PORT=%ADMIN_PORT%"

set "PNPM_CMD="
where pnpm >nul 2>nul
if errorlevel 1 (
    where corepack >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Neither pnpm nor corepack was found.
        if /i not "%~1"=="--startup" pause
        exit /b 1
    )
    set "PNPM_CMD=corepack pnpm"
) else (
    set "PNPM_CMD=pnpm"
)

rem Repair missing or stale workspace links before the first frontend build.
if not exist "%~dp0web\node_modules\vue-tsc\bin\vue-tsc.js" (
    echo [INFO] Workspace dependencies are incomplete, installing...
    call %PNPM_CMD% install -r --force
    if errorlevel 1 (
        echo [ERROR] Dependency installation failed.
        if /i not "%~1"=="--startup" pause
        exit /b 1
    )
)

rem Register this script for the current Windows user. /startup avoids a pause during logon.
set "QQ_FARM_SCRIPT=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$value=[char]34 + $env:QQ_FARM_SCRIPT + [char]34 + ' --startup'; New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name '%BOT_RUN_NAME%' -Value $value" >nul 2>nul
if errorlevel 1 (
    echo [WARN] Could not register Windows startup task.
) else if /i not "%~1"=="--startup" (
    echo [OK] Windows startup enabled for the current user.
)

if /i "%~1"=="--startup" goto :run_startup

call "%~dp0start.bat"
set "START_RESULT=%errorlevel%"
if not "%START_RESULT%"=="0" pause
exit /b %START_RESULT%

:run_startup
call "%~dp0start.bat"
set "START_RESULT=%errorlevel%"
exit /b %START_RESULT%
