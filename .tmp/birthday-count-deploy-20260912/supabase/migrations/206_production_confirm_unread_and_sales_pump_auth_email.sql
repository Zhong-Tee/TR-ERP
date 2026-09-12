-- 1) production: แชทบิลใน Confirm (channel PUMP + สถานะบอร์ด Confirm) — ไม่จำกัดแค่ admin_user = ตัวเอง
-- 2) sales-pump: เทียบ admin_user กับ email ใน auth.users ด้วย (กรณี us_users.email ไม่ sync)

CREATE OR REPLACE FUNCTION _sales_pump_order_owned_by_session(p_admin_user TEXT, p_session_user_id UUID)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me RECORD;
  jwt_email TEXT;
  auth_email TEXT;
  a text;
BEGIN
  IF p_session_user_id IS NULL OR p_admin_user IS NULL OR btrim(p_admin_user) = '' THEN
    RETURN false;
  END IF;
  SELECT username, email INTO me FROM us_users WHERE id = p_session_user_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT u.email INTO auth_email FROM auth.users u WHERE u.id = p_session_user_id;
  jwt_email := auth.jwt() ->> 'email';
  a := lower(btrim(p_admin_user));
  RETURN length(a) > 0 AND (
    (length(btrim(coalesce(me.username, ''))) > 0 AND a = lower(btrim(me.username)))
    OR (length(btrim(coalesce(me.email, ''))) > 0 AND a = lower(btrim(me.email)))
    OR (length(btrim(coalesce(jwt_email, ''))) > 0 AND a = lower(btrim(jwt_email)))
    OR (length(btrim(coalesce(auth_email, ''))) > 0 AND a = lower(btrim(auth_email)))
  );
END;
$$;

REVOKE ALL ON FUNCTION public._sales_pump_order_owned_by_session(TEXT, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION get_unread_chat_count(
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
  v_issue_on_count bigint;
  v_issue_unread bigint := 0;
  v_order_unread bigint := 0;
  v_is_admin boolean;
  v_is_sales_tr boolean;
  v_is_sales_pump boolean;
  v_is_production boolean;
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
  v_is_sales_pump := v_role IN ('sales-pump', 'admin-pump');
  v_is_production := v_role = 'production';

  IF v_is_admin THEN
    SELECT count(*) INTO v_issue_on_count
    FROM or_issues WHERE status = 'On';
  ELSIF v_is_sales_tr THEN
    SELECT count(*) INTO v_issue_on_count
    FROM or_issues i
    JOIN or_orders o ON o.id = i.order_id
    WHERE i.status = 'On'
      AND o.admin_user IN (
        SELECT DISTINCT TRIM(u.username) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.username IS NOT NULL AND TRIM(u.username) <> ''
        UNION
        SELECT DISTINCT TRIM(u.email) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.email IS NOT NULL AND TRIM(u.email) <> ''
      );
  ELSIF v_is_sales_pump THEN
    SELECT count(*) INTO v_issue_on_count
    FROM or_issues i
    JOIN or_orders o ON o.id = i.order_id
    WHERE i.status = 'On'
      AND _sales_pump_order_owned_by_session(o.admin_user, p_user_id);
  ELSE
    SELECT count(*) INTO v_issue_on_count
    FROM or_issues WHERE status = 'On';
  END IF;

  IF v_is_admin THEN
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_sales_tr THEN
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    JOIN or_issues i ON i.id = m.issue_id
    JOIN or_orders o ON o.id = i.order_id
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND o.admin_user IN (
        SELECT DISTINCT TRIM(u.username) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.username IS NOT NULL AND TRIM(u.username) <> ''
        UNION
        SELECT DISTINCT TRIM(u.email) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.email IS NOT NULL AND TRIM(u.email) <> ''
      )
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_sales_pump THEN
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    JOIN or_issues i ON i.id = m.issue_id
    JOIN or_orders o ON o.id = i.order_id
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND _sales_pump_order_owned_by_session(o.admin_user, p_user_id)
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_production THEN
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    JOIN or_issues i ON i.id = m.issue_id
    LEFT JOIN or_orders o ON o.id = i.order_id
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz)
      AND (
        i.created_by = p_user_id
        OR o.admin_user = p_username
        OR (
          o.channel_code = 'PUMP'
          AND o.status IS NOT NULL
          AND o.status = ANY(v_confirm_statuses)
        )
      );
  END IF;

  IF v_is_admin THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_sales_tr THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND o.admin_user IN (
        SELECT DISTINCT TRIM(u.username) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.username IS NOT NULL AND TRIM(u.username) <> ''
        UNION
        SELECT DISTINCT TRIM(u.email) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.email IS NOT NULL AND TRIM(u.email) <> ''
      )
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_sales_pump THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND _sales_pump_order_owned_by_session(o.admin_user, p_user_id)
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_production THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz)
      AND o.channel_code = 'PUMP'
      AND o.status IS NOT NULL
      AND o.status = ANY(v_confirm_statuses);
  END IF;

  RETURN jsonb_build_object(
    'issue_on_count', v_issue_on_count,
    'issue_unread', v_issue_unread,
    'order_unread', v_order_unread
  );
END;
$$;

CREATE OR REPLACE FUNCTION list_unread_order_chat_summaries(
  p_user_id UUID,
  p_role TEXT,
  p_username TEXT
)
RETURNS TABLE (
  order_id UUID,
  bill_no TEXT,
  customer_name TEXT,
  unread_count BIGINT,
  last_message_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
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
  IF v_role IN ('superadmin', 'admin') THEN
    RETURN QUERY
    SELECT o.id, o.bill_no, o.customer_name,
           count(m.id)::bigint,
           max(m.created_at)
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz)
    GROUP BY o.id, o.bill_no, o.customer_name
    ORDER BY max(m.created_at) DESC;

  ELSIF v_role = 'sales-tr' THEN
    RETURN QUERY
    SELECT o.id, o.bill_no, o.customer_name,
           count(m.id)::bigint,
           max(m.created_at)
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz)
      AND o.admin_user IN (
        SELECT DISTINCT TRIM(u.username) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.username IS NOT NULL AND TRIM(u.username) <> ''
        UNION
        SELECT DISTINCT TRIM(u.email) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.email IS NOT NULL AND TRIM(u.email) <> ''
      )
    GROUP BY o.id, o.bill_no, o.customer_name
    ORDER BY max(m.created_at) DESC;

  ELSIF v_role IN ('sales-pump', 'admin-pump') THEN
    RETURN QUERY
    SELECT o.id, o.bill_no, o.customer_name,
           count(m.id)::bigint,
           max(m.created_at)
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz)
      AND _sales_pump_order_owned_by_session(o.admin_user, p_user_id)
    GROUP BY o.id, o.bill_no, o.customer_name
    ORDER BY max(m.created_at) DESC;

  ELSIF v_role = 'production' THEN
    RETURN QUERY
    SELECT o.id, o.bill_no, o.customer_name,
           count(m.id)::bigint,
           max(m.created_at)
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz)
      AND o.channel_code = 'PUMP'
      AND o.status IS NOT NULL
      AND o.status = ANY(v_confirm_statuses)
    GROUP BY o.id, o.bill_no, o.customer_name
    ORDER BY max(m.created_at) DESC;
  END IF;

  RETURN;
END;
$$;
