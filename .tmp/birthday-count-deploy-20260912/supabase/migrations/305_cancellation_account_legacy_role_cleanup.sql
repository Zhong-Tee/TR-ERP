-- =============================================================================
-- Migration 305: bill cancellation and account approval role cleanup
--   - Remove admin-tr from bill cancellation.
--   - Approval/manage policies use superadmin/admin/account only.
--   - Existing sales read/create-pending policies are preserved unchanged.
-- =============================================================================

BEGIN;

-- Latest cancellation RPC: remove admin-tr without granting sales-*.
DO $$
DECLARE
  routine_oid oid;
  definition text;
BEGIN
  routine_oid := to_regprocedure('public.rpc_execute_bill_cancellation(uuid)');
  IF routine_oid IS NOT NULL THEN
    definition := pg_get_functiondef(routine_oid);
    definition := regexp_replace(
      definition,
      ',[[:space:]]*''admin-tr''',
      '',
      'g'
    );

    IF definition LIKE '%admin-tr%' THEN
      RAISE EXCEPTION 'Unable to safely remove admin-tr from rpc_execute_bill_cancellation';
    END IF;

    EXECUTE definition;
  END IF;
END;
$$;

-- Full refund approval/management remains account/admin/superadmin.
-- Sales policies from migration 279 continue to allow only pending requests.
DO $$
BEGIN
  IF to_regclass('public.ac_refunds') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Account staff can manage refunds" ON public.ac_refunds';
    EXECUTE $policy$
      CREATE POLICY "Account staff can manage refunds"
      ON public.ac_refunds FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.us_users u
          WHERE u.id = auth.uid()
            AND u.role IN ('superadmin', 'admin', 'account')
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.us_users u
          WHERE u.id = auth.uid()
            AND u.role IN ('superadmin', 'admin', 'account')
        )
      )
    $policy$;
  END IF;
END;
$$;

-- Manual-slip approval/write remains account/admin/superadmin. Do not replace
-- the separate read and pending-submission policies used by sales.
DO $$
BEGIN
  IF to_regclass('public.ac_manual_slip_checks') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "ac_manual_slip_checks write" ON public.ac_manual_slip_checks';
    EXECUTE $policy$
      CREATE POLICY "ac_manual_slip_checks write"
      ON public.ac_manual_slip_checks FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.us_users u
          WHERE u.id = auth.uid()
            AND u.role IN ('superadmin', 'admin', 'account')
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.us_users u
          WHERE u.id = auth.uid()
            AND u.role IN ('superadmin', 'admin', 'account')
        )
      )
    $policy$;
  END IF;
END;
$$;

COMMIT;
