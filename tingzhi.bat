@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "BOT_TITLE=QQ_FARM_BOT"
set "BOT_PORT=3900"
if not "%ADMIN_PORT%"=="" set "BOT_PORT=%ADMIN_PORT%"
set "YYB_PORT=8450"
set "STOPPED=0"

rem Stop the visible project console and its complete child process tree.
tasklist /v /fi "WINDOWTITLE eq %BOT_TITLE%" | findstr /i /c:"%BOT_TITLE%" >nul 2>nul
if not errorlevel 1 (
    taskkill /fi "WINDOWTITLE eq %BOT_TITLE%" /t /f >nul 2>nul
    set "STOPPED=1"
)

rem Stop the main panel and YYB service by their configured listening ports.
for %%R in (%BOT_PORT% %YYB_PORT%) do (
    for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%%R .*LISTENING"') do (
        set "STOPPED=1"
        taskkill /pid %%P /t /f >nul 2>nul
    )
)

rem Catch direct project invocations when a process has not opened its port yet.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$procs=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and (($_.Name -in @('node.exe','nodejs.exe','pnpm.exe','pnpm.cmd','cmd.exe') -and ($_.CommandLine -like '*core\client.js*' -or $_.CommandLine -like '*core/client.js*' -or $_.CommandLine -like '*-C*core*')) -or ($_.Name -eq 'yyb-go.exe' -and $_.CommandLine -like '*qq_farm-bot*')) }; foreach($p in $procs){ taskkill.exe /PID $p.ProcessId /T /F *> $null; if($LASTEXITCODE -eq 0){ $env:QQ_FARM_STOPPED='1' } }; if($env:QQ_FARM_STOPPED -eq '1'){ exit 0 } else { exit 1 }"
if not errorlevel 1 set "STOPPED=1"

if "%STOPPED%"=="1" (
    echo [OK] QQ Farm processes stopped.
) else (
    echo [INFO] QQ Farm is not running.
)
exit /b 0
