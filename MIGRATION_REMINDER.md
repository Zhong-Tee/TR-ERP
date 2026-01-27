# ⚠️ ต้องรัน Migration ก่อนใช้งาน

## Migration ที่ต้องรัน:

### 1. Migration 007: สร้างตาราง bank_settings
**ไฟล์:** `supabase/migrations/007_create_bank_settings.sql`

### 2. Migration 008: เพิ่ม account_name และ bank_settings_channels
**ไฟล์:** `supabase/migrations/008_update_bank_settings.sql`

## วิธีรัน Migration:

### วิธีที่ 1: ใช้ Supabase Dashboard (แนะนำ)
1. เปิด Supabase Dashboard → SQL Editor
2. เปิดไฟล์ `supabase/migrations/007_create_bank_settings.sql`
3. Copy เนื้อหาทั้งหมด → Paste ใน SQL Editor → Run
4. เปิดไฟล์ `supabase/migrations/008_update_bank_settings.sql`
5. Copy เนื้อหาทั้งหมด → Paste ใน SQL Editor → Run

### วิธีที่ 2: ใช้ Supabase CLI
```bash
supabase db push
```

## ตรวจสอบว่า Migration รันสำเร็จ:

```sql
-- ตรวจสอบว่ามีคอลัมน์ account_name หรือไม่
SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'bank_settings' 
AND column_name = 'account_name';

-- ตรวจสอบว่ามีตาราง bank_settings_channels หรือไม่
SELECT table_name 
FROM information_schema.tables 
WHERE table_name = 'bank_settings_channels';
```

## หมายเหตุ:

- ถ้ายังไม่รัน migration 008 ระบบจะยังทำงานได้ แต่จะไม่สามารถใช้ฟีเจอร์ `account_name` และ `channels` ได้
- ระบบจะแสดง warning แต่จะไม่ error เมื่อบันทึกข้อมูลธนาคาร
