# คู่มือตั้งค่า PROJECT_URL Secret

## ปัญหา

Supabase CLI ไม่ให้ตั้งค่า secret ที่ชื่อขึ้นต้นด้วย `SUPABASE_` เพราะเป็น reserved prefix

**Error:**
```
Env name cannot start with SUPABASE_, skipping: SUPABASE_URL
```

---

## วิธีแก้ไข

### ✅ ใช้ `PROJECT_URL` แทน `SUPABASE_URL`

**เหตุผล:**
- Supabase CLI ไม่ให้ตั้งค่า secret ที่ขึ้นต้นด้วย `SUPABASE_`
- ใช้ชื่อ `PROJECT_URL` แทนเพื่อหลีกเลี่ยงปัญหา
- Edge Function รองรับทั้ง `PROJECT_URL` และ `SUPABASE_URL` (fallback)

---

## ขั้นตอนการตั้งค่า

### วิธีที่ 1: ใช้ Supabase CLI

```powershell
cd e:\Web_App\TR-ERP

# ตั้งค่า PROJECT_URL
supabase secrets set PROJECT_URL=https://zkzjbhvsltbwbtteihiy.supabase.co
```

### วิธีที่ 2: ใช้ Dashboard

1. **เข้า Supabase Dashboard:**
   - ไปที่ https://supabase.com/dashboard
   - เลือกโปรเจกต์ `zkzjbhvsltbwbtteihiy`

2. **ไปที่ Settings → Edge Functions → Secrets:**
   - คลิกที่เมนู **Settings** ด้านซ้าย
   - คลิกที่ **Edge Functions**
   - คลิกแท็บ **Secrets**

3. **เพิ่ม Secret:**
   - คลิก **Add new secret**
   - **Name:** `PROJECT_URL`
   - **Value:** `https://zkzjbhvsltbwbtteihiy.supabase.co`
   - คลิก **Save**

---

## Secrets ที่ต้องตั้งค่า

**ต้องตั้งค่า Secrets ทั้งหมด 3 ตัว:**

1. **EASYSLIP_API_KEY**
   - API Key จาก EasySlip

2. **SERVICE_ROLE_KEY**
   - Service Role Key จาก Supabase (หาได้จาก Settings → API)

3. **PROJECT_URL**
   - Project URL: `https://zkzjbhvsltbwbtteihiy.supabase.co`
   - ⚠️ **ใช้ชื่อ `PROJECT_URL` แทน `SUPABASE_URL`**

---

## Checklist

### การตั้งค่า Secrets:
- [ ] ตั้งค่า `EASYSLIP_API_KEY`
- [ ] ตั้งค่า `SERVICE_ROLE_KEY`
- [ ] ตั้งค่า `PROJECT_URL` (แทน SUPABASE_URL)
- [ ] ตรวจสอบ Secrets (`supabase secrets list`)

### การทดสอบ:
- [ ] Deploy Edge Function ใหม่ (ถ้าจำเป็น)
- [ ] ทดสอบการเชื่อมต่อจากหน้า Settings
- [ ] ตรวจสอบผลลัพธ์

---

## หมายเหตุ

✅ **ดีแล้ว:**
- ใช้ชื่อ `PROJECT_URL` แทน `SUPABASE_URL` เพื่อหลีกเลี่ยง reserved prefix
- Edge Function รองรับทั้ง `PROJECT_URL` และ `SUPABASE_URL` (fallback)

⚠️ **สำคัญ:**
- ใช้ชื่อ `PROJECT_URL` เท่านั้น (ไม่ใช่ `SUPABASE_URL`)
- ค่า URL: `https://zkzjbhvsltbwbtteihiy.supabase.co`

📝 **ขั้นตอนต่อไป:**
1. ตั้งค่า `PROJECT_URL` secret
2. Deploy Edge Function ใหม่ (ถ้าจำเป็น)
3. ทดสอบการเชื่อมต่อ

---

## คำถามที่พบบ่อย

### Q: ทำไมต้องใช้ `PROJECT_URL` แทน `SUPABASE_URL`?
**A:** เพราะ Supabase CLI ไม่ให้ตั้งค่า secret ที่ชื่อขึ้นต้นด้วย `SUPABASE_` (reserved prefix)

### Q: Edge Function จะใช้ `PROJECT_URL` ได้หรือไม่?
**A:** ได้ Edge Function รองรับทั้ง `PROJECT_URL` และ `SUPABASE_URL` (fallback)

### Q: ถ้ายังใช้ `SUPABASE_URL` จะเกิดอะไรขึ้น?
**A:** Supabase CLI จะข้าม secret นั้น (skip) และจะไม่ถูกตั้งค่า
