-- =====================================================================
-- RPC: get_unread_chat_count(p_user_id, p_role, p_username)
-- รวม 8-10 queries ของ TopBar unread chat เป็น 1 function call
-- รองรับทุก role: admin, owner (admin-tr, admin-pump), production
-- =====================================================================
CREATE OR REPLACE FUNCTION get_unread_chat_count(
  p_user_id UUID,
  p_role TEXT,
  p_username TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_issue_on_count bigint;
  v_issue_unread bigint := 0;
  v_order_unread bigint := 0;
  v_is_admin boolean;
  v_is_owner boolean;
  v_is_production boolean;
BEGIN
  -- Issue On count (ใช้ทุก role)
  SELECT count(*) INTO v_issue_on_count
  FROM or_issues WHERE status = 'On';

  v_is_admin := p_role IN ('superadmin', 'admin');
  v_is_owner := p_role IN ('admin-tr', 'admin-pump');
  v_is_production := p_role = 'production';

  -- ═══ Issue Chat Unread ═══
  IF v_is_admin THEN
    -- Admin/superadmin: นับ unread ทั้งหมด
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);

  ELSIF v_is_owner THEN
    -- Owner: เฉพาะ issues จาก orders ที่ตัวเองดูแล
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    JOIN or_issues i ON i.id = m.issue_id
    JOIN or_orders o ON o.id = i.order_id
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE o.admin_user = p_username
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);

  ELSIF v_is_production THEN
    -- Production: issues ที่สร้างเอง + issues จาก orders ที่ดูแล
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    JOIN or_issues i ON i.id = m.issue_id
    LEFT JOIN or_orders o ON o.id = i.order_id
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE (i.created_by = p_user_id OR o.admin_user = p_username)
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  END IF;

  -- ═══ Order Chat Unread ═══
  IF v_is_admin THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);

  ELSIF v_is_owner THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND o.admin_user = p_username
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

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_unread_chat_count(UUID, TEXT, TEXT) TO authenticated;
