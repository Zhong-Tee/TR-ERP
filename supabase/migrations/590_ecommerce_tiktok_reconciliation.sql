BEGIN;

INSERT INTO public.ac_ecommerce_channels (
  code,
  display_name,
  is_active,
  default_sheet_name,
  header_rows_to_skip
)
VALUES (
  'tiktok',
  'TikTok Shop',
  true,
  'OrderSKUList',
  1
)
ON CONFLICT (code) DO UPDATE
SET display_name = EXCLUDED.display_name,
    is_active = true,
    default_sheet_name = EXCLUDED.default_sheet_name,
    header_rows_to_skip = EXCLUDED.header_rows_to_skip,
    updated_at = now();

UPDATE public.mp_channel_configs AS marketplace
SET ecommerce_channel_id = ecommerce.id
FROM public.ac_ecommerce_channels AS ecommerce
WHERE ecommerce.code = 'tiktok'
  AND (
    upper(btrim(marketplace.channel_code)) = 'TTTR'
    OR lower(marketplace.name) LIKE '%tiktok%'
    OR marketplace.name LIKE '%ติ๊กต็อก%'
  );

COMMIT;
