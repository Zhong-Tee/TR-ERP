# คู่มือการ Setup TR-ERP

## 1. การรัน Migrations (SQL Schema)

คุณมี 2 วิธีในการรัน migrations:

### วิธีที่ 1: ใช้ Supabase Dashboard (แนะนำ - ง่ายที่สุด)

1. ไปที่ Supabase Dashboard ของคุณ: https://app.supabase.com
2. เลือกโปรเจกต์ที่สร้างไว้
3. ไปที่เมนู **SQL Editor** (ด้านซ้าย)
4. คลิก **New Query**
5. เปิดไฟล์ `supabase/migrations/001_initial_schema.sql` ในโปรเจกต์ของคุณ
6. คัดลอกเนื้อหาทั้งหมดจากไฟล์นั้น
7. วางลงใน SQL Editor
8. คลิก **Run** หรือกด `Ctrl+Enter` (Windows) / `Cmd+Enter` (Mac)
9. รอให้รันเสร็จ (ควรเห็นข้อความ "Success. No rows returned")

### วิธีที่ 2: ใช้ Supabase CLI (สำหรับผู้ที่ติดตั้ง CLI แล้ว)

```bash
# ติดตั้ง Supabase CLI (ถ้ายังไม่มี)
npm install -g supabase

# Login
supabase login

# Link กับโปรเจกต์ของคุณ
supabase link --project-ref your-project-ref

# รัน migrations
supabase db push
```

## 2. การตั้งค่า .env

1. **สร้างไฟล์ `.env`** ในโฟลเดอร์ `tr-erp/` (root ของโปรเจกต์ React)
   - คัดลอกไฟล์ `.env.example` เป็น `.env`
   - หรือสร้างไฟล์ใหม่ชื่อ `.env`

2. **หาค่า Supabase URL และ Anon Key:**
   - ไปที่ Supabase Dashboard
   - เลือกโปรเจกต์ของคุณ
   - ไปที่ **Project Settings** (ไอคอนฟันเฟือง)
   - เลือกแท็บ **API**
   - คุณจะเห็น:
     - **Project URL** → ใส่ใน `VITE_SUPABASE_URL`
     - **anon public** key → ใส่ใน `VITE_SUPABASE_ANON_KEY`

3. **ตัวอย่างไฟล์ `.env`:**
```env
VITE_SUPABASE_URL=https://abcdefghijklmnop.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoaWprbG1ub3AiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTYzODk2ODAwMCwiZXhwIjoxOTU0NTQ0MDAwfQ.example-key-here
```

## 3. สร้าง Storage Buckets

1. ไปที่ Supabase Dashboard
2. เลือก **Storage** (เมนูด้านซ้าย)
3. สร้าง buckets ต่อไปนี้:
   - `product-images` (Public)
   - `cartoon-patterns` (Public)
   - `slip-images` (Public)

   สำหรับแต่ละ bucket:
   - คลิก **New bucket**
   - ใส่ชื่อ bucket
   - เลือก **Public bucket** (ถ้าต้องการให้เข้าถึงได้โดยไม่ต้อง login)
   - คลิก **Create bucket**

## 4. ตั้งค่า Edge Function Secret (สำหรับ EasySlip API)

1. ไปที่ Supabase Dashboard
2. เลือก **Edge Functions** (เมนูด้านซ้าย)
3. คลิก **Secrets** หรือไปที่ **Project Settings > Edge Functions > Secrets**
4. เพิ่ม secret:
   - **Name:** `EASYSLIP_API_KEY`
   - **Value:** API Key จาก EasySlip ของคุณ

## 5. Deploy Edge Function (ถ้าต้องการ)

```bash
# ติดตั้ง Supabase CLI (ถ้ายังไม่มี)
npm install -g supabase

# Login
supabase login

# Link กับโปรเจกต์
supabase link --project-ref your-project-ref

# Deploy function
supabase functions deploy verify-slip
```

## 6. สร้าง User แรก (สำหรับทดสอบ)

หลังจากรัน migrations แล้ว:

1. ไปที่ **Authentication** > **Users** ใน Supabase Dashboard
2. คลิก **Add user** > **Create new user**
3. ใส่ email และ password
4. หลังจากสร้าง user แล้ว:
   - ไปที่ **Table Editor** > `us_users`
   - เพิ่ม row ใหม่:
     - `id`: เลือก user id ที่เพิ่งสร้าง (จาก auth.users)
     - `username`: ใส่ชื่อที่ต้องการ
     - `role`: ใส่ `superadmin` หรือ `admin`

## 7. รันโปรเจกต์

```bash
cd tr-erp
npm install
npm run dev
```

## หมายเหตุ

- ไฟล์ `.env` จะไม่ถูก commit ไปที่ Git (อยู่ใน .gitignore แล้ว)
- อย่าลืมตั้งค่า RLS policies ให้ถูกต้อง (อยู่ใน migration file แล้ว)
- ถ้ามีปัญหา ให้ตรวจสอบ Console ใน Browser และ Supabase Logs
