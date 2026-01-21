# ขั้นตอนต่อไปหลังจากรัน SQL และตั้งค่า .env แล้ว

## ✅ สิ่งที่ทำเสร็จแล้ว
- [x] รัน SQL migrations
- [x] สร้างไฟล์ .env

## 📋 ขั้นตอนต่อไป

### 1. ตรวจสอบตารางที่สร้างแล้ว

จากภาพที่เห็น คุณมีตารางครบแล้ว:
- ✅ ac_refunds
- ✅ ac_verified_slips
- ✅ cp_cartoon_patterns
- ✅ or_order_items
- ✅ or_order_reviews
- ✅ or_orders
- ✅ or_work_orders
- ✅ pk_packing_logs
- ✅ pr_products
- ✅ qc_records
- ✅ qc_sessions
- ✅ st_user_menus
- ✅ us_users

**หมายเหตุ:** ถ้ายังไม่มีตาราง `channels` และ `ink_types` (ที่ใช้ในโค้ด) ให้สร้างด้วย:

```sql
-- สร้างตาราง channels
CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_code TEXT UNIQUE NOT NULL,
  channel_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view channels"
  ON channels FOR SELECT
  USING (auth.role() = 'authenticated');

-- สร้างตาราง ink_types
CREATE TABLE IF NOT EXISTS ink_types (
  id SERIAL PRIMARY KEY,
  ink_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ink_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view ink types"
  ON ink_types FOR SELECT
  USING (auth.role() = 'authenticated');
```

### 2. สร้าง Storage Buckets

1. ไปที่ Supabase Dashboard
2. เลือก **Storage** (เมนูด้านซ้าย)
3. สร้าง buckets ต่อไปนี้ (คลิก **New bucket** สำหรับแต่ละอัน):

   **Bucket 1: product-images**
   - Name: `product-images`
   - Public bucket: ✅ เปิด (checked)
   - File size limit: 50 MB
   - Allowed MIME types: `image/*`

   **Bucket 2: cartoon-patterns**
   - Name: `cartoon-patterns`
   - Public bucket: ✅ เปิด (checked)
   - File size limit: 50 MB
   - Allowed MIME types: `image/*`

   **Bucket 3: slip-images**
   - Name: `slip-images`
   - Public bucket: ✅ เปิด (checked)
   - File size limit: 10 MB
   - Allowed MIME types: `image/*`

### 3. ตั้งค่า Edge Function Secret (สำหรับ EasySlip API)

**ถ้าคุณมี EasySlip API Key:**

1. ไปที่ Supabase Dashboard
2. เลือก **Project Settings** (ไอคอนฟันเฟือง)
3. ไปที่ **Edge Functions** > **Secrets**
4. คลิก **Add new secret**
5. ใส่:
   - **Name:** `EASYSLIP_API_KEY`
   - **Value:** API Key จาก EasySlip ของคุณ
6. คลิก **Save**

**ถ้ายังไม่มี EasySlip API Key:**
- ข้ามขั้นตอนนี้ไปก่อนได้ (ระบบจะยังทำงานได้ แต่ฟีเจอร์ตรวจสลิปจะไม่ทำงาน)

### 4. Deploy Edge Function (สำหรับ EasySlip)

**ถ้าคุณมี EasySlip API Key และต้องการใช้ฟีเจอร์ตรวจสลิป:**

```bash
# ติดตั้ง Supabase CLI (ถ้ายังไม่มี)
npm install -g supabase

# Login
supabase login

# Link กับโปรเจกต์ของคุณ
# หา project-ref ได้จาก: Supabase Dashboard > Project Settings > General > Reference ID
supabase link --project-ref your-project-ref

# Deploy function
supabase functions deploy verify-slip
```

**ถ้ายังไม่พร้อม:**
- ข้ามขั้นตอนนี้ไปก่อนได้

### 5. สร้าง User แรกสำหรับทดสอบ

1. ไปที่ **Authentication** > **Users** ใน Supabase Dashboard
2. คลิก **Add user** > **Create new user**
3. ใส่:
   - **Email:** admin@example.com (หรือ email ที่คุณต้องการ)
   - **Password:** ตั้งรหัสผ่านที่ต้องการ
   - **Auto Confirm User:** ✅ เปิด (checked)
4. คลิก **Create user**

5. **เพิ่มข้อมูลในตาราง us_users:**
   - ไปที่ **Table Editor** > `us_users`
   - คลิก **Insert row** หรือ **New row**
   - ใส่ข้อมูล:
     - **id:** เลือก user id ที่เพิ่งสร้าง (จาก auth.users - คัดลอก UUID)
     - **username:** admin (หรือชื่อที่ต้องการ)
     - **role:** `superadmin` (เพื่อให้มีสิทธิ์เข้าถึงทุกเมนู)
   - คลิก **Save**

### 6. เพิ่มข้อมูลเริ่มต้น (Optional แต่แนะนำ)

**เพิ่ม Channels:**
```sql
INSERT INTO channels (channel_code, channel_name) VALUES
('SPTR', 'Shopee TR'),
('FSPTR', 'Facebook Shop TR'),
('LZTR', 'Lazada TR'),
('TTTR', 'TikTok TR'),
('SHOP', 'Shop'),
('CLAIM', 'CLAIM'),
('INFU', 'INFU');
```

**เพิ่ม Ink Types:**
```sql
INSERT INTO ink_types (ink_name) VALUES
('ดำ'),
('แดง'),
('น้ำเงิน'),
('เขียว');
```

### 7. รันโปรเจกต์

```bash
# ไปที่โฟลเดอร์โปรเจกต์
cd tr-erp

# ติดตั้ง dependencies (ถ้ายังไม่ได้ติดตั้ง)
npm install

# รัน development server
npm run dev
```

### 8. ทดสอบการ Login

1. เปิด browser ไปที่ `http://localhost:5173` (หรือ port ที่แสดงใน terminal)
2. ใช้ email และ password ที่สร้างไว้ในขั้นตอนที่ 5
3. ควรจะเข้าสู่ระบบได้และเห็น Dashboard

## 🔍 ตรวจสอบปัญหา

**ถ้า Login ไม่ได้:**
- ตรวจสอบว่า user ใน `us_users` มี id ตรงกับ user ใน `auth.users` หรือไม่
- ตรวจสอบว่า role ถูกต้องหรือไม่

**ถ้ามี error เกี่ยวกับ Supabase:**
- ตรวจสอบว่า `.env` มีค่าถูกต้อง
- ตรวจสอบว่า Supabase URL และ Key ถูกต้อง
- ดู Console ใน Browser (F12) เพื่อดู error message

**ถ้ามี error เกี่ยวกับตาราง:**
- ตรวจสอบว่า RLS policies ถูกสร้างแล้ว
- ตรวจสอบว่า user มี role ที่ถูกต้อง

## 📝 หมายเหตุ

- ระบบจะทำงานได้แม้ยังไม่ได้ deploy Edge Function (แต่ฟีเจอร์ตรวจสลิปจะไม่ทำงาน)
- คุณสามารถเพิ่ม users เพิ่มเติมได้ผ่าน Authentication > Users
- Role ที่มี: `superadmin`, `admin`, `admin_qc`, `order_staff`, `qc_staff`, `packing_staff`, `account_staff`, `viewer`
