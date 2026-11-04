-- Add is_hidden column to or_issue_messages for soft-delete
ALTER TABLE or_issue_messages
  ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT FALSE;

-- Update unread count RPC to exclude hidden issue messages
CREATE OR REPLACE FUNCTION get_unread_chat_count(p_user_id UUID)
RETURNS TABLE(order_chat_unread BIGINT, issue_chat_unread BIGINT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_role       TEXT;
  v_username   TEXT;
  v_is_admin   BOOLEAN;
  v_is_owner   BOOLEAN;
  v_is_production BOOLEAN;
  v_order_unread BIGINT := 0;
  v_issue_unread BIGINT := 0;
BEGIN
  SELECT role, username INTO v_role, v_username
  FROM us_users WHERE id = p_user_id;

  v_is_admin := v_role IN ('superadmin', 'admin');
  v_is_owner := v_role IN ('admin-tr', 'order_staff');
  v_is_production := v_role IN ('admin_qc', 'production_staff', 'picker', 'auditor');

  -- ═══ Order Chat Unread ═══
  IF v_is_admin THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE m.is_hidden = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);

  ELSIF v_is_owner THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE m.is_hidden = false
      AND o.admin_user = v_username
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);

  ELSIF v_is_production THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE m.is_hidden = false
      AND o.admin_user = v_username
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  END IF;

  -- ═══ Issue Chat Unread ═══
  IF v_is_admin THEN
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);

  ELSIF v_is_owner THEN
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    JOIN or_issues i ON i.id = m.issue_id
    JOIN or_orders o ON o.id = i.order_id
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND o.admin_user = v_username
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);

  ELSIF v_is_production THEN
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    JOIN or_issues i ON i.id = m.issue_id
    LEFT JOIN or_orders o ON o.id = i.order_id
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND (i.created_by = p_user_id OR o.admin_user = v_username)
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  END IF;

  RETURN QUERY SELECT v_order_unread, v_issue_unread;
END;
$$;
