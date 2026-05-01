@echo off
chcp 65001 >nul

echo 旧 Python 后端入口已下线。
echo 请在 WSL 中从仓库根目录执行:
echo   ./start-ts-core.sh
echo.
echo 停止服务:
echo   ./stop-ts-core.sh

exit /b 1
