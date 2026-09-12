# แก้ไขปัญหา HTTP 401 เมื่อเรียก Edge Function

## ปัญหาที่พบ

จาก Logs พบว่า:
- **HTTP 401** เมื่อเรียก Edge Function `verify-slip`
- JWT token มีอยู่และถูกต้อง (จาก log metadata)
- Edge Function ไม่ได้ return 401 เอง (ไม่มี code ที่ return 401)
- **สาเหตุ:** Supabase อาจ reject request ก่อนถึง Edge Function code

---

## สาเหตุที่เป็นไปได้

### 1. Edge Function Authentication Settings

Supabase Edge Functions อาจ require authentication โดย default

**วิธีแก้:**
- ตรวจสอบ Edge Function settings ใน Supabase Dashboard
- ปิด "Require authentication" (ถ้ามี)

### 2. JWT Token หมดอายุ

จาก log: `expires_at: 1769525156` (timestamp ในอนาคต - ดูถูกต้อง)
- แต่ Supabase อาจ validate token และ reject

**วิธีแก้:**
- ลอง logout และ login ใหม่
- ตรวจสอบว่า session token ยังใช้งานได้

### 3. Edge Function Permissions

Edge Function อาจมี permissions ที่ restrict access

**วิธีแก้:**
- ตรวจสอบ Edge Function permissions ใน Supabase Dashboard
- ตั้งค่าให้ allow anonymous access (ถ้าต้องการ)

---

## วิธีแก้ไข

### วิธีที่ 1: ตรวจสอบ Edge Function Settings

1. **เข้า Supabase Dashboard:**
   - ไปที่ https://supabase.com/dashboard
   - เลือกโปรเจกต์ `zkzjbhvsltbwbtteihiy`

2. **ไปที่ Edge Functions → verify-slip → Settings:**
   - คลิกที่เมนู **Edge Functions** ด้านซ้าย
   - คลิกที่ function **verify-slip**
   - คลิกแท็บ **Settings** หรือ **Details**

3. **ตรวจสอบ Authentication Settings:**
   - ตรวจสอบว่ามี "Require authentication" หรือไม่
   - ถ้ามี ให้ปิด (uncheck)
   - หรือตั้งค่าให้ allow anonymous access

### วิธีที่ 2: ใช้ Service Role Key แทน

**แก้ไข Frontend ให้ใช้ Service Role Key:**

```typescript
// ใน slipVerification.ts
const response = await fetch(`${supabaseUrl}/functions/v1/verify-slip`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${supabaseServiceRoleKey}`, // ใช้ Service Role Key
    'apikey': supabaseServiceRoleKey, // ใช้ Service Role Key
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    method: 'storage',
    storagePath,
    expectedAmount,
    bankAccount,
    bankCode,
  }),
})
```

**⚠️ หมายเหตุ:** ไม่แนะนำเพราะ Service Role Key มีสิทธิ์สูงมาก ควรเก็บไว้ใน backend เท่านั้น

### วิธีที่ 3: ใช้ supabase.functions.invoke() แทน fetch

**แก้ไข Frontend ให้ใช้ supabase.functions.invoke():**

```typescript
// ใน slipVerification.ts
const { data, error } = await supabase.functions.invoke('verify-slip', {
  body: {
    method: 'storage',
    storagePath,
    expectedAmount,
    bankAccount,
    bankCode,
  },
})
```

**ข้อดี:**
- Supabase client จัดการ authentication อัตโนมัติ
- ใช้ session token ที่ถูกต้อง
- ไม่ต้องจัดการ headers เอง

---

## แก้ไขโค้ด (แนะนำ)

### ใช้ supabase.functions.invoke() แทน fetch

**แก้ไข `slipVerification.ts`:**

```typescript
// แทนที่ fetch ด้วย supabase.functions.invoke()
const { data, error } = await supabase.functions.invoke('verify-slip', {
  body: {
    method: 'storage',
    storagePath,
    expectedAmount,
    bankAccount,
    bankCode,
  },
})

if (error) {
  throw new Error(error.message || 'Failed to verify slip')
}

return data
```

---

## Checklist

### การตรวจสอบ:
- [ ] ตรวจสอบ Edge Function settings ใน Supabase Dashboard
- [ ] ตรวจสอบว่า "Require authentication" ปิดอยู่หรือไม่
- [ ] ตรวจสอบว่า session token ยังใช้งานได้
- [ ] ดู Logs ใน Supabase Dashboard เพื่อหาสาเหตุ

### การแก้ไข:
- [ ] แก้ไขโค้ดให้ใช้ `supabase.functions.invoke()` แทน `fetch`
- [ ] หรือตั้งค่า Edge Function ให้ allow anonymous access
- [ ] Deploy Edge Function ใหม่ (ถ้าจำเป็น)
- [ ] ทดสอบการเชื่อมต่อ

---

## หมายเหตุ

⚠️ **สำคัญ:**
- HTTP 401 เกิดจาก Supabase reject request ก่อนถึง Edge Function code
- ไม่ใช่ปัญหาจาก EasySlip API (EasySlip API ทำงานได้ตาม log)
- ต้องแก้ไขที่ authentication ของ Edge Function

📝 **ขั้นตอนต่อไป:**
1. ตรวจสอบ Edge Function settings
2. แก้ไขโค้ดให้ใช้ `supabase.functions.invoke()` แทน `fetch`
3. Deploy และทดสอบ
