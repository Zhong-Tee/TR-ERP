-- Legacy direct cancellations only changed or_orders.status and therefore do
-- not have a trustworthy cancelled_by audit UUID. Fill their display snapshot
-- from the closest actor information available on the bill: last editor first,
-- then bill creator. New cancellations are captured exactly by migration 610.

UPDATE public.or_orders
SET cancelled_by_name = COALESCE(
      NULLIF(BTRIM(cancelled_by_name), ''),
      NULLIF(BTRIM(last_edited_by), ''),
      NULLIF(BTRIM(admin_user), '')
    ),
    cancelled_at = COALESCE(cancelled_at, updated_at)
WHERE status = 'ยกเลิก'
  AND NULLIF(BTRIM(cancelled_by_name), '') IS NULL;

-- Link the repaired display name back to a user when it unambiguously matches
-- a username or email. The display snapshot remains available if no match is
-- found or the old user account no longer exists.
WITH actor_matches AS (
  SELECT
    o.id AS order_id,
    (
      SELECT u.id
      FROM public.us_users u
      WHERE BTRIM(COALESCE(u.username, '')) = BTRIM(o.cancelled_by_name)
         OR LOWER(BTRIM(COALESCE(u.email, ''))) = LOWER(BTRIM(o.cancelled_by_name))
      ORDER BY u.created_at DESC NULLS LAST, u.id
      LIMIT 1
    ) AS user_id
  FROM public.or_orders o
  WHERE o.status = 'ยกเลิก'
    AND o.cancelled_by IS NULL
    AND NULLIF(BTRIM(o.cancelled_by_name), '') IS NOT NULL
)
UPDATE public.or_orders o
SET cancelled_by = matches.user_id
FROM actor_matches matches
WHERE o.id = matches.order_id
  AND matches.user_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
