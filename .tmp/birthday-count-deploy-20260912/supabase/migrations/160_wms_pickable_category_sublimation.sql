-- เพิ่มหมวด SUBLIMATION ในสินค้าที่ต้องหยิบ (substring เหมือน STAMP/LASER)

CREATE OR REPLACE FUNCTION fn_wms_is_pickable_category(p_cat TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    upper(trim(coalesce(p_cat, ''))) LIKE '%STAMP%'
    OR upper(trim(coalesce(p_cat, ''))) LIKE '%LASER%'
    OR upper(trim(coalesce(p_cat, ''))) LIKE '%SUBLIMATION%'
    OR upper(trim(coalesce(p_cat, ''))) IN ('CALENDAR', 'ETC', 'INK'),
    false
  );
$$;

COMMENT ON FUNCTION fn_wms_is_pickable_category IS
  'STAMP/LASER/SUBLIMATION (substring), CALENDAR/ETC/INK (exact) — ตรงกับ WMS NewOrdersSection';
