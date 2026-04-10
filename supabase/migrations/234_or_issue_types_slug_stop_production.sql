-- ประเภท Issue แบบ slug (เช่น หยุดผลิต) สำหรับ logic ฝั่งแอป
ALTER TABLE or_issue_types
  ADD COLUMN IF NOT EXISTS slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS or_issue_types_slug_unique
  ON or_issue_types (slug)
  WHERE slug IS NOT NULL;

INSERT INTO or_issue_types (name, color, slug, is_active)
SELECT 'หยุดผลิต', '#92400e', 'stop_production', true
WHERE NOT EXISTS (SELECT 1 FROM or_issue_types WHERE slug = 'stop_production');

CREATE INDEX IF NOT EXISTS idx_or_issues_type_id_status
  ON or_issues (type_id, status)
  WHERE type_id IS NOT NULL;
