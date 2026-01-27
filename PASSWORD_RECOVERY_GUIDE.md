# คู่มือกู้คืน User และ Password

## ต้องระบุว่าเป็นของระบบไหน?

กรุณาระบุว่าลืม user/password ของระบบไหน:

1. **Supabase Dashboard** (https://supabase.com/dashboard)
2. **แอปพลิเคชัน TR-ERP** (ระบบภายใน)
3. **EasySlip Dashboard** (https://developer.easyslip.com)
4. **อื่นๆ** (ระบุ)

---

## 1. ลืม User/Password ของ Supabase Dashboard

### วิธี Reset Password:

1. **ไปที่หน้า Login:**
   - ไปที่ https://supabase.com/dashboard
   - คลิก **"Forgot password?"** หรือ **"Reset password"**

2. **ใส่ Email:**
   - ใส่ email ที่ใช้สมัคร Supabase
   - คลิก **"Send reset link"**

3. **ตรวจสอบ Email:**
   - เปิด email ที่ได้รับ
   - คลิก link เพื่อ reset password
   - ตั้ง password ใหม่

4. **Login ใหม่:**
   - ใช้ email และ password ใหม่เพื่อ login

### ถ้าไม่ได้รับ Email:

- ตรวจสอบ Spam/Junk folder
- ตรวจสอบว่า email ถูกต้อง
- รอสักครู่แล้วลองอีกครั้ง
- ติดต่อ Supabase Support: support@supabase.com

### ถ้าลืม Email:

- ตรวจสอบ email ที่ใช้สมัคร
- ตรวจสอบ email ใน password manager
- ติดต่อ Supabase Support พร้อมข้อมูล:
  - Project Reference ID: `zkzjbhvsltbwbtteihiy`
  - ชื่อโปรเจกต์
  - ข้อมูลอื่นๆ ที่จำได้

---

## 2. ลืม User/Password ของแอปพลิเคชัน TR-ERP

### วิธี Reset Password:

**ถ้าใช้ Supabase Auth:**

1. **ไปที่หน้า Login:**
   - เปิดแอปพลิเคชัน
   - คลิก **"Forgot password?"** หรือ **"Reset password"**

2. **ใส่ Email:**
   - ใส่ email ที่ใช้สมัคร
   - คลิก **"Send reset link"**

3. **ตรวจสอบ Email:**
   - เปิด email ที่ได้รับ
   - คลิก link เพื่อ reset password
   - ตั้ง password ใหม่

4. **Login ใหม่:**
   - ใช้ email และ password ใหม่เพื่อ login

**ถ้าใช้ Database Auth (Custom):**

1. **Reset ผ่าน Database:**
   - ต้องมีสิทธิ์เข้าถึง Supabase Dashboard
   - ไปที่ Database → Table Editor
   - หา table `users` หรือ `auth.users`
   - แก้ไข password hash (ต้อง hash password ใหม่)

2. **หรือ Reset ผ่าน SQL:**
   ```sql
   -- ตัวอย่าง (ต้องปรับตาม schema ของคุณ)
   UPDATE users 
   SET password_hash = 'new_hashed_password' 
   WHERE email = 'user@example.com';
   ```

### ถ้าไม่มีหน้า Reset Password:

- ติดต่อ Admin ของระบบ
- หรือ Reset ผ่าน Supabase Dashboard (ถ้าใช้ Supabase Auth)

---

## 3. ลืม User/Password ของ EasySlip Dashboard

### วิธี Reset Password:

1. **ไปที่หน้า Login:**
   - ไปที่ https://developer.easyslip.com
   - คลิก **"Forgot password?"** หรือ **"Reset password"**

2. **ใส่ Email:**
   - ใส่ email ที่ใช้สมัคร EasySlip
   - คลิก **"Send reset link"**

3. **ตรวจสอบ Email:**
   - เปิด email ที่ได้รับ
   - คลิก link เพื่อ reset password
   - ตั้ง password ใหม่

4. **Login ใหม่:**
   - ใช้ email และ password ใหม่เพื่อ login

### ถ้าไม่ได้รับ Email:

- ตรวจสอบ Spam/Junk folder
- ตรวจสอบว่า email ถูกต้อง
- ติดต่อ EasySlip Support: support@easyslip.com

---

## 4. วิธีป้องกันการลืม Password

### ใช้ Password Manager:

- **แนะนำ:** ใช้ Password Manager เช่น:
  - LastPass
  - 1Password
  - Bitwarden
  - Chrome Password Manager
  - Edge Password Manager

### บันทึกข้อมูลสำคัญ:

- **Email ที่ใช้สมัคร**
- **Project Reference ID** (สำหรับ Supabase)
- **API Keys** (เก็บไว้ในที่ปลอดภัย)

---

## Checklist การกู้คืน

### Supabase Dashboard:
- [ ] ไปที่หน้า Login
- [ ] คลิก "Forgot password?"
- [ ] ใส่ email
- [ ] ตรวจสอบ email
- [ ] Reset password
- [ ] Login ใหม่

### แอปพลิเคชัน TR-ERP:
- [ ] ไปที่หน้า Login
- [ ] คลิก "Forgot password?" (ถ้ามี)
- [ ] หรือติดต่อ Admin
- [ ] Reset password
- [ ] Login ใหม่

### EasySlip Dashboard:
- [ ] ไปที่หน้า Login
- [ ] คลิก "Forgot password?"
- [ ] ใส่ email
- [ ] ตรวจสอบ email
- [ ] Reset password
- [ ] Login ใหม่

---

## ข้อมูลสำคัญที่ควรบันทึกไว้

### Supabase:
- **Email:** `<your-email>`
- **Project Reference:** `zkzjbhvsltbwbtteihiy`
- **Project URL:** `https://zkzjbhvsltbwbtteihiy.supabase.co`

### EasySlip:
- **Email:** `<your-email>`
- **API Key:** `<your-api-key>` (เก็บไว้ในที่ปลอดภัย)

---

## ติดต่อ Support

### Supabase Support:
- **Email:** support@supabase.com
- **Website:** https://supabase.com/support

### EasySlip Support:
- **Email:** support@easyslip.com
- **Website:** https://easyslip.com (หาหน้า Contact/Support)

---

## หมายเหตุ

⚠️ **Security:**
- อย่าแชร์ password กับใคร
- ใช้ password ที่แข็งแรง
- ใช้ Password Manager
- เปิดใช้งาน 2FA (ถ้ามี)

📝 **คำแนะนำ:**
- บันทึกข้อมูลสำคัญไว้ในที่ปลอดภัย
- ใช้ Password Manager
- ตั้ง password ที่จำได้ง่ายแต่เดายาก
