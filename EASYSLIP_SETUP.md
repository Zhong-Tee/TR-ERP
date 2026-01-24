# คู่มือการตั้งค่า Easyslip API

## ขั้นตอนการตั้งค่า

### 1. ตั้งค่า EASYSLIP_API_KEY ใน Supabase Secrets

1. ไปที่ [Supabase Dashboard](https://app.supabase.com)
2. เลือกโปรเจกต์ของคุณ
3. ไปที่ **Settings** → **Edge Functions** → **Secrets**
4. คลิก **Add new secret**
5. ตั้งค่า:
   - **Name**: `EASYSLIP_API_KEY`
   - **Value**: API Key จาก Easyslip ของคุณ
6. คลิก **Save**

### 2. Deploy Edge Function

รันคำสั่งต่อไปนี้ใน terminal:

```bash
# ตรวจสอบว่าคุณอยู่ในโฟลเดอร์โปรเจกต์
cd e:\Web_App\TR-ERP

# Login to Supabase (ถ้ายังไม่ได้ login)
supabase login

# Link โปรเจกต์ (ถ้ายังไม่ได้ link)
supabase link --project-ref your-project-ref

# Deploy Edge Function
supabase functions deploy verify-slip
```

### 3. ตรวจสอบการ Deploy

1. ไปที่ Supabase Dashboard → **Edge Functions**
2. ตรวจสอบว่า `verify-slip` function ถูก deploy แล้ว
3. ตรวจสอบ logs เพื่อดูว่ามี error หรือไม่

### 4. ทดสอบการเชื่อมต่อ

1. เปิดแอปพลิเคชัน
2. สร้างออเดอร์ใหม่
3. อัพโหลดสลิปโอนเงิน
4. กดปุ่ม "บันทึก (ข้อมูลครบ)"
5. ตรวจสอบว่าไม่มี error เกี่ยวกับ Edge Function

## การแก้ไขปัญหา

### Error: "EASYSLIP_API_KEY not configured"
- ตรวจสอบว่าได้ตั้งค่า Secret ใน Supabase Dashboard แล้ว
- ตรวจสอบว่าชื่อ Secret ถูกต้อง: `EASYSLIP_API_KEY`
- Deploy Edge Function ใหม่หลังจากตั้งค่า Secret

### Error: "Failed to send a request to the Edge Function"
- ตรวจสอบว่า Edge Function ถูก deploy แล้ว
- ตรวจสอบ logs ใน Supabase Dashboard → Edge Functions → verify-slip → Logs
- ตรวจสอบ network connectivity

### Error: "EasySlip API error"
- ตรวจสอบว่า API Key ถูกต้อง
- ตรวจสอบว่า API Key ยังใช้งานได้ (ไม่หมดอายุ)
- ตรวจสอบ quota ของ Easyslip API

## ข้อมูลเพิ่มเติม

- Easyslip API Documentation: https://document.easyslip.com/documents/verify/bank/image
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
