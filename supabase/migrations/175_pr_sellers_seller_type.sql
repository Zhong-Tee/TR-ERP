-- ประเภทผู้ขาย: ประเทศไทย / ต่างประเทศ
ALTER TABLE pr_sellers
  ADD COLUMN IF NOT EXISTS seller_type TEXT NOT NULL DEFAULT 'foreign';

ALTER TABLE pr_sellers
  DROP CONSTRAINT IF EXISTS pr_sellers_seller_type_chk;

ALTER TABLE pr_sellers
  ADD CONSTRAINT pr_sellers_seller_type_chk
  CHECK (seller_type IN ('thailand', 'foreign'));

COMMENT ON COLUMN pr_sellers.seller_type IS 'thailand=ประเทศไทย, foreign=ต่างประเทศ';
