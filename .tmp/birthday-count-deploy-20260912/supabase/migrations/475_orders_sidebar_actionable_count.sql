-- Sidebar ออเดอร์: นับเฉพาะรายการที่ผู้ใช้เปิดเข้าไปจัดการได้จริง และนับแต่ละออเดอร์เพียงครั้งเดียว
-- แก้เลขค้างจากบิล REQ เก่าที่ไม่ได้เชื่อมกับคำขอเคลมที่อนุมัติแล้ว

BEGIN;

CREATE OR REPLACE FUNCTION public.get_orders_sidebar_actionable_count(
  p_username TEXT DEFAULT '',
  p_role TEXT DEFAULT ''
)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::BIGINT
  FROM public.or_orders o
  WHERE
    (
      (
        o.status = 'รอลงข้อมูล'
        -- บิลเคลมสถานะรอลงข้อมูลจัดการในแท็บบิลเคลม ไม่ใช่คิวรอลงข้อมูลปกติ
        AND o.claim_type IS NULL
      )
      OR o.status = 'ลงข้อมูลผิด'
      OR (
        o.status = ANY(ARRAY['ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ']::TEXT[])
        -- รายการที่ผู้ใช้เก็บเข้าประวัติแล้วจะไม่อยู่ในแท็บตรวจสอบไม่ผ่านอีกต่อไป
        AND o.failed_queue_archived_at IS NULL
      )
      OR
      (
        o.claim_shipping_confirmed_at IS NULL
        AND o.status IS DISTINCT FROM 'ยกเลิก'
        -- ใช้ความสัมพันธ์กับคำขอเคลมเป็นแหล่งจริง ไม่ใช้เพียงเลขบิลขึ้นต้น REQ
        AND EXISTS (
          SELECT 1
          FROM public.or_claim_requests cr
          WHERE cr.created_claim_order_id = o.id
            AND cr.status = 'approved'
        )
      )
    )
    AND
    (
      (p_role = 'sales-pump' AND p_username <> '' AND o.admin_user = p_username)
      OR
      (
        p_role = 'sales-tr'
        AND o.admin_user IN (
          SELECT DISTINCT TRIM(u.username)
          FROM public.us_users u
          WHERE u.role = 'sales-tr'
            AND u.username IS NOT NULL
            AND TRIM(u.username) <> ''
          UNION
          SELECT DISTINCT TRIM(u.email)
          FROM public.us_users u
          WHERE u.role = 'sales-tr'
            AND u.email IS NOT NULL
            AND TRIM(u.email) <> ''
        )
      )
      OR p_role NOT IN ('sales-pump', 'sales-tr')
      OR p_role IS NULL
    );
$$;

REVOKE ALL ON FUNCTION public.get_orders_sidebar_actionable_count(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_orders_sidebar_actionable_count(TEXT, TEXT) TO authenticated;

COMMIT;
