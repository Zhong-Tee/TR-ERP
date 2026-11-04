-- Add error_fields (JSONB) to or_order_reviews for marking which fields are incorrect
ALTER TABLE or_order_reviews
ADD COLUMN IF NOT EXISTS error_fields JSONB DEFAULT NULL;

COMMENT ON COLUMN or_order_reviews.error_fields IS 'Object with keys: customer_name, address, product_name, ink_color, layer, line_art, font, line_1, line_2, line_3 (true = incorrect)';
