-- =====================================================================
-- Fix: allow picker to read WMS notification topics
-- Root cause: migration 090 removed picker from topic read policy
-- =====================================================================

DROP POLICY IF EXISTS "WMS notification topics read" ON wms_notification_topics;

CREATE POLICY "WMS notification topics read"
  ON wms_notification_topics FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'store', 'production', 'manager', 'production_mb', 'picker')
    )
  );
