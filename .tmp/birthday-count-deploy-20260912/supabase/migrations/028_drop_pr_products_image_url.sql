-- ลบคอลัมน์ image_url จาก pr_products
-- รูปสินค้าดึงจาก Bucket product-images ชื่อไฟล์ = product_code (.jpg/.png ฯลฯ)
ALTER TABLE pr_products DROP COLUMN IF EXISTS image_url;
