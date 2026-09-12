-- =============================================================================
-- Migration 313: เพิ่มไฟล์เอกสารแนบ (PDF) ให้ทะเบียนทรัพย์สิน
--
-- เก็บเป็น JSONB array ของ { name, path, uploaded_at } โดยไฟล์จริงอยู่ใน bucket
-- hr-assets (path ขึ้นต้น 'documents/') — ใช้ storage policy ชุดเดียวกับรูปภาพ
-- ทรัพย์สิน (migration 312) จึงไม่ต้องเพิ่ม policy ใหม่
-- =============================================================================

BEGIN;

ALTER TABLE hr_assets
  ADD COLUMN IF NOT EXISTS documents JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN hr_assets.documents IS
  'ไฟล์เอกสารแนบ (PDF) — [{name, path, uploaded_at}] path อยู่ใน bucket hr-assets';

COMMIT;
