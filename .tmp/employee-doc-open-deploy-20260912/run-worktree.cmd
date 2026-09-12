@echo off
REM ===== รันจากโฟลเดอร์ worktree ใหม่ทุกครั้ง (TR-ERP) =====
REM ใช้: เปิด cmd ใน worktree แล้วพิมพ์  E:\Web_App\TR-ERP\run-worktree.cmd
setlocal
set MAIN=E:\Web_App\TR-ERP

echo [1/3] ตรวจ node_modules...
if not exist "%CD%\node_modules\.bin\vite.cmd" (
    if exist "%CD%\node_modules" rmdir /s /q "%CD%\node_modules"
    echo     สร้าง junction ไปยัง node_modules ของ repo หลัก...
    mklink /J "%CD%\node_modules" "%MAIN%\node_modules" >nul
) else (
    echo     node_modules พร้อมแล้ว
)

echo [2/3] ตรวจไฟล์ env...
if not exist "%CD%\.env" (
    if exist "%MAIN%\.env" copy "%MAIN%\.env" "%CD%\.env" >nul
    echo     คัดลอก .env แล้ว ^(มี VITE_SUPABASE_* - สำคัญ ห้ามขาด^)
) else (
    echo     .env พร้อมแล้ว
)
if not exist "%CD%\.env.local" (
    if exist "%MAIN%\.env.local" copy "%MAIN%\.env.local" "%CD%\.env.local" >nul
    echo     คัดลอก .env.local แล้ว
) else (
    echo     .env.local พร้อมแล้ว
)

echo [3/3] เริ่ม dev server...
call npm run dev
endlocal
