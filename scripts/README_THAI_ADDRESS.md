# ที่อยู่ประเทศไทย (Thai Address Tables)

ใช้สำหรับ Auto fill ที่อยู่ในหน้าลงออเดอร์: ตรวจจับรหัสไปรษณีย์ 5 หลักในช่องที่อยู่ลูกค้า แล้วค้นหา จังหวัด, แขวง/ตำบล, เขต/อำเภอ จากตารางใน DB (หรือ fallback เป็น CSV ใน public/)

## 1. สร้างตาราง (Migration)

รัน migration 017 และ 018:

```bash
npx supabase db push
# หรือถ้าใช้ Supabase Dashboard: ไปที่ SQL Editor แล้วรันไฟล์
# 017_create_thai_address_tables.sql แล้ว 018_thai_districts_add_name_en.sql
```

## 2. ใส่ข้อมูล (Seed)

หลังสร้างตารางแล้ว รันสคริปต์ seed เพื่อโหลดข้อมูลจาก CSV เข้าตาราง:

```bash
# ตั้งค่า env (ใช้ Service Role Key เพื่อ bypass RLS ตอน insert)
# PowerShell:
$env:VITE_SUPABASE_URL="https://your-project.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
node scripts/seed_thai_address.mjs

# หรือส่ง env ตอนรัน (PowerShell):
$env:SUPABASE_SERVICE_ROLE_KEY="your-key"; node scripts/seed_thai_address.mjs
```

- ใช้ `VITE_SUPABASE_URL` หรือ `SUPABASE_URL` (URL โปรเจกต์ Supabase)
- ใช้ `SUPABASE_SERVICE_ROLE_KEY` (หาได้จาก Project Settings > API > service_role)

ไฟล์ CSV ที่ใช้: `file/Thai-proince-data/provinces.csv`, `file/Thai-proince-data/districts.csv`, `file/Thai-proince-data/sub_districts.csv`

## Logic การทำงาน

1. ผู้ใช้วางข้อความที่อยู่ (พร้อมเบอร์โทร) ในช่อง "ที่อยู่ลูกค้า" แล้วกด **Auto fill**
2. ระบบตรวจจับ **รหัสไปรษณีย์ 5 หลัก** ในข้อความก่อน
3. ใช้รหัสไปรษณีย์ค้นหาในตาราง `thai_sub_districts` (join `thai_districts`, `thai_provinces`) ได้ **จังหวัด, แขวง/ตำบล, เขต/อำเภอ**
4. แยก **เบอร์โทร** (+66 / 66 / 0 ตามด้วย 9 หลัก) ออกจากข้อความ
5. ข้อความที่เหลือใส่ในช่อง **ที่อยู่**

เขต/อำเภอ seed จาก districts.csv (id, name_th, name_en, province_id) — ถ้า name_th ใน CSV encoding ผิด ระบบจะใช้ name_en แสดงได้
