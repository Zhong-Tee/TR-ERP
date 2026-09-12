# รัน Migration 019 — เพิ่มคอลัมน์ no_name_line

ถ้ากดบันทึกแล้วเจอข้อความ  
`Could not find the 'no_name_line' column of 'or_order_items' in the schema cache`  
ให้รัน migration นี้บนฐานข้อมูล **ครั้งเดียว**

## วิธีที่ 1: Supabase Dashboard (แนะนำ)

1. เปิด [Supabase Dashboard](https://supabase.com/dashboard) → เลือกโปรเจกต์
2. ไปที่ **SQL Editor**
3. วาง SQL ด้านล่าง แล้วกด **Run**

```sql
-- Add no_name_line to or_order_items (ไม่รับชื่อ = ไม่รับข้อความบรรทัด 1, 2, 3)
ALTER TABLE or_order_items
  ADD COLUMN IF NOT EXISTS no_name_line BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN or_order_items.no_name_line IS 'เมื่อ true = รายการนี้ไม่รับข้อความบรรทัด 1-3 (แสดงไม่รับชื่อที่หมายเหตุ)';
```

4. รอจนขึ้น "Success" แล้วลองกดบันทึกในฟอร์มอีกครั้ง

## วิธีที่ 2: Supabase CLI

ถ้าติดตั้ง Supabase CLI และลิงก์โปรเจกต์แล้ว:

```bash
cd E:\Web_App\TR-ERP
supabase db push
```

หรือรัน migration เฉพาะไฟล์ 019 ตามที่โปรเจกต์กำหนด
