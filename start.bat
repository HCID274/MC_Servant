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

set "PROJECT_PYTHON=3.12"
set "UV_EXE="
where uv.exe >nul 2>nul
if %errorlevel% equ 0 set "UV_EXE=uv.exe"
if not defined UV_EXE if exist "%USERPROFILE%\.local\bin\uv.exe" set "UV_EXE=%USERPROFILE%\.local\bin\uv.exe"

if defined UV_EXE (
    echo [*] Launching with uv: %UV_EXE%
    if not exist "pyproject.toml" (
        echo [ERROR] backend\pyproject.toml not found.
        exit /b 1
    )

    set "ENV_PYTHON_VERSION="
    set "ENV_PYTHON_VERSION_FILE=%TEMP%\mc_servant_env_python_version.txt"
    if exist ".venv\Scripts\python.exe" (
        if exist "%ENV_PYTHON_VERSION_FILE%" del /f /q "%ENV_PYTHON_VERSION_FILE%" >nul 2>nul
        ".venv\Scripts\python.exe" -c "import sys; print(str(sys.version_info.major)+'.'+str(sys.version_info.minor))" > "%ENV_PYTHON_VERSION_FILE%"
        if exist "%ENV_PYTHON_VERSION_FILE%" (
            set /p ENV_PYTHON_VERSION=<"%ENV_PYTHON_VERSION_FILE%"
            del /f /q "%ENV_PYTHON_VERSION_FILE%" >nul 2>nul
        )
    )

    if defined ENV_PYTHON_VERSION if not "%ENV_PYTHON_VERSION%"=="%PROJECT_PYTHON%" (
        echo [*] Rebuilding project environment with Python %PROJECT_PYTHON% ^(current: %ENV_PYTHON_VERSION%^)...
        rmdir /s /q ".venv"
    )

    if not exist ".venv\Scripts\python.exe" (
        echo [*] Syncing persistent uv environment with Python %PROJECT_PYTHON%...
        "%UV_EXE%" sync --python %PROJECT_PYTHON%
        if errorlevel 1 exit /b 1
    )

    "%UV_EXE%" run --no-sync --python %PROJECT_PYTHON% python main.py
) else (
    echo [ERROR] uv not found.
    echo Install uv or add it to PATH. Example path expected:
    echo   %USERPROFILE%\.local\bin\uv.exe
    exit /b 1
)

endlocal
