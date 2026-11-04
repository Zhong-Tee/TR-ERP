-- ============================================
-- 131: Purchase badge counts (single RPC)
-- ============================================

CREATE OR REPLACE FUNCTION get_purchase_badge_counts()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE AS $$
DECLARE
  v_pr_pending INT;
  v_pr_approved_no_po INT;
  v_po_waiting_gr INT;
BEGIN
  -- PR pending count
  SELECT COUNT(*) INTO v_pr_pending
  FROM inv_pr WHERE status = 'pending';

  -- Approved PRs that don't have a PO yet
  SELECT COUNT(*) INTO v_pr_approved_no_po
  FROM inv_pr pr
  WHERE pr.status = 'approved'
    AND NOT EXISTS (SELECT 1 FROM inv_po po WHERE po.pr_id = pr.id);

  -- POs waiting for GR (ordered or partial)
  SELECT COUNT(*) INTO v_po_waiting_gr
  FROM inv_po WHERE status IN ('ordered', 'partial');

  RETURN jsonb_build_object(
    'pr_pending', v_pr_pending,
    'pr_approved_no_po', v_pr_approved_no_po,
    'po_waiting_gr', v_po_waiting_gr
  );
END;
$$;
