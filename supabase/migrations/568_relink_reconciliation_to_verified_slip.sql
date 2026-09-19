-- Relink an existing manual/manual-bill allocation to its verified EasySlip
-- twin so the same payment is not also reported as missing from Statement.
BEGIN;

CREATE OR REPLACE FUNCTION public.bank_relink_allocations_to_verified_slips(p_order_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pair RECORD;
  v_updated INTEGER := 0;
  v_rows INTEGER := 0;
BEGIN
  FOR v_pair IN
    WITH candidates AS (
      SELECT
        allocation.id AS allocation_id,
        allocation.order_id,
        slip.id AS verified_slip_id,
        tx.transaction_at,
        slip.easyslip_date,
        ABS(EXTRACT(EPOCH FROM (slip.easyslip_date - tx.transaction_at))) AS diff_seconds
      FROM public.ac_bank_reconciliation_allocations allocation
      JOIN public.ac_bank_statement_transactions tx
        ON tx.id = allocation.transaction_id
      JOIN public.ac_verified_slips slip
        ON slip.order_id = allocation.order_id
       AND COALESCE(slip.is_deleted, FALSE) = FALSE
       AND slip.easyslip_date IS NOT NULL
       AND ABS(slip.verified_amount - allocation.allocated_amount) <= 0.01
       AND slip.easyslip_date >= tx.transaction_at - INTERVAL '10 minutes'
       AND slip.easyslip_date <= tx.transaction_at + INTERVAL '10 minutes'
       AND (
         slip.validation_status = 'passed'
         OR EXISTS (
           SELECT 1
           FROM public.ac_manual_slip_easyslip_retries retry
           WHERE retry.verified_slip_id = slip.id
             AND retry.status = 'passed'
         )
       )
      WHERE allocation.verified_slip_id IS NULL
        AND (p_order_id IS NULL OR allocation.order_id = p_order_id)
        AND NOT EXISTS (
          SELECT 1
          FROM public.ac_bank_reconciliation_allocations used
          WHERE used.verified_slip_id = slip.id
            AND used.id <> allocation.id
        )
    ), ranked AS (
      SELECT
        candidate.*,
        ROW_NUMBER() OVER (
          PARTITION BY candidate.allocation_id
          ORDER BY candidate.diff_seconds, candidate.verified_slip_id
        ) AS allocation_rank,
        ROW_NUMBER() OVER (
          PARTITION BY candidate.verified_slip_id
          ORDER BY candidate.diff_seconds, candidate.allocation_id
        ) AS slip_rank
      FROM candidates candidate
    )
    SELECT *
    FROM ranked
    WHERE allocation_rank = 1 AND slip_rank = 1
    ORDER BY diff_seconds, allocation_id
  LOOP
    BEGIN
      UPDATE public.ac_bank_reconciliation_allocations
      SET verified_slip_id = v_pair.verified_slip_id,
          manual_slip_check_id = NULL,
          match_method = CASE
            WHEN date_trunc('minute', v_pair.easyslip_date) = date_trunc('minute', v_pair.transaction_at)
              THEN 'exact_verified_slip'
            ELSE 'time_tolerant_verified_slip'
          END,
          note = concat_ws(
            ' | ',
            NULLIF(note, ''),
            'เชื่อม EasySlip อัตโนมัติจากรายการจับคู่เดิม'
          )
      WHERE id = v_pair.allocation_id
        AND verified_slip_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.ac_bank_reconciliation_allocations used
          WHERE used.verified_slip_id = v_pair.verified_slip_id
            AND used.id <> v_pair.allocation_id
        );
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_updated := v_updated + v_rows;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent reconciliation already claimed this verified slip.
      NULL;
    END;
  END LOOP;

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.bank_relink_allocations_to_verified_slips(UUID)
  FROM PUBLIC, anon, authenticated;

-- Extend the trigger installed by migration 567. Whichever representation
-- arrives last (manual approval, EasySlip result, or allocation), both the
-- source identity and the allocation identity are synchronized.
CREATE OR REPLACE FUNCTION public.tr_sync_manual_verified_twins()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_id UUID;
BEGIN
  v_order_id := NEW.order_id;

  IF TG_TABLE_NAME = 'ac_manual_slip_checks' THEN
    IF NEW.status = 'approved' THEN
      PERFORM public.bank_sync_manual_verified_twins(v_order_id);
    END IF;
    PERFORM public.bank_relink_allocations_to_verified_slips(v_order_id);
  ELSIF TG_TABLE_NAME = 'ac_verified_slips' THEN
    IF NEW.easyslip_date IS NOT NULL AND NEW.validation_status = 'passed' THEN
      PERFORM public.bank_sync_manual_verified_twins(v_order_id);
      PERFORM public.bank_relink_allocations_to_verified_slips(v_order_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'ac_bank_reconciliation_allocations' THEN
    PERFORM public.bank_sync_manual_verified_twins(v_order_id);
    PERFORM public.bank_relink_allocations_to_verified_slips(v_order_id);
  END IF;

  RETURN NEW;
END;
$$;

-- Repair historical rows. No allocation is added or deleted; only the source
-- columns on an already matched allocation are changed.
SELECT public.bank_relink_allocations_to_verified_slips(NULL);

NOTIFY pgrst, 'reload schema';
COMMIT;
