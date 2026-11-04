BEGIN;

-- Match the daily sheet's work-order classification and completion-time fallback,
-- with an exact audit cutoff instead of an end-of-day cutoff. Definer rights are
-- needed because auditors may read Audit but cannot read raw WMS records.
CREATE OR REPLACE FUNCTION public.fn_audit_sub_warehouse_snapshot(p_product_id uuid, p_at timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH ledger AS (
    SELECT m.sub_warehouse_id,sum(m.qty_delta) qty
    FROM public.wh_sub_warehouse_stock_moves m
    WHERE m.product_id=p_product_id AND m.created_at<=p_at
    GROUP BY m.sub_warehouse_id
  ), warehouse_ids AS (
    SELECT a.sub_warehouse_id FROM public.wh_sub_warehouse_products a
    WHERE a.product_id=p_product_id AND a.created_at<=p_at
    UNION SELECT b.sub_warehouse_id FROM ledger b WHERE b.qty<>0
  ), mappings AS (
    SELECT ids.sub_warehouse_id,g.id group_id
    FROM warehouse_ids ids
    JOIN public.wh_sub_wms_map_groups g
      ON (g.sub_warehouse_id IS NULL OR g.sub_warehouse_id=ids.sub_warehouse_id)
      AND g.created_at<=p_at
    JOIN public.wh_sub_wms_map_spares s ON s.group_id=g.id AND s.product_id=p_product_id
  ), usage_codes AS (
    SELECT p.product_code FROM public.pr_products p WHERE p.id=p_product_id
    UNION
    SELECT p.product_code FROM mappings g
    JOIN public.wh_sub_wms_map_sources s ON s.group_id=g.group_id
    JOIN public.pr_products p ON p.id=s.product_id
  ), relevant_orders AS MATERIALIZED (
    SELECT wms.* FROM public.wms_orders wms
    JOIN usage_codes codes ON codes.product_code::text=wms.product_code::text
    WHERE wms.status='correct'
  ), summary_times AS (
    SELECT btrim(s.order_id) order_id,min(s.checked_at) checked_at
    FROM public.wms_order_summaries s
    WHERE btrim(s.order_id) IN (SELECT btrim(r.order_id) FROM relevant_orders r)
    GROUP BY btrim(s.order_id)
  ), work_names AS MATERIALIZED (
    SELECT DISTINCT btrim(COALESCE(o.work_order_name,'')) name FROM public.or_orders o
  ), usage_rows AS (
    SELECT wms.product_code,wms.qty,
      COALESCE(summary.checked_at,direct_completion.wms_review_completed_at,completion.completed_at,
        CASE WHEN wms.fulfillment_mode IN ('system_complete','sub_warehouse_skip') THEN wms.end_time END) used_at
    FROM relevant_orders wms
    LEFT JOIN summary_times summary ON summary.order_id=btrim(wms.order_id)
    LEFT JOIN public.or_work_orders direct_completion ON direct_completion.id=wms.work_order_id
    LEFT JOIN LATERAL (
      SELECT w.wms_review_completed_at completed_at FROM public.or_work_orders w
      WHERE wms.work_order_id IS NULL AND summary.checked_at IS NULL
        AND btrim(w.work_order_name)=btrim(wms.order_id)
      ORDER BY w.created_at DESC LIMIT 1
    ) completion ON true
    WHERE wms.status='correct'
      AND NOT EXISTS (SELECT 1 FROM public.wms_requisitions r WHERE r.requisition_id=wms.order_id)
      AND upper(btrim(COALESCE(wms.order_id,''))) NOT LIKE 'REQ-%'
      AND (wms.work_order_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM work_names o
        WHERE o.name=btrim(COALESCE(wms.order_id,''))
      ))
  ), usage_totals AS (
    SELECT product_code,sum(qty) qty FROM usage_rows
    WHERE used_at<=p_at GROUP BY product_code
  ), mapped_totals AS (
    SELECT g.sub_warehouse_id,COALESCE(sum(u.qty),0) qty
    FROM mappings g
    LEFT JOIN public.wh_sub_wms_map_sources s ON s.group_id=g.group_id
    LEFT JOIN public.pr_products p ON p.id=s.product_id
    LEFT JOIN usage_totals u ON u.product_code::text=p.product_code::text
    GROUP BY g.sub_warehouse_id
  ), balances AS (
    SELECT ids.sub_warehouse_id,COALESCE(l.qty,0)-
      CASE WHEN mapped.sub_warehouse_id IS NOT NULL THEN mapped.qty ELSE COALESCE(direct.qty,0) END qty
    FROM warehouse_ids ids
    LEFT JOIN ledger l ON l.sub_warehouse_id=ids.sub_warehouse_id
    LEFT JOIN mapped_totals mapped ON mapped.sub_warehouse_id=ids.sub_warehouse_id
    LEFT JOIN public.pr_products p ON p.id=p_product_id
    LEFT JOIN usage_totals direct ON direct.product_code::text=p.product_code::text
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sub_warehouse_id',w.id,'name',w.name,'qty',b.qty
  ) ORDER BY w.name,w.id),'[]'::jsonb)
  FROM balances b JOIN public.wh_sub_warehouses w ON w.id=b.sub_warehouse_id
  WHERE w.created_at<=p_at AND (w.is_active OR b.qty<>0 OR EXISTS (
    SELECT 1 FROM ledger l WHERE l.sub_warehouse_id=w.id AND l.qty<>0
  ));
$$;
REVOKE ALL ON FUNCTION public.fn_audit_sub_warehouse_snapshot(uuid,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_audit_sub_warehouse_snapshot(uuid,timestamptz) TO authenticated;

-- Keep a permanent before/after record. Legacy NULL snapshots remain NULL and
-- are reconstructed through the existing RLS-protected RPC using the fixed formula.
CREATE TABLE public.inv_audit_sub_warehouse_corrections (
  item_id uuid PRIMARY KEY REFERENCES public.inv_audit_items(id) ON DELETE CASCADE,
  audit_id uuid NOT NULL REFERENCES public.inv_audits(id) ON DELETE CASCADE,
  cutoff_at timestamptz NOT NULL,
  previous_snapshot jsonb NOT NULL,
  corrected_snapshot jsonb NOT NULL,
  corrected_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL DEFAULT '673: subtract completed WMS work-order usage at audit cutoff'
);
ALTER TABLE public.inv_audit_sub_warehouse_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_audit_sub_warehouse_corrections FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.inv_audit_sub_warehouse_corrections TO authenticated;
CREATE POLICY audit_sub_corrections_read ON public.inv_audit_sub_warehouse_corrections
FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.inv_audit_items i WHERE i.id=item_id)
);

-- Serialize the one-time repair with Audit writes. No permanent trigger bypass.
LOCK TABLE public.inv_audits IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.inv_audit_items IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE audit_sub_repair_before ON COMMIT DROP AS
  SELECT id,to_jsonb(i)-'sub_warehouse_snapshot' data FROM public.inv_audit_items i;

INSERT INTO public.inv_audit_sub_warehouse_corrections(item_id,audit_id,cutoff_at,previous_snapshot,corrected_snapshot)
SELECT i.id,i.audit_id,COALESCE(a.frozen_at,a.created_at),i.sub_warehouse_snapshot,repair.snapshot
FROM public.inv_audit_items i JOIN public.inv_audits a ON a.id=i.audit_id
CROSS JOIN LATERAL (
  SELECT public.fn_audit_sub_warehouse_snapshot(i.product_id,COALESCE(a.frozen_at,a.created_at)) snapshot
) computed
CROSS JOIN LATERAL (
  -- Retain the original warehouse names, ordering, and scope of the frozen sheet.
  SELECT jsonb_agg(CASE WHEN corrected.value IS NULL THEN original.value
    ELSE jsonb_set(original.value,'{qty}',corrected.value->'qty') END ORDER BY original.n) snapshot
  FROM jsonb_array_elements(i.sub_warehouse_snapshot) WITH ORDINALITY original(value,n)
  LEFT JOIN LATERAL (
    SELECT candidate.value FROM jsonb_array_elements(computed.snapshot) candidate(value)
    WHERE candidate.value->>'sub_warehouse_id'=original.value->>'sub_warehouse_id'
  ) corrected ON true
) repair
WHERE i.sub_warehouse_snapshot IS NOT NULL AND repair.snapshot IS NOT NULL
  AND i.sub_warehouse_snapshot IS DISTINCT FROM repair.snapshot;

DO $$
DECLARE t record;
BEGIN
  -- Only these two known validation triggers need to be suspended. Fail closed
  -- if additional user triggers have been added that could change other fields.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.inv_audit_items'::regclass
    AND NOT tgisinternal AND tgname NOT IN ('guard_audit_sub_warehouse_snapshot','guard_separate_audit_count')) THEN
    RAISE EXCEPTION 'Unexpected Audit item trigger; review before repairing snapshots';
  END IF;
  CREATE TEMP TABLE audit_sub_repair_triggers ON COMMIT DROP AS
    SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='public.inv_audit_items'::regclass AND NOT tgisinternal;
  FOR t IN SELECT * FROM audit_sub_repair_triggers LOOP
    EXECUTE format('ALTER TABLE public.inv_audit_items DISABLE TRIGGER %I',t.tgname);
  END LOOP;
  UPDATE public.inv_audit_items i SET sub_warehouse_snapshot=c.corrected_snapshot
  FROM public.inv_audit_sub_warehouse_corrections c WHERE c.item_id=i.id;
  FOR t IN SELECT * FROM audit_sub_repair_triggers LOOP
    EXECUTE format('ALTER TABLE public.inv_audit_items %s TRIGGER %I',
      CASE t.tgenabled WHEN 'D' THEN 'DISABLE' WHEN 'R' THEN 'ENABLE REPLICA'
        WHEN 'A' THEN 'ENABLE ALWAYS' ELSE 'ENABLE' END,t.tgname);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.inv_audit_items i FULL JOIN audit_sub_repair_before b USING(id)
    WHERE b.data IS DISTINCT FROM (to_jsonb(i)-'sub_warehouse_snapshot')
  ) THEN RAISE EXCEPTION 'Audit count data changed; rolling back snapshot repair'; END IF;
END;
$$;
COMMIT;
NOTIFY pgrst,'reload schema';
