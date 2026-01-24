-- Fix infinite recursion in us_users RLS policies
-- รันไฟล์นี้ใน SQL Editor เพื่อแก้ปัญหา infinite recursion

-- ลบ policies เก่าที่มีปัญหา
DROP POLICY IF EXISTS "Users can view their own data" ON us_users;
DROP POLICY IF EXISTS "Admins can view all users" ON us_users;
DROP POLICY IF EXISTS "Admins can update users" ON us_users;

-- สร้าง function เพื่อตรวจสอบ role โดยไม่เกิด recursion
CREATE OR REPLACE FUNCTION check_user_role(user_id UUID, allowed_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_role TEXT;
BEGIN
  -- ใช้ SECURITY DEFINER เพื่อ bypass RLS
  SELECT role INTO user_role
  FROM us_users
  WHERE id = user_id;
  
  RETURN user_role = ANY(allowed_roles);
END;
$$;

-- สร้าง policies ใหม่ที่ใช้ function
CREATE POLICY "Users can view their own data"
  ON us_users FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Admins can view all users"
  ON us_users FOR SELECT
  USING (
    auth.uid() = id OR
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
  );

CREATE POLICY "Admins can update users"
  ON us_users FOR UPDATE
  USING (
    auth.uid() = id OR
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
  );

-- Policy สำหรับ INSERT (ให้ authenticated users สร้างตัวเองได้)
CREATE POLICY "Users can insert their own data"
  ON us_users FOR INSERT
  WITH CHECK (auth.uid() = id);
