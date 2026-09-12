# แก้ไขปัญหา Supabase Dashboard Error: "Failed to fetch permissions: Unauthorized"

## ปัญหาที่พบ

Error message: **"Failed to fetch permissions: Unauthorized"**

นี่เป็นปัญหาที่เกิดขึ้นใน **Supabase Dashboard** เอง ไม่ใช่ในแอปพลิเคชันของคุณ

---

## วิธีแก้ไข (ลองตามลำดับ)

### วิธีที่ 1: Refresh Browser (ลองก่อน)

1. **กด F5 หรือ Ctrl + R** เพื่อ refresh หน้าเว็บ
2. **กด Ctrl + Shift + R** เพื่อ hard refresh (ล้าง cache)
3. **ปิด error messages** โดยคลิกที่ปุ่ม "X" ด้านขวาของ error box

### วิธีที่ 2: Logout และ Login ใหม่

1. **Logout จาก Supabase Dashboard:**
   - คลิกที่ Profile/Avatar ด้านบนขวา
   - เลือก "Sign Out" หรือ "Logout"

2. **ล้าง Browser Cache:**
   - Chrome/Edge: `Ctrl + Shift + Delete`
   - เลือก "Cookies and other site data" และ "Cached images and files"
   - เลือก "All time"
   - คลิก "Clear data"

3. **Login ใหม่:**
   - ไปที่ https://supabase.com/dashboard
   - Login เข้าสู่ระบบใหม่

### วิธีที่ 3: ใช้ Incognito/Private Mode

1. **เปิด Incognito/Private Window:**
   - Chrome: `Ctrl + Shift + N`
   - Firefox: `Ctrl + Shift + P`
   - Edge: `Ctrl + Shift + N`

2. **Login เข้า Supabase Dashboard ใหม่**

3. **ตรวจสอบว่า error หายไปหรือไม่**

### วิธีที่ 4: ตรวจสอบ Account Permissions

1. **ตรวจสอบว่า Account ของคุณมีสิทธิ์เข้าถึงโปรเจกต์:**
   - ไปที่ https://supabase.com/dashboard
   - ตรวจสอบว่าโปรเจกต์ของคุณแสดงอยู่ในรายการ
   - ถ้าไม่แสดง แสดงว่าอาจไม่มีสิทธิ์เข้าถึง

2. **ตรวจสอบ Organization/Team:**
   - ไปที่ Settings → Team
   - ตรวจสอบว่า Account ของคุณอยู่ใน Team/Organization ที่ถูกต้อง
   - ตรวจสอบ Role/Permissions ของ Account

### วิธีที่ 5: ใช้ Supabase CLI แทน Dashboard

**ถ้า Dashboard ยังไม่ทำงาน** คุณสามารถใช้ CLI เพื่อตั้งค่า Secrets:

```bash
# ตรวจสอบว่า login แล้วหรือยัง
supabase login

# ตั้งค่า Secrets
supabase secrets set EASYSLIP_API_KEY=your-api-key-here
supabase secrets set SERVICE_ROLE_KEY=your-service-role-key-here
supabase secrets set SUPABASE_URL=https://your-project.supabase.co

# Deploy Edge Function
supabase functions deploy verify-slip
```

### วิธีที่ 6: ติดต่อ Supabase Support

**ถ้าลองทุกวิธีแล้วยังไม่ได้:**

1. **ติดต่อ Supabase Support:**
   - ไปที่ https://supabase.com/support
   - หรือส่ง email ไปที่ support@supabase.com

2. **ข้อมูลที่ควรแจ้ง:**
   - Email ที่ใช้สมัคร
   - Project Reference ID
   - Error message: "Failed to fetch permissions: Unauthorized"
   - สิ่งที่ลองทำแล้ว (refresh, logout/login, clear cache, etc.)
   - Screenshot ของ error

---

## วิธีตั้งค่า Secrets โดยใช้ CLI (ทางเลือก)

### 1. ติดตั้ง Supabase CLI

```bash
# Windows (ใช้ npm)
npm install -g supabase

# หรือใช้ Scoop
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

### 2. Login เข้า Supabase

```bash
supabase login
```

### 3. Link โปรเจกต์

```bash
# ไปที่โฟลเดอร์โปรเจกต์
cd e:\Web_App\TR-ERP

# Link โปรเจกต์
supabase link --project-ref your-project-ref
```

### 4. ตั้งค่า Secrets

```bash
# ตั้งค่า EASYSLIP_API_KEY
supabase secrets set EASYSLIP_API_KEY=your-easyslip-api-key

# ตั้งค่า SERVICE_ROLE_KEY
supabase secrets set SERVICE_ROLE_KEY=your-service-role-key

# ตั้งค่า SUPABASE_URL
supabase secrets set SUPABASE_URL=https://your-project.supabase.co
```

### 5. Deploy Edge Function

```bash
# Deploy function
supabase functions deploy verify-slip
```

### 6. ตรวจสอบ Secrets

```bash
# ดู secrets ที่ตั้งค่าไว้
supabase secrets list
```

---

## วิธีหา SERVICE_ROLE_KEY และ SUPABASE_URL โดยไม่ใช้ Dashboard

### ถ้า Dashboard ไม่ทำงาน คุณสามารถหาได้จาก:

1. **จาก Environment Variables:**
   - ตรวจสอบไฟล์ `.env` ในโปรเจกต์
   - ตรวจสอบไฟล์ `supabase/config.toml`

2. **จาก Supabase CLI:**
   ```bash
   # ดู project config
   supabase status
   ```

3. **จาก Email ที่ได้รับตอนสร้างโปรเจกต์:**
   - Supabase ส่ง email ตอนสร้างโปรเจกต์
   - Email นั้นจะมี API keys และ URLs

4. **จาก Code ที่มีอยู่แล้ว:**
   - ตรวจสอบไฟล์ config ในโปรเจกต์
   - ตรวจสอบ environment variables ที่ใช้ในแอป

---

## Checklist การแก้ไข

### ลองทำตามลำดับ:
- [ ] Refresh browser (F5 หรือ Ctrl + R)
- [ ] Hard refresh (Ctrl + Shift + R)
- [ ] ปิด error messages
- [ ] Logout และ Login ใหม่
- [ ] ล้าง Browser Cache
- [ ] ลองใช้ Incognito/Private mode
- [ ] ตรวจสอบ Account Permissions
- [ ] ใช้ Supabase CLI แทน Dashboard
- [ ] ติดต่อ Supabase Support

### ตั้งค่า Secrets (ใช้ CLI):
- [ ] ติดตั้ง Supabase CLI
- [ ] Login เข้า Supabase
- [ ] Link โปรเจกต์
- [ ] ตั้งค่า `EASYSLIP_API_KEY`
- [ ] ตั้งค่า `SERVICE_ROLE_KEY`
- [ ] ตั้งค่า `SUPABASE_URL`
- [ ] Deploy Edge Function
- [ ] ตรวจสอบ Secrets

---

## หมายเหตุ

⚠️ **สำคัญ:**
- Error นี้เป็นปัญหาของ Supabase Dashboard เอง ไม่ใช่แอปพลิเคชัน
- แอปพลิเคชันของคุณยังทำงานได้ปกติ (ถ้า credentials ถูกต้อง)
- คุณสามารถใช้ CLI แทน Dashboard ได้

📝 **ขั้นตอนต่อไป:**
1. ลองวิธีแก้ไขตามลำดับ
2. ถ้า Dashboard ยังไม่ทำงาน ใช้ CLI แทน
3. ตั้งค่า Secrets และ Deploy Edge Function
4. ทดสอบระบบ

---

## คำถามที่พบบ่อย

### Q: Error นี้ส่งผลต่อแอปพลิเคชันหรือไม่?
**A:** ไม่ส่งผลต่อแอปพลิเคชันโดยตรง แต่จะทำให้ไม่สามารถตั้งค่า Secrets ใน Dashboard ได้

### Q: ต้องใช้ Dashboard หรือไม่?
**A:** ไม่จำเป็น คุณสามารถใช้ Supabase CLI แทนได้

### Q: จะหา SERVICE_ROLE_KEY ได้อย่างไรถ้า Dashboard ไม่ทำงาน?
**A:** ตรวจสอบจาก:
- Email ที่ได้รับตอนสร้างโปรเจกต์
- ไฟล์ `.env` หรือ `config.toml`
- Environment variables ในระบบ

### Q: ถ้าใช้ CLI แล้วยังไม่ได้ล่ะ?
**A:** ติดต่อ Supabase Support พร้อมข้อมูล:
- Project Reference ID
- Error messages
- สิ่งที่ลองทำแล้ว
