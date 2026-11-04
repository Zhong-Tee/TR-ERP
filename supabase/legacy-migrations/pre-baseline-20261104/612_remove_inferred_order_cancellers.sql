-- Migration 611 inferred legacy cancellation actors from last_edited_by or
-- admin_user. Those values are not proof of who cancelled a bill. Remove only
-- rows carrying that inferred signature, while preserving actors captured by
-- migration 610 and full-cancellation approval history.

WITH trusted_full_cancellations AS (
  SELECT DISTINCT a.order_id
  FROM public.or_order_amendments a
  WHERE a.status = 'executed'
    AND a.approved_by IS NOT NULL
    AND NOT (COALESCE(a.changes_json, '{}'::JSONB) ? 'remove_item_ids')
    AND jsonb_typeof(COALESCE(a.items_after, '[]'::JSONB)) = 'array'
    AND jsonb_array_length(COALESCE(a.items_after, '[]'::JSONB)) = 0
)
UPDATE public.or_orders o
SET cancelled_by = NULL,
    cancelled_by_name = NULL,
    cancelled_at = NULL
WHERE o.status = 'ยกเลิก'
  -- 611 copied one of these two display names.
  AND (
    NULLIF(BTRIM(o.cancelled_by_name), '') = NULLIF(BTRIM(o.last_edited_by), '')
    OR NULLIF(BTRIM(o.cancelled_by_name), '') = NULLIF(BTRIM(o.admin_user), '')
  )
  -- 611 copied the pre-migration updated_at into cancelled_at, then the normal
  -- updated_at trigger advanced updated_at. A real cancellation captured by
  -- migration 610 stamps both values with the same transaction timestamp.
  AND o.cancelled_at IS DISTINCT FROM o.updated_at
  AND NOT EXISTS (
    SELECT 1
    FROM trusted_full_cancellations trusted
    WHERE trusted.order_id = o.id
  );

NOTIFY pgrst, 'reload schema';
