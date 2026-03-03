@echo off
setlocal
chcp 65001 >nul

echo ======================================
echo    MC_Servant Backend Launcher
echo ======================================
echo.

cd /d "%~dp0backend"
if errorlevel 1 (
    echo [ERROR] Failed to enter backend directory.
    exit /b 1
)

echo [*] Starting FastAPI WebSocket server...
echo [*] URL: http://localhost:8765
echo [*] WebSocket: ws://localhost:8765/ws/plugin
echo.
echo Press Ctrl+C to stop the server
echo ======================================
echo.

set "UV_EXE="
where uv.exe >nul 2>nul
if %errorlevel% equ 0 set "UV_EXE=uv.exe"
if not defined UV_EXE if exist "%USERPROFILE%\.local\bin\uv.exe" set "UV_EXE=%USERPROFILE%\.local\bin\uv.exe"

if defined UV_EXE (
    echo [*] Launching with uv: %UV_EXE%
    "%UV_EXE%" run --with-requirements requirements.txt python main.py
) else (
    echo [ERROR] uv not found.
    echo Install uv or add it to PATH. Example path expected:
    echo   %USERPROFILE%\.local\bin\uv.exe
    exit /b 1
)

endlocal
