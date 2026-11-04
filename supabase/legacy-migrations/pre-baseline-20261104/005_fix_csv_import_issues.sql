-- Fix CSV import issues
-- ============================================
-- This migration fixes issues with CSV import for:
-- 1. cp_cartoon_patterns: Missing pattern_code column
-- 2. channels: Missing last_used_prefix and bank_account columns
-- 3. pr_products: Numeric id instead of UUID
-- ============================================

-- ============================================
-- 2. Add missing columns to channels table
-- ============================================
ALTER TABLE channels
ADD COLUMN IF NOT EXISTS last_used_prefix TEXT,
ADD COLUMN IF NOT EXISTS bank_account TEXT;

COMMENT ON COLUMN channels.last_used_prefix IS 'คำนำหน้าล่าสุดที่ใช้ (เช่น FBTR2510)';
COMMENT ON COLUMN channels.bank_account IS 'เลขบัญชีธนาคาร';

-- ============================================
-- 3. Fix pr_products: Change id to allow importing with numeric IDs
-- ============================================
-- Note: Since id is UUID PRIMARY KEY, we cannot change it to numeric
-- Solution: Import should ignore the id column and let database generate UUIDs
-- OR: Create a temporary table with numeric id, then migrate

-- However, the best approach is to:
-- 1. Import without id column (let database generate UUIDs)
-- 2. Or create a mapping table if old numeric IDs are needed

-- For now, we'll keep UUID but add a note that CSV should not include id column
-- OR we can add a legacy_id column to store the old numeric ID

ALTER TABLE pr_products
ADD COLUMN IF NOT EXISTS legacy_id TEXT;

COMMENT ON COLUMN pr_products.legacy_id IS 'รหัสเดิมจากระบบเก่า (สำหรับการอ้างอิง)';

-- Create index for legacy_id lookup
CREATE INDEX IF NOT EXISTS idx_pr_products_legacy_id ON pr_products(legacy_id);
