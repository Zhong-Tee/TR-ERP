# คำแนะนำการนำเข้า CSV ข้อมูล

## ปัญหาที่พบและวิธีแก้ไข

### 1. ตาราง `cp_cartoon_patterns`
**ปัญหา:** ตารางมีคอลัมน์ `pattern_code` ที่ไม่จำเป็น

**วิธีแก้ไข:**
- ✅ รัน migration `006_remove_pattern_code_from_cartoon_patterns.sql` เพื่อลบคอลัมน์ `pattern_code`
- ✅ สร้างไฟล์ `cartoon_patterns_rows_fixed.csv` แล้ว (ลบ pattern_code ออก)

**วิธีนำเข้า:**
1. **รัน migration ก่อน:** `006_remove_pattern_code_from_cartoon_patterns.sql`
2. ไปที่ Supabase Dashboard → Table Editor → `cp_cartoon_patterns`
3. คลิก "Insert" → "Import data from CSV"
4. เลือกไฟล์ `cartoon_patterns_rows_fixed.csv`
5. ตรวจสอบว่า mapping ถูกต้อง:
   - `id` → `id`
   - `pattern_name` → `pattern_name`
   - `image_url` → `image_url`
   - `is_active` → `is_active`
   - `created_at` → `created_at`
6. คลิก "Import data"

---

### 2. ตาราง `channels`
**ปัญหา:** CSV มีคอลัมน์ `last_used_prefix` และ `bank_account` ที่ไม่มีในตาราง

**วิธีแก้ไข:**
- ✅ รัน migration `005_fix_csv_import_issues.sql` เพื่อเพิ่มคอลัมน์
- ✅ สร้างไฟล์ `channels_rows_fixed.csv` แล้ว (ลบ id ออกเพื่อให้ database generate UUID)

**วิธีนำเข้า:**
1. **รัน migration ก่อน:** `005_fix_csv_import_issues.sql`
2. ไปที่ Supabase Dashboard → Table Editor → `channels`
3. คลิก "Insert" → "Import data from CSV"
4. เลือกไฟล์ `channels_rows_fixed.csv`
5. **สำคัญ:** อย่าเลือกคอลัมน์ `id` (ปล่อยว่างไว้) เพื่อให้ database สร้าง UUID อัตโนมัติ
6. ตรวจสอบ mapping:
   - `channel_code` → `channel_code`
   - `channel_name` → `channel_name`
   - `last_used_prefix` → `last_used_prefix`
   - `bank_account` → `bank_account`
   - `created_at` → `created_at`
7. คลิก "Import data"

---

### 3. ตาราง `pr_products`
**ปัญหา:** CSV มี `id` เป็นตัวเลข (7782, 7783) แต่ตารางต้องการ UUID

**วิธีแก้ไข:**
- ✅ รัน migration `005_fix_csv_import_issues.sql` เพื่อเพิ่มคอลัมน์ `legacy_id`
- ✅ สร้างไฟล์ `products_rows_fixed.csv` แล้ว (ลบ id ออก, เพิ่ม legacy_id)

**วิธีนำเข้า:**
1. **รัน migration ก่อน:** `005_fix_csv_import_issues.sql`
2. ไปที่ Supabase Dashboard → Table Editor → `pr_products`
3. คลิก "Insert" → "Import data from CSV"
4. เลือกไฟล์ `products_rows_fixed.csv`
5. **สำคัญ:** อย่าเลือกคอลัมน์ `id` (ไม่มีในไฟล์ fixed แล้ว) เพื่อให้ database สร้าง UUID อัตโนมัติ
6. ตรวจสอบ mapping:
   - `product_code` → `product_code`
   - `product_name` → `product_name`
   - `product_type` → `product_type`
   - `product_category` → `product_category`
   - `storage_location` → `storage_location`
   - `rubber_code` → `rubber_code`
   - `is_active` → `is_active`
   - `image_url` → `image_url`
   - `legacy_id` → `legacy_id` (เก็บรหัสเดิมไว้)
   - `created_at` → `created_at`
   - `updated_at` → `updated_at`
7. คลิก "Import data"

---

## ขั้นตอนการทำงาน

### 1. รัน Migration
```sql
-- รันไฟล์เหล่านี้ใน Supabase SQL Editor (ตามลำดับ)
005_fix_csv_import_issues.sql  -- เพิ่มคอลัมน์ให้ channels และ pr_products
006_remove_pattern_code_from_cartoon_patterns.sql  -- ลบ pattern_code จาก cp_cartoon_patterns
```

### 2. ใช้ไฟล์ CSV ที่แก้ไขแล้ว
- ✅ `cartoon_patterns_rows_fixed.csv` (ไม่มี pattern_code แล้ว)
- ✅ `channels_rows_fixed.csv`
- ✅ `products_rows_fixed.csv`

### 3. นำเข้าข้อมูลตามลำดับ
1. `cp_cartoon_patterns` (ต้องรัน migration 006 ก่อน)
2. `channels` (ต้องรัน migration 005 ก่อน)
3. `pr_products` (ต้องรัน migration 005 ก่อน)

---

## หมายเหตุ

- **UUID Generation:** ไฟล์ CSV ที่แก้ไขแล้วจะไม่มีคอลัมน์ `id` หรือมีค่าว่าง เพื่อให้ Supabase สร้าง UUID อัตโนมัติ (ยกเว้น `cp_cartoon_patterns` ที่มี UUID อยู่แล้ว)
- **Legacy ID:** สำหรับ `pr_products` เก็บรหัสเดิมไว้ในคอลัมน์ `legacy_id` เพื่อการอ้างอิง
- **Pattern Code:** คอลัมน์ `pattern_code` ถูกลบออกจาก `cp_cartoon_patterns` แล้ว (ไม่จำเป็น)

---

## ถ้ายังมีปัญหา

1. ตรวจสอบว่า migration รันสำเร็จแล้ว
2. ตรวจสอบว่าไฟล์ CSV ที่ใช้เป็นไฟล์ `*_fixed.csv`
3. ตรวจสอบ mapping ของคอลัมน์ใน Supabase import dialog
4. ตรวจสอบว่าไม่มีคอลัมน์ `id` ใน import (ยกเว้น `cp_cartoon_patterns` ที่มี UUID อยู่แล้ว)
