@echo off
cd /d "%~dp0"

echo ==========================================
echo   YuYeShanZhuang  -  Murder Mystery Game
echo ==========================================
echo.
echo Two black windows will open:
echo    1. GameServer    (keep it open)
echo    2. TunnelLink    (your link is inside)
echo.
start "GameServer" cmd /k "node server.js"
timeout /t 2 /nobreak >nul
start "TunnelLink" cmd /k "C:\Users\43526\cloudflared-windows-amd64.exe tunnel --url http://localhost:3000 --no-autoupdate"

echo.
echo DONE.
echo Open the [TunnelLink] window and look for a line like:
echo     https://xxxx.trycloudflare.com
echo Copy that link and send it to your friends.
echo Close BOTH black windows when you finish playing.
echo.
pause
