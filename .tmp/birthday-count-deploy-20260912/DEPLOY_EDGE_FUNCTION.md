# Deploy Edge Function verify-slip

## ขั้นตอนการ Deploy

### 1. ตรวจสอบว่า Supabase CLI ตั้งค่าถูกต้อง

```powershell
# ตรวจสอบว่า login แล้ว
supabase status

# ถ้ายังไม่ได้ login
supabase login
```

### 2. Link โปรเจกต์ (ถ้ายังไม่ได้ link)

```powershell
cd e:\Web_App\TR-ERP
supabase link --project-ref zkzjbhvsltbwbtteihiy
```

### 3. Deploy Edge Function

```powershell
# Deploy function verify-slip
supabase functions deploy verify-slip
```

### 4. ตรวจสอบว่า Deploy สำเร็จ

```powershell
# ดู functions ที่ deploy แล้ว
supabase functions list
```

---

## ตรวจสอบ Secrets

### ตรวจสอบว่า Secrets ตั้งค่าแล้ว

```powershell
# ดู secrets ทั้งหมด
supabase secrets list
```

### ตั้งค่า Secrets (ถ้ายังไม่ได้ตั้ง)

```powershell
# ตั้งค่า EASYSLIP_API_KEY
supabase secrets set EASYSLIP_API_KEY=your_api_key_here

# ตั้งค่า SERVICE_ROLE_KEY
supabase secrets set SERVICE_ROLE_KEY=your_service_role_key_here

# ตั้งค่า PROJECT_URL
supabase secrets set PROJECT_URL=https://zkzjbhvsltbwbtteihiy.supabase.co
```

---

## ตรวจสอบ Logs

### ดู Logs ใน Supabase Dashboard

1. ไปที่ https://supabase.com/dashboard
2. เลือกโปรเจกต์ `zkzjbhvsltbwbtteihiy`
3. ไปที่ **Edge Functions** → **verify-slip** → **Logs**
4. ดู logs ล่าสุด

### ดู Logs ด้วย CLI

```powershell
# ดู logs ล่าสุด
supabase functions logs verify-slip

# ดู logs แบบ real-time
supabase functions logs verify-slip --follow
```

---

## Troubleshooting

### ปัญหา: Deploy ไม่สำเร็จ

**สาเหตุ:**
- ไม่ได้ login
- ไม่ได้ link โปรเจกต์
- Network issue

**วิธีแก้:**
```powershell
# Login ใหม่
supabase login

# Link โปรเจกต์ใหม่
supabase link --project-ref zkzjbhvsltbwbtteihiy

# Deploy อีกครั้ง
supabase functions deploy verify-slip
```

### ปัญหา: Secrets ไม่ทำงาน

**สาเหตุ:**
- Secrets ไม่ได้ตั้งค่า
- Secret name ผิด
- Edge Function ไม่ได้ restart หลังตั้งค่า secrets

**วิธีแก้:**
```powershell
# ตรวจสอบ secrets
supabase secrets list

# ตั้งค่า secrets ใหม่
supabase secrets set EASYSLIP_API_KEY=your_key
supabase secrets set SERVICE_ROLE_KEY=your_key
supabase secrets set PROJECT_URL=https://zkzjbhvsltbwbtteihiy.supabase.co

# Deploy function ใหม่ (เพื่อให้ secrets มีผล)
supabase functions deploy verify-slip
```

### ปัญหา: HTTP 401 Unauthorized

**สาเหตุ:**
- Session token หมดอายุ
- Edge Function require authentication

**วิธีแก้:**
1. ลองออกจากระบบและเข้าสู่ระบบใหม่
2. ตรวจสอบว่า session token ยังใช้งานได้
3. ตรวจสอบ Edge Function settings ใน Dashboard

---

## Checklist

### ก่อน Deploy:
- [ ] Login Supabase CLI แล้ว
- [ ] Link โปรเจกต์แล้ว
- [ ] ตรวจสอบว่า code ถูกต้อง

### หลัง Deploy:
- [ ] Deploy สำเร็จ (ไม่มี error)
- [ ] ตรวจสอบ logs ว่า function ทำงานได้
- [ ] ทดสอบการเชื่อมต่อจากหน้า Settings

### ตรวจสอบ Secrets:
- [ ] EASYSLIP_API_KEY ตั้งค่าแล้ว
- [ ] SERVICE_ROLE_KEY ตั้งค่าแล้ว
- [ ] PROJECT_URL ตั้งค่าแล้ว
- [ ] Deploy function ใหม่หลังตั้งค่า secrets

---

## หมายเหตุ

⚠️ **สำคัญ:**
- ต้อง Deploy function ใหม่ทุกครั้งที่แก้ไข code
- ต้อง Deploy function ใหม่หลังตั้งค่า secrets (บางครั้ง)
- ตรวจสอบ logs เพื่อหาสาเหตุของปัญหา

📝 **ขั้นตอนต่อไป:**
1. Deploy Edge Function
2. ตรวจสอบว่า Deploy สำเร็จ
3. ทดสอบการเชื่อมต่อจากหน้า Settings
4. ตรวจสอบ Logs ถ้ามีปัญหา
