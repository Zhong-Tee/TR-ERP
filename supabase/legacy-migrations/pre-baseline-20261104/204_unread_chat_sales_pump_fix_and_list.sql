-- sales-pump: นับ unread ให้ตรงกับบิลจริง (admin_user อาจเทียบกับ username หรือ email ของ us_users)
-- เพิ่ม RPC รายการบิลที่มีแชทคำสั่งซื้อยังไม่อ่าน สำหรับแท็บ IssueBoard

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
BEGIN
  v_is_admin := p_role IN ('superadmin', 'admin');
  v_is_sales_tr := p_role = 'sales-tr';
  v_is_sales_pump := p_role = 'sales-pump';
  v_is_production := p_role = 'production';

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
    INNER JOIN us_users me ON me.id = p_user_id
    WHERE i.status = 'On'
      AND (
        TRIM(COALESCE(o.admin_user, '')) = TRIM(COALESCE(me.username, ''))
        OR (me.email IS NOT NULL AND TRIM(COALESCE(o.admin_user, '')) = TRIM(me.email))
      );
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
    INNER JOIN us_users me ON me.id = p_user_id
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND (
        TRIM(COALESCE(o.admin_user, '')) = TRIM(COALESCE(me.username, ''))
        OR (me.email IS NOT NULL AND TRIM(COALESCE(o.admin_user, '')) = TRIM(me.email))
      )
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_production THEN
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    JOIN or_issues i ON i.id = m.issue_id
    LEFT JOIN or_orders o ON o.id = i.order_id
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND (i.created_by = p_user_id OR o.admin_user = p_username)
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
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
    INNER JOIN us_users me ON me.id = p_user_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND (
        TRIM(COALESCE(o.admin_user, '')) = TRIM(COALESCE(me.username, ''))
        OR (me.email IS NOT NULL AND TRIM(COALESCE(o.admin_user, '')) = TRIM(me.email))
      )
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_production THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz)
      AND (
        m.order_id IN (SELECT id FROM or_orders WHERE admin_user = p_username)
        OR m.order_id IN (SELECT order_id FROM or_issues WHERE created_by = p_user_id)
      );
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
BEGIN
  IF p_role IN ('superadmin', 'admin') THEN
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

  ELSIF p_role = 'sales-tr' THEN
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

  ELSIF p_role = 'sales-pump' THEN
    RETURN QUERY
    SELECT o.id, o.bill_no, o.customer_name,
           count(m.id)::bigint,
           max(m.created_at)
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    INNER JOIN us_users me ON me.id = p_user_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz)
      AND (
        TRIM(COALESCE(o.admin_user, '')) = TRIM(COALESCE(me.username, ''))
        OR (me.email IS NOT NULL AND TRIM(COALESCE(o.admin_user, '')) = TRIM(me.email))
      )
    GROUP BY o.id, o.bill_no, o.customer_name
    ORDER BY max(m.created_at) DESC;

  ELSIF p_role = 'production' THEN
    RETURN QUERY
    SELECT o.id, o.bill_no, o.customer_name,
           count(m.id)::bigint,
           max(m.created_at)
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz)
      AND (
        m.order_id IN (SELECT id FROM or_orders WHERE admin_user = p_username)
        OR m.order_id IN (SELECT order_id FROM or_issues WHERE created_by = p_user_id)
      )
    GROUP BY o.id, o.bill_no, o.customer_name
    ORDER BY max(m.created_at) DESC;
  END IF;

  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION list_unread_order_chat_summaries(UUID, TEXT, TEXT) TO authenticated;
