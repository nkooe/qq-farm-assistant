@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "BOT_TITLE=QQ_FARM_BOT"
set "BOT_PORT=3900"
if not "%ADMIN_PORT%"=="" set "BOT_PORT=%ADMIN_PORT%"
set "YYB_PORT=8450"
set "YYB_DATA_DIR=%~dp0core\data"
set "YYB_BIN_DIR=%YYB_DATA_DIR%\bin"
set "YYB_EXE=%YYB_BIN_DIR%\yyb-go.exe"
set "YYB_RESOURCE_ROOT=%~dp0yyb-go\resource"
set "YYB_WORK_DIR=%~dp0yyb-go"
set "YYB_TOKEN_FILE=%YYB_DATA_DIR%\yyb_token"
set "YYB_ADMIN_USER=admin"
set "YYB_ADMIN_PASS=123456"
set "PNPM_CMD="

where pnpm >nul 2>nul
if errorlevel 1 (
    where corepack >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Neither pnpm nor corepack was found.
        pause
        exit /b 1
    )
    set "PNPM_CMD=corepack pnpm"
) else (
    set "PNPM_CMD=pnpm"
)

if not exist "%YYB_DATA_DIR%" mkdir "%YYB_DATA_DIR%"
if not exist "%YYB_BIN_DIR%" mkdir "%YYB_BIN_DIR%"

if not exist "%YYB_TOKEN_FILE%" powershell -NoProfile -Command "[IO.File]::WriteAllText($env:YYB_TOKEN_FILE,[Guid]::NewGuid().ToString('N'))"

set /p "YYB_API_TOKEN="<"%YYB_TOKEN_FILE%"
set "YYB_API_KEY=%YYB_API_TOKEN%"
set "YYB_API_URL=http://127.0.0.1:%YYB_PORT%"

set "YYB_NEEDS_BUILD=0"
if not exist "%YYB_EXE%" set "YYB_NEEDS_BUILD=1"
if exist "%YYB_EXE%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$exe=(Get-Item -LiteralPath $env:YYB_EXE).LastWriteTimeUtc; if(Get-ChildItem -LiteralPath $env:YYB_WORK_DIR -Recurse -File -Filter '*.go' | Where-Object { $_.LastWriteTimeUtc -gt $exe } | Select-Object -First 1){ exit 0 }; exit 1"
    if not errorlevel 1 set "YYB_NEEDS_BUILD=1"
)

if "%YYB_NEEDS_BUILD%"=="1" (
    where go >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Go was not found. Cannot build the YYB service.
        exit /b 1
    )
    rem Windows locks a running EXE. Stop only the YYB listener before replacing it.
    for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%YYB_PORT% .*LISTENING"') do taskkill /pid %%P /t /f >nul 2>nul
    echo [INFO] Building updated YYB service...
    pushd "%YYB_WORK_DIR%"
    set "GOPROXY=https://goproxy.cn,direct"
    go build -o "%YYB_EXE%" .\cmd\yyb-go
    if errorlevel 1 (
        popd
        echo [ERROR] YYB service build failed.
        exit /b 1
    )
    popd
)

set "YYB_RUNNING=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%YYB_PORT%" ^| findstr "LISTENING"') do set "YYB_RUNNING=1"
if "%YYB_RUNNING%"=="0" (
    echo [INFO] Starting YYB service in background...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Start-Process -FilePath $env:YYB_EXE -ArgumentList @('-host','127.0.0.1','-port',$env:YYB_PORT,'-resource-root',$env:YYB_RESOURCE_ROOT) -WorkingDirectory $env:YYB_WORK_DIR -WindowStyle Hidden -PassThru; for($i=0;$i -lt 30;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri ($env:YYB_API_URL + '/health'); if($r.StatusCode -eq 200){ exit 0 } } catch {}; if($p.HasExited){ exit 1 }; Start-Sleep -Milliseconds 200 }; exit 1"
    if errorlevel 1 (
        echo [ERROR] YYB service failed to start.
        exit /b 1
    )
    echo [OK] YYB service is running.
) else (
    echo [INFO] YYB service is already running on port %YYB_PORT%.
)

set "BOT_RUNNING=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%BOT_PORT%" ^| findstr "LISTENING"') do set "BOT_RUNNING=1"
if "%BOT_RUNNING%"=="1" goto :already_running

if not exist "%~dp0core\node_modules" (
    echo [INFO] Installing workspace dependencies...
    call %PNPM_CMD% install -r
    if errorlevel 1 (
        echo [ERROR] Dependency installation failed.
        pause
        exit /b 1
    )
)

set "WEB_DIST_INDEX=%~dp0web\dist\index.html"
set "WEB_SOURCE_DIR=%~dp0web\src"
set "WEB_NEEDS_BUILD=0"
if not exist "%WEB_DIST_INDEX%" set "WEB_NEEDS_BUILD=1"
if exist "%WEB_DIST_INDEX%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$dist=(Get-Item -LiteralPath $env:WEB_DIST_INDEX).LastWriteTimeUtc; if(Get-ChildItem -LiteralPath $env:WEB_SOURCE_DIR -Recurse -File | Where-Object { $_.LastWriteTimeUtc -gt $dist } | Select-Object -First 1){ exit 0 }; exit 1"
    if not errorlevel 1 set "WEB_NEEDS_BUILD=1"
)

if "%WEB_NEEDS_BUILD%"=="1" (
    echo [INFO] Building updated web panel...
    call %PNPM_CMD% -C web build
    if errorlevel 1 (
        echo [ERROR] Web build failed.
        pause
        exit /b 1
    )
)

echo [INFO] Starting QQ Farm in background...
set "ADMIN_PORT=%BOT_PORT%"
set "QQ_FARM_CORE=%~dp0core"
set "QQ_FARM_ENTRY=%~dp0core\client.js"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Start-Process -FilePath 'node.exe' -ArgumentList @($env:QQ_FARM_ENTRY) -WorkingDirectory $env:QQ_FARM_CORE -WindowStyle Hidden -PassThru; Start-Sleep -Milliseconds 800; if($p.HasExited){ exit 1 }"
if errorlevel 1 (
    echo [ERROR] QQ Farm failed to start. Check core\data\logs.
    exit /b 1
)

echo [OK] QQ Farm is running in background.
echo [INFO] Panel: http://localhost:%BOT_PORT%
echo [INFO] YYB scan: http://localhost:%YYB_PORT%/scan
exit /b 0

:already_running
echo [INFO] QQ Farm is already running on port %BOT_PORT%.
echo [INFO] YYB scan: http://localhost:%YYB_PORT%/scan
exit /b 0
