# คู่มือการรัน Migration

## วิธีที่ 1: ใช้ Supabase Dashboard (แนะนำ)

1. เปิด Supabase Dashboard → ไปที่โปรเจกต์ของคุณ
2. ไปที่ **SQL Editor** (เมนูด้านซ้าย)
3. คลิก **New Query**
4. เปิดไฟล์ `supabase/migrations/007_create_bank_settings.sql`
5. Copy เนื้อหาทั้งหมดจากไฟล์
6. Paste ลงใน SQL Editor
7. คลิก **Run** หรือกด `Ctrl+Enter` (Windows) / `Cmd+Enter` (Mac)
8. รอจนเห็นข้อความ "Success" หรือ "Query executed successfully"

## วิธีที่ 2: ใช้ Supabase CLI (สำหรับ Developer)

```bash
# ตรวจสอบว่า Supabase CLI ติดตั้งแล้วหรือยัง
supabase --version

# ถ้ายังไม่มี ให้ติดตั้งด้วย
npm install -g supabase

# Login เข้า Supabase
supabase login

# Link กับโปรเจกต์ (ถ้ายังไม่ได้ link)
supabase link --project-ref <your-project-ref>

# รัน migration
supabase db push
```

## วิธีที่ 3: ใช้ Supabase Studio (Local Development)

```bash
# ถ้าใช้ Supabase Local
cd e:\Web_App\TR-ERP
supabase start
supabase migration up
```

## ตรวจสอบว่า Migration รันสำเร็จ

หลังจากรัน migration แล้ว ให้ตรวจสอบว่า:

1. ตาราง `bank_settings` ถูกสร้างแล้ว:
   ```sql
   SELECT * FROM bank_settings;
   ```

2. ตรวจสอบโครงสร้างตาราง:
   ```sql
   \d bank_settings
   -- หรือ
   SELECT column_name, data_type 
   FROM information_schema.columns 
   WHERE table_name = 'bank_settings';
   ```

## หมายเหตุ

- Migration จะรันได้ครั้งเดียวเท่านั้น (idempotent) - ถ้ารันซ้ำจะไม่เกิด error
- ใช้ `CREATE TABLE IF NOT EXISTS` เพื่อป้องกัน error ถ้าตารางมีอยู่แล้ว
- หลังจากรัน migration แล้ว ให้ไปตั้งค่าข้อมูลธนาคารที่ Settings → ตั้งค่าข้อมูลธนาคาร
