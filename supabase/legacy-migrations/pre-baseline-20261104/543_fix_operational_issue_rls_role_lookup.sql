-- Keep operational Issue rows aligned with get_unread_chat_count().
--
-- The previous policies queried us_users directly to inspect the Issue creator.
-- Operational roles can only read their own us_users row, so a packing/qc/
-- production user could not resolve a sales creator and the Issue row was
-- hidden even though the SECURITY DEFINER unread-count RPC counted it.
-- check_user_role() is SECURITY DEFINER and is the established RLS-safe role
-- lookup used elsewhere in this schema.

DROP POLICY IF EXISTS "Operational staff can view sales issues" ON public.or_issues;
CREATE POLICY "Operational staff can view sales issues"
  ON public.or_issues FOR SELECT
  USING (
    public.check_user_role(
      auth.uid(),
      ARRAY['production', 'qc_staff', 'packing_staff']
    )
    AND (
      created_by = auth.uid()
      OR public.check_user_role(
        created_by,
        ARRAY['sales-tr', 'sales-pump']
      )
    )
  );

DROP POLICY IF EXISTS "Operational staff can use sales issue messages" ON public.or_issue_messages;
CREATE POLICY "Operational staff can use sales issue messages"
  ON public.or_issue_messages FOR ALL
  USING (
    public.check_user_role(
      auth.uid(),
      ARRAY['production', 'qc_staff', 'packing_staff']
    )
    AND EXISTS (
      SELECT 1
      FROM public.or_issues issue
      WHERE issue.id = or_issue_messages.issue_id
        AND (
          issue.created_by = auth.uid()
          OR public.check_user_role(
            issue.created_by,
            ARRAY['sales-tr', 'sales-pump']
          )
        )
    )
  )
  WITH CHECK (
    public.check_user_role(
      auth.uid(),
      ARRAY['production', 'qc_staff', 'packing_staff']
    )
    AND EXISTS (
      SELECT 1
      FROM public.or_issues issue
      WHERE issue.id = or_issue_messages.issue_id
        AND (
          issue.created_by = auth.uid()
          OR public.check_user_role(
            issue.created_by,
            ARRAY['sales-tr', 'sales-pump']
          )
        )
    )
  );
