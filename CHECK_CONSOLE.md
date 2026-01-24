# ตรวจสอบ Console เพื่อแก้ปัญหา "กำลังโหลด..."

## ขั้นตอน

1. **เปิด Console Tab** (ใน DevTools ที่เปิดอยู่)
   - คลิกแท็บ "คอนโซล" (Console) ใน DevTools

2. **ดู Messages** ควรเห็น:
   - `✅ Supabase client initialized` หรือ
   - `❌ Supabase client NOT initialized - check .env file`
   - `AppRoutes - loading: true/false, user: null/object`

3. **ดู Errors** (ถ้ามี):
   - Error สีแดง
   - Warning สีเหลือง

## ปัญหาที่พบบ่อย

### ถ้าเห็น "❌ Missing Supabase environment variables"
**แก้ไข:**
1. ตรวจสอบไฟล์ `tr-erp/.env`
2. ตรวจสอบว่ามีค่าครบ:
   ```
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-key-here
   ```
3. **Restart dev server** (Ctrl+C แล้วรัน `npm run dev` อีกครั้ง)

### ถ้าเห็น "Error loading user data" หรือ "User not found in us_users table"
**แก้ไข:**
1. ไปที่ Supabase Dashboard > Authentication > Users
2. สร้าง user ใหม่ (ถ้ายังไม่มี)
3. ไปที่ Table Editor > `us_users`
4. เพิ่ม row:
   - `id`: คัดลอก UUID จาก user ที่สร้าง
   - `username`: admin
   - `role`: superadmin

### ถ้าเห็น "AppRoutes - loading: true" ตลอดเวลา
**แก้ไข:**
- อาจเป็นเพราะ Supabase connection ไม่สำเร็จ
- ตรวจสอบ .env และ restart server

## ส่งข้อมูลมาให้
กรุณาบอกว่าใน Console มี messages หรือ errors อะไรบ้าง
