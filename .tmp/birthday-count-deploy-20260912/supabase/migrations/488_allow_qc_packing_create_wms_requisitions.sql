-- Allow QC and packing staff who use the production mobile mode to create
-- requisitions. Keep approval/rejection permissions unchanged.

BEGIN;

DROP POLICY IF EXISTS "WMS requisition topics read" ON public.wms_requisition_topics;
CREATE POLICY "WMS requisition topics read"
  ON public.wms_requisition_topics FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin', 'admin', 'store', 'production', 'manager',
          'production_mb', 'qc_staff', 'packing_staff'
        )
    )
  );

DROP POLICY IF EXISTS "QC and packing can read requisitions" ON public.wms_requisitions;
CREATE POLICY "QC and packing can read requisitions"
  ON public.wms_requisitions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('qc_staff', 'packing_staff')
    )
  );

DROP POLICY IF EXISTS "QC and packing can create requisitions" ON public.wms_requisitions;
CREATE POLICY "QC and packing can create requisitions"
  ON public.wms_requisitions FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('qc_staff', 'packing_staff')
    )
  );

-- The client removes the just-created pending header if inserting its items
-- fails, so permit only that narrow cleanup operation.
DROP POLICY IF EXISTS "QC and packing can delete own pending requisitions" ON public.wms_requisitions;
CREATE POLICY "QC and packing can delete own pending requisitions"
  ON public.wms_requisitions FOR DELETE
  TO authenticated
  USING (
    created_by = auth.uid()
    AND status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('qc_staff', 'packing_staff')
    )
  );

DROP POLICY IF EXISTS "QC and packing can read requisition items" ON public.wms_requisition_items;
CREATE POLICY "QC and packing can read requisition items"
  ON public.wms_requisition_items FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.wms_requisitions requisition
      WHERE requisition.requisition_id = wms_requisition_items.requisition_id
        AND requisition.created_by = auth.uid()
    )
    AND EXISTS (
      SELECT 1
      FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('qc_staff', 'packing_staff')
    )
  );

DROP POLICY IF EXISTS "QC and packing can create requisition items" ON public.wms_requisition_items;
CREATE POLICY "QC and packing can create requisition items"
  ON public.wms_requisition_items FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.wms_requisitions requisition
      WHERE requisition.requisition_id = wms_requisition_items.requisition_id
        AND requisition.created_by = auth.uid()
        AND requisition.status = 'pending'
    )
    AND EXISTS (
      SELECT 1
      FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('qc_staff', 'packing_staff')
    )
  );

COMMIT;
