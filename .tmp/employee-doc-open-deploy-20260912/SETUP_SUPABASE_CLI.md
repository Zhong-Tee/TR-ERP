# คู่มือตั้งค่า Supabase CLI สำหรับโปรเจกต์ TR-ERP

## สถานะปัจจุบัน

- ✅ Supabase CLI ติดตั้งแล้ว (version 2.72.7)
- ✅ Supabase Dashboard เข้าได้แล้ว
- ⚠️ มี error เกี่ยวกับ organization `segargvekjxvtibkpiax` (ไม่มีอยู่หรือไม่มีสิทธิ์) - **ไม่เป็นปัญหา** แค่ปิด error message ได้
- ✅ Organization "TEE-ZHONG" ใช้งานได้ (มี 2 projects)
- 📋 ข้อมูลโปรเจกต์:
  - Project Reference: `zkzjbhvsltbwbtteihiy`
  - SUPABASE_URL: `https://zkzjbhvsltbwbtteihiy.supabase.co`

---

## ขั้นตอนการตั้งค่า

### 0. เข้า Dashboard และเลือก Organization (ถ้าใช้ Dashboard)

1. **เข้า Supabase Dashboard:**
   - ไปที่ https://supabase.com/dashboard
   - Login เข้าสู่ระบบ

2. **ปิด Error Message (ถ้ามี):**
   - ถ้ามี error "Organization not found" ให้ปิด error message นั้น
   - Error นี้ไม่เป็นปัญหา แค่เป็น organization ที่ไม่มีอยู่หรือไม่มีสิทธิ์

3. **เลือก Organization:**
   - คลิกเข้าไปที่ organization **"TEE-ZHONG"**
   - ตรวจสอบว่าโปรเจกต์ `zkzjbhvsltbwbtteihiy` อยู่ใน organization นี้

4. **เข้าไปที่โปรเจกต์:**
   - คลิกเข้าไปที่โปรเจกต์ที่ต้องการ
   - ไปที่ Settings → Edge Functions → Secrets เพื่อตั้งค่า Secrets

### 1. Login เข้า Supabase (ถ้าใช้ CLI)

```powershell
# ไปที่โฟลเดอร์โปรเจกต์
cd e:\Web_App\TR-ERP

# Login เข้า Supabase
supabase login
```

**หมายเหตุ:** คำสั่งนี้จะเปิด browser เพื่อให้คุณ login เข้า Supabase

### 2. Link โปรเจกต์ Remote

```powershell
# Link โปรเจกต์ remote
supabase link --project-ref zkzjbhvsltbwbtteihiy
```

**หมายเหตุ:** 
- ถ้ามี prompt ให้เลือก organization ให้เลือก organization ที่ถูกต้อง
- ถ้ามี prompt ให้ยืนยัน ให้กด Y

### 3. ตั้งค่า Secrets สำหรับ Edge Functions

```powershell
# ตั้งค่า EASYSLIP_API_KEY (ต้องหา API Key จาก EasySlip ก่อน)
supabase secrets set EASYSLIP_API_KEY=your-easyslip-api-key-here

# ตั้งค่า SERVICE_ROLE_KEY (หาได้จาก Email ที่ได้รับตอนสร้างโปรเจกต์)
supabase secrets set SERVICE_ROLE_KEY=your-service-role-key-here

# ตั้งค่า PROJECT_URL (แทน SUPABASE_URL เพื่อหลีกเลี่ยง reserved prefix)
supabase secrets set PROJECT_URL=https://zkzjbhvsltbwbtteihiy.supabase.co
```

**วิธีหา SERVICE_ROLE_KEY:**
- ตรวจสอบ Email ที่ได้รับตอนสร้างโปรเจกต์ Supabase
- Email นั้นจะมี API keys รวมถึง service_role key
- หรือถ้ามีไฟล์ config เก่า อาจเก็บไว้ที่นั่น

### 4. ตรวจสอบ Secrets ที่ตั้งค่าไว้

```powershell
# ดู secrets ทั้งหมด
supabase secrets list
```

### 5. Deploy Edge Function

```powershell
# Deploy function verify-slip
supabase functions deploy verify-slip
```

### 6. ตรวจสอบว่า Deploy สำเร็จ

```powershell
# ดู logs ของ function
supabase functions logs verify-slip
```

---

## Checklist

### การตั้งค่า:
- [ ] Login เข้า Supabase (`supabase login`)
- [ ] Link โปรเจกต์ (`supabase link --project-ref zkzjbhvsltbwbtteihiy`)
- [ ] ตั้งค่า `EASYSLIP_API_KEY` (ต้องหา API Key ก่อน)
- [ ] ตั้งค่า `SERVICE_ROLE_KEY` (หาได้จาก Email)
- [ ] ตั้งค่า `PROJECT_URL` (แทน SUPABASE_URL)
- [ ] ตรวจสอบ Secrets (`supabase secrets list`)
- [ ] Deploy Edge Function (`supabase functions deploy verify-slip`)
- [ ] ตรวจสอบ Logs (`supabase functions logs verify-slip`)

---

## คำสั่งที่มีประโยชน์

### ดูข้อมูลโปรเจกต์:
```powershell
# ดู project info
supabase projects list
```

### ดู Edge Functions:
```powershell
# ดู functions ทั้งหมด
supabase functions list
```

### ดู Logs:
```powershell
# ดู logs ของ function
supabase functions logs verify-slip

# ดู logs แบบ real-time
supabase functions logs verify-slip --follow
```

### ลบ Secret:
```powershell
# ลบ secret
supabase secrets unset SECRET_NAME
```

---

## Troubleshooting

### ปัญหา: "You are not logged in"
**แก้ไข:**
```powershell
supabase login
```

### ปัญหา: "Project not found"
**แก้ไข:**
- ตรวจสอบว่า project-ref ถูกต้อง: `zkzjbhvsltbwbtteihiy`
- ตรวจสอบว่า login แล้วและมีสิทธิ์เข้าถึงโปรเจกต์

### ปัญหา: "Permission denied"
**แก้ไข:**
- ตรวจสอบว่า Account ของคุณมีสิทธิ์เข้าถึงโปรเจกต์
- ลอง logout และ login ใหม่

### ปัญหา: "Secret not found"
**แก้ไข:**
- ตรวจสอบว่า secret name ถูกต้อง (case-sensitive)
- ตรวจสอบว่า link โปรเจกต์แล้ว

---

## หมายเหตุ

⚠️ **Security:**
- อย่าเปิดเผย `SERVICE_ROLE_KEY` หรือ `EASYSLIP_API_KEY`
- อย่า commit secrets ลงใน git
- Secrets จะถูกเก็บไว้ใน Supabase Cloud

📝 **ขั้นตอนต่อไป:**
1. Login และ Link โปรเจกต์
2. หา `SERVICE_ROLE_KEY` จาก Email
3. หา `EASYSLIP_API_KEY` จาก EasySlip (ถ้ายังไม่มี)
4. ตั้งค่า Secrets ทั้ง 3 ตัว
5. Deploy Edge Function
6. ทดสอบระบบ

---

## คำถามที่พบบ่อย

### Q: จะหา SERVICE_ROLE_KEY ได้อย่างไร?
**A:** 
- ตรวจสอบ Email ที่ได้รับตอนสร้างโปรเจกต์ Supabase
- Email นั้นจะมี API keys รวมถึง service_role key
- หรือถ้ามีไฟล์ config เก่า อาจเก็บไว้ที่นั่น

### Q: จะหา EASYSLIP_API_KEY ได้อย่างไร?
**A:**
- ต้องเข้า EasySlip Dashboard (แต่ตอนนี้ถูกบล็อค)
- หรือตรวจสอบว่ามี API Key เก่าหรือไม่ (จาก notes, password manager, email)
- หรือติดต่อ EasySlip Support เพื่อขอ API Key

### Q: ถ้า Dashboard กลับมาใช้งานได้ ต้องทำอะไรต่อ?
**A:**
- Secrets ที่ตั้งค่าไว้ด้วย CLI จะแสดงใน Dashboard
- คุณสามารถจัดการ Secrets ได้ทั้งจาก Dashboard และ CLI
