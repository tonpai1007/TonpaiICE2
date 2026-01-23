<<<<<<< HEAD
@echo off
cd /d "%~dp0"
title Bot Launcher System

echo ==========================================
echo    Rocket Order Bot Launcher 🚀
echo ==========================================

:: 1. เปิดบอท (Node.js) ในหน้าต่างใหม่
echo [1/2] Starting Bot Server...
start "Order Bot - Server (Do not close)" cmd /k "npm start"

:: รอ 3 วินาทีให้บอทเริ่มทำงานก่อน
timeout /t 3 /nobreak >nul

:: 2. เปิด Ngrok ในหน้าต่างใหม่
echo [2/2] Starting Ngrok Tunnel...
:: ถ้าคุณใช้ Port 4000 ให้แก้ตัวเลขข้างหลังเป็น 4000
start "Ngrok - Public URL" cmd /k "ngrok http 4000"

echo.
echo ==========================================
echo    ✅ SYSTEM STARTED SUCCESSFULLY!
echo ==========================================
echo.
echo  1. Look at the "Ngrok" window.
echo  2. Copy the URL (https://....ngrok-free.app)
echo  3. Update Webhook in LINE Developers.
echo.
=======
@echo off
cd /d "%~dp0"
title Bot Launcher System

echo ==========================================
echo    Rocket Order Bot Launcher 🚀
echo ==========================================

:: 1. เปิดบอท (Node.js) ในหน้าต่างใหม่
echo [1/2] Starting Bot Server...
start "Order Bot - Server (Do not close)" cmd /k "npm start"

:: รอ 3 วินาทีให้บอทเริ่มทำงานก่อน
timeout /t 3 /nobreak >nul

:: 2. เปิด Ngrok ในหน้าต่างใหม่
echo [2/2] Starting Ngrok Tunnel...
:: ถ้าคุณใช้ Port 4000 ให้แก้ตัวเลขข้างหลังเป็น 4000
start "Ngrok - Public URL" cmd /k "ngrok http 4000"

echo.
echo ==========================================
echo    ✅ SYSTEM STARTED SUCCESSFULLY!
echo ==========================================
echo.
echo  1. Look at the "Ngrok" window.
echo  2. Copy the URL (https://....ngrok-free.app)
echo  3. Update Webhook in LINE Developers.
echo.
>>>>>>> 673fd66c48c9a4892c052fc206bbac34657f2e34
pause