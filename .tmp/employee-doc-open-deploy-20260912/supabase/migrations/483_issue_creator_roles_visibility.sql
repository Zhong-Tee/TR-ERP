-- Operational Issue visibility:
-- production, qc_staff and packing_staff see/count tickets they created plus
-- tickets created by sales-tr or sales-pump.

CREATE OR REPLACE FUNCTION public.get_issue_creator_profiles(p_user_ids UUID[])
RETURNS TABLE (id UUID, username TEXT, role TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, u.username::text, u.role::text
  FROM public.us_users u
  WHERE u.id = ANY(coalesce(p_user_ids, ARRAY[]::UUID[]))
    AND public.is_current_user_active()
    AND EXISTS (
      SELECT 1 FROM public.us_users viewer
      WHERE viewer.id = auth.uid()
        AND viewer.role IN (
          'superadmin', 'admin', 'sales-tr', 'sales-pump',
          'production', 'qc_staff', 'packing_staff'
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.get_issue_creator_profiles(UUID[]) TO authenticated;

DROP POLICY IF EXISTS "Order staff can manage issue reads" ON public.or_issue_reads;
CREATE POLICY "Order staff can manage issue reads"
  ON public.or_issue_reads FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order',
          'account', 'production', 'qc_staff', 'packing_staff'
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order',
          'account', 'production', 'qc_staff', 'packing_staff'
        )
    )
  );

DROP POLICY IF EXISTS "Operational staff can view sales issues" ON public.or_issues;
CREATE POLICY "Operational staff can view sales issues"
  ON public.or_issues FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.us_users viewer
      WHERE viewer.id = auth.uid()
        AND viewer.role IN ('production', 'qc_staff', 'packing_staff')
    )
    AND (
      created_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.us_users creator
        WHERE creator.id = or_issues.created_by
          AND creator.role IN ('sales-tr', 'sales-pump')
      )
    )
  );

DROP POLICY IF EXISTS "Operational staff can use sales issue messages" ON public.or_issue_messages;
CREATE POLICY "Operational staff can use sales issue messages"
  ON public.or_issue_messages FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.us_users viewer
      WHERE viewer.id = auth.uid()
        AND viewer.role IN ('production', 'qc_staff', 'packing_staff')
    )
    AND EXISTS (
      SELECT 1
      FROM public.or_issues issue
      LEFT JOIN public.us_users creator ON creator.id = issue.created_by
      WHERE issue.id = or_issue_messages.issue_id
        AND (issue.created_by = auth.uid() OR creator.role IN ('sales-tr', 'sales-pump'))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.us_users viewer
      WHERE viewer.id = auth.uid()
        AND viewer.role IN ('production', 'qc_staff', 'packing_staff')
    )
    AND EXISTS (
      SELECT 1
      FROM public.or_issues issue
      LEFT JOIN public.us_users creator ON creator.id = issue.created_by
      WHERE issue.id = or_issue_messages.issue_id
        AND (issue.created_by = auth.uid() OR creator.role IN ('sales-tr', 'sales-pump'))
    )
  );

CREATE OR REPLACE FUNCTION public.get_unread_chat_count(
  p_user_id UUID,
  p_role TEXT,
  p_username TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_issue_on_count bigint := 0;
  v_issue_unread bigint := 0;
  v_order_unread bigint := 0;
  v_is_admin boolean;
  v_is_sales_tr boolean;
  v_is_sales_pump boolean;
  v_is_production boolean;
  v_is_operational_issue boolean;
  v_role text := lower(btrim(coalesce(p_role, '')));
  v_confirm_statuses text[] := ARRAY[
    'ตรวจสอบแล้ว',
    'ไม่ต้องออกแบบ',
    'รอออกแบบ',
    'ออกแบบแล้ว',
    'รอคอนเฟิร์ม',
    'คอนเฟิร์มแล้ว'
  ]::text[];
BEGIN
  v_is_admin := v_role IN ('superadmin', 'admin');
  v_is_sales_tr := v_role = 'sales-tr';
  v_is_sales_pump := v_role = 'sales-pump';
  v_is_production := v_role = 'production';
  v_is_operational_issue := v_role IN ('production', 'qc_staff', 'packing_staff');

  IF v_is_admin THEN
    SELECT count(*) INTO v_issue_on_count
    FROM public.or_issues
    WHERE status = 'On';
  ELSIF v_is_sales_tr THEN
    SELECT count(*) INTO v_issue_on_count
    FROM public.or_issues i
    JOIN public.or_orders o ON o.id = i.order_id
    WHERE i.status = 'On'
      AND o.admin_user IN (
        SELECT DISTINCT trim(u.username) FROM public.us_users u
        WHERE u.role = 'sales-tr' AND nullif(trim(u.username), '') IS NOT NULL
        UNION
        SELECT DISTINCT trim(u.email) FROM public.us_users u
        WHERE u.role = 'sales-tr' AND nullif(trim(u.email), '') IS NOT NULL
      );
  ELSIF v_is_sales_pump THEN
    SELECT count(*) INTO v_issue_on_count
    FROM public.or_issues i
    JOIN public.or_orders o ON o.id = i.order_id
    WHERE i.status = 'On'
      AND public._sales_pump_order_owned_by_session(o.admin_user, p_user_id);
  ELSIF v_is_operational_issue THEN
    SELECT count(*) INTO v_issue_on_count
    FROM public.or_issues i
    WHERE i.status = 'On'
      AND (
        i.created_by = p_user_id
        OR EXISTS (
          SELECT 1 FROM public.us_users creator
          WHERE creator.id = i.created_by
            AND creator.role IN ('sales-tr', 'sales-pump')
        )
      );
  END IF;

  IF v_is_admin THEN
    SELECT count(*) INTO v_issue_unread
    FROM public.or_issue_messages m
    LEFT JOIN public.or_issue_reads r
      ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE coalesce(m.is_hidden, false) = false
      AND m.sender_id <> p_user_id
      AND m.created_at > coalesce(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_sales_tr THEN
    SELECT count(*) INTO v_issue_unread
    FROM public.or_issue_messages m
    JOIN public.or_issues i ON i.id = m.issue_id
    JOIN public.or_orders o ON o.id = i.order_id
    LEFT JOIN public.or_issue_reads r
      ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE coalesce(m.is_hidden, false) = false
      AND m.sender_id <> p_user_id
      AND o.admin_user IN (
        SELECT DISTINCT trim(u.username) FROM public.us_users u
        WHERE u.role = 'sales-tr' AND nullif(trim(u.username), '') IS NOT NULL
        UNION
        SELECT DISTINCT trim(u.email) FROM public.us_users u
        WHERE u.role = 'sales-tr' AND nullif(trim(u.email), '') IS NOT NULL
      )
      AND m.created_at > coalesce(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_sales_pump THEN
    SELECT count(*) INTO v_issue_unread
    FROM public.or_issue_messages m
    JOIN public.or_issues i ON i.id = m.issue_id
    JOIN public.or_orders o ON o.id = i.order_id
    LEFT JOIN public.or_issue_reads r
      ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE coalesce(m.is_hidden, false) = false
      AND m.sender_id <> p_user_id
      AND public._sales_pump_order_owned_by_session(o.admin_user, p_user_id)
      AND m.created_at > coalesce(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_operational_issue THEN
    SELECT count(*) INTO v_issue_unread
    FROM public.or_issue_messages m
    JOIN public.or_issues i ON i.id = m.issue_id
    LEFT JOIN public.or_issue_reads r
      ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE coalesce(m.is_hidden, false) = false
      AND m.sender_id <> p_user_id
      AND (
        i.created_by = p_user_id
        OR EXISTS (
          SELECT 1 FROM public.us_users creator
          WHERE creator.id = i.created_by
            AND creator.role IN ('sales-tr', 'sales-pump')
        )
      )
      AND m.created_at > coalesce(r.last_read_at, '1970-01-01'::timestamptz);
  END IF;

  -- Keep the existing Confirm/order-chat visibility for production. The two
  -- additional operational roles receive Issue chat only.
  IF v_is_admin THEN
    SELECT count(*) INTO v_order_unread
    FROM public.or_order_chat_logs m
    LEFT JOIN public.or_order_chat_reads r
      ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE coalesce(m.is_hidden, false) = false
      AND m.sender_id <> p_user_id
      AND m.created_at > coalesce(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_sales_tr THEN
    SELECT count(*) INTO v_order_unread
    FROM public.or_order_chat_logs m
    JOIN public.or_orders o ON o.id = m.order_id
    LEFT JOIN public.or_order_chat_reads r
      ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE coalesce(m.is_hidden, false) = false
      AND m.sender_id <> p_user_id
      AND o.status IS NOT NULL
      AND o.status = ANY(v_confirm_statuses)
      AND (
        o.channel_code = 'PUMP'
        OR (coalesce(o.requires_confirm_design, false) = true AND o.channel_code IS DISTINCT FROM 'PUMP')
      )
      AND o.admin_user IN (
        SELECT DISTINCT trim(u.username) FROM public.us_users u
        WHERE u.role = 'sales-tr' AND nullif(trim(u.username), '') IS NOT NULL
        UNION
        SELECT DISTINCT trim(u.email) FROM public.us_users u
        WHERE u.role = 'sales-tr' AND nullif(trim(u.email), '') IS NOT NULL
      )
      AND m.created_at > coalesce(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_sales_pump THEN
    SELECT count(*) INTO v_order_unread
    FROM public.or_order_chat_logs m
    JOIN public.or_orders o ON o.id = m.order_id
    LEFT JOIN public.or_order_chat_reads r
      ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE coalesce(m.is_hidden, false) = false
      AND m.sender_id <> p_user_id
      AND m.created_at > coalesce(r.last_read_at, '1970-01-01'::timestamptz)
      AND (
        public._sales_pump_order_owned_by_session(o.admin_user, p_user_id)
        OR EXISTS (
          SELECT 1 FROM public.or_order_chat_logs mp
          WHERE mp.order_id = o.id
            AND mp.sender_id = p_user_id
            AND coalesce(mp.is_hidden, false) = false
        )
      );
  ELSIF v_is_production THEN
    SELECT count(*) INTO v_order_unread
    FROM public.or_order_chat_logs m
    JOIN public.or_orders o ON o.id = m.order_id
    LEFT JOIN public.or_order_chat_reads r
      ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE coalesce(m.is_hidden, false) = false
      AND m.sender_id <> p_user_id
      AND m.created_at > coalesce(r.last_read_at, '1970-01-01'::timestamptz)
      AND o.status IS NOT NULL
      AND o.status = ANY(v_confirm_statuses)
      AND (
        o.channel_code = 'PUMP'
        OR (coalesce(o.requires_confirm_design, false) = true AND o.channel_code IS DISTINCT FROM 'PUMP')
      );
  END IF;

  RETURN jsonb_build_object(
    'issue_on_count', v_issue_on_count,
    'issue_unread', v_issue_unread,
    'order_unread', v_order_unread
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_unread_chat_count(UUID, TEXT, TEXT) TO authenticated;
