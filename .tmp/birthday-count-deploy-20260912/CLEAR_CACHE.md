# วิธี Clear Vite Cache

## วิธีที่ 1: ลบโฟลเดอร์ .vite (แนะนำ)

1. หยุด dev server (กด Ctrl+C)
2. ลบโฟลเดอร์ `tr-erp/node_modules/.vite` (ถ้ามี)
3. รัน `npm run dev` ใหม่

## วิธีที่ 2: ใช้ PowerShell

```powershell
cd tr-erp
Remove-Item -Recurse -Force node_modules\.vite -ErrorAction SilentlyContinue
npm run dev
```

## วิธีที่ 3: ลบทั้งหมดและติดตั้งใหม่

```powershell
cd tr-erp
Remove-Item -Recurse -Force node_modules
Remove-Item -Recurse -Force node_modules\.vite -ErrorAction SilentlyContinue
npm install
npm run dev
```
