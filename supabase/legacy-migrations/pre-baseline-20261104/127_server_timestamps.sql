-- ============================================
-- 127: Server-side timestamps for PR approve/reject and PO ordered
-- ============================================

CREATE OR REPLACE FUNCTION rpc_approve_pr(p_pr_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE inv_pr
  SET status = 'approved', approved_by = p_user_id, approved_at = NOW()
  WHERE id = p_pr_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'PR ไม่อยู่ในสถานะรออนุมัติ'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION rpc_reject_pr(p_pr_id UUID, p_user_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE inv_pr
  SET status = 'rejected', rejected_by = p_user_id, rejected_at = NOW(), rejection_reason = p_reason
  WHERE id = p_pr_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'PR ไม่อยู่ในสถานะรออนุมัติ'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION rpc_mark_po_ordered(p_po_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE inv_po
  SET status = 'ordered', ordered_by = p_user_id, ordered_at = NOW()
  WHERE id = p_po_id AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'PO ไม่อยู่ในสถานะเปิด'; END IF;
END;
$$;
