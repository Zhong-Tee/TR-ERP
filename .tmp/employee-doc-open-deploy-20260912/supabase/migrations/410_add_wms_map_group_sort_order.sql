-- Persist the user-defined display order of rubber/WMS mapping groups.
ALTER TABLE wh_sub_wms_map_groups
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC)::INTEGER AS position
  FROM wh_sub_wms_map_groups
)
UPDATE wh_sub_wms_map_groups AS groups
SET sort_order = ranked.position
FROM ranked
WHERE groups.id = ranked.id
  AND groups.sort_order = 0;

CREATE INDEX IF NOT EXISTS idx_wh_sub_wms_map_groups_sort_order
  ON wh_sub_wms_map_groups(sort_order, created_at);
