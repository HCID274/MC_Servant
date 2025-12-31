@echo off
chcp 65001 >nul
echo ======================================
echo    MC_Servant Backend Launcher
echo ======================================
echo.

REM 切换到后端目录
cd /d "%~dp0backend"

REM 激活虚拟环境
if exist "..\venv\Scripts\activate.bat" (
    echo [*] Activating virtual environment...
    call "..\venv\Scripts\activate.bat"
) else (
    echo [!] Virtual environment not found, using system Python
)

echo [*] Starting FastAPI WebSocket server...
echo [*] URL: http://localhost:8765
echo [*] WebSocket: ws://localhost:8765/ws/plugin
echo.
echo Press Ctrl+C to stop the server
echo ======================================
echo.

REM 启动后端（使用 cmd /c 避免 Ctrl+C 时的 Y/N 确认）
cmd /c python main.py
