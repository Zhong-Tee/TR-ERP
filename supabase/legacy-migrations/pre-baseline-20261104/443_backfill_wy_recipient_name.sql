-- WY import mapping:
--   CSV "ชื่อลูกค้า"             -> or_orders.customer_name (ชื่อช่องทางในหน้า Plan)
--   CSV "ชื่อ" + "นามสกุล"      -> or_orders.recipient_name (ชื่อลูกค้าในหน้า Plan)
--
-- Older WY imports did not persist recipient_name. Their combined recipient field
-- is stored in customer_address as "ชื่อผู้รับ, เบอร์โทร, ที่อยู่...".
UPDATE or_orders
SET recipient_name = NULLIF(btrim(split_part(customer_address, ',', 1)), '')
WHERE upper(btrim(channel_code)) = 'WY'
  AND NULLIF(btrim(recipient_name), '') IS NULL
  AND NULLIF(btrim(customer_address), '') IS NOT NULL
  AND position(',' IN customer_address) > 0;
