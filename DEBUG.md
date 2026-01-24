# คู่มือ Debug เมื่อหน้าขาว

## ตรวจสอบปัญหา

### 1. เปิด Browser Console (F12)
ดูว่ามี error อะไรหรือไม่

### 2. ตรวจสอบ .env
- เปิดไฟล์ `tr-erp/.env`
- ตรวจสอบว่ามีค่าครบ:
  ```
  VITE_SUPABASE_URL=https://your-project.supabase.co
  VITE_SUPABASE_ANON_KEY=your-key-here
  ```

### 3. ตรวจสอบ Console Messages
ควรเห็น:
- ✅ Supabase client initialized
- AppRoutes - loading: false, user: null (ถ้ายังไม่ได้ login)

### 4. ตรวจสอบ Network Tab
- ดูว่ามี request ไป Supabase หรือไม่
- ดูว่ามี error 401, 403 หรือไม่

### 5. ตรวจสอบ User ใน Database
- ไปที่ Supabase Dashboard > Table Editor > `us_users`
- ตรวจสอบว่ามี user หรือไม่
- ถ้าไม่มี ให้สร้าง user ตามขั้นตอนใน NEXT_STEPS.md

## ปัญหาที่พบบ่อย

### หน้าขาว + Console แสดง "Missing Supabase environment variables"
**แก้ไข:** ตรวจสอบไฟล์ `.env` และ restart dev server

### หน้าขาว + Console แสดง "User not found in us_users table"
**แก้ไข:** 
1. สร้าง user ใน Authentication > Users
2. เพิ่มข้อมูลใน Table Editor > `us_users`:
   - `id`: UUID จาก auth.users
   - `username`: ชื่อที่ต้องการ
   - `role`: `superadmin`

### หน้าขาว + Network error 401/403
**แก้ไข:** 
- ตรวจสอบ RLS policies
- ตรวจสอบว่า user มี role ที่ถูกต้อง

### หน้าขาว + ไม่มี error
**แก้ไข:**
- ตรวจสอบว่า Tailwind CSS ทำงานหรือไม่
- ลอง hard refresh (Ctrl+Shift+R)
