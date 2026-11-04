-- รีโหลด PostgREST schema cache หลังจาก migration 081 เปลี่ยน product_category → product_categories
-- แก้ error: "Could not find the 'product_categories' column of 'cp_cartoon_patterns' in the schema cache"
NOTIFY pgrst, 'reload schema';
