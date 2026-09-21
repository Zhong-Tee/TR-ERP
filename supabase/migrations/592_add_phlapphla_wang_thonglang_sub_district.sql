-- Add the missing Bangkok address:
-- แขวงพลับพลา เขตวังทองหลาง กรุงเทพมหานคร 10310

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.thai_districts d
    JOIN public.thai_provinces p ON p.id = d.province_id
    WHERE d.id = 1045
      AND d.name_th = 'วังทองหลาง'
      AND p.name_th = 'กรุงเทพมหานคร'
  ) THEN
    RAISE EXCEPTION 'ไม่พบเขตวังทองหลาง (district_id 1045) ในกรุงเทพมหานคร';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.thai_sub_districts
    WHERE id = 104504
      AND NOT (
        name_th = 'พลับพลา'
        AND district_id = 1045
        AND zip_code = '10310'
      )
  ) THEN
    RAISE EXCEPTION 'รหัสแขวง 104504 ถูกใช้โดยข้อมูลอื่นแล้ว กรุณาตรวจสอบก่อนแก้ไข';
  END IF;

  INSERT INTO public.thai_sub_districts (id, zip_code, name_th, district_id)
  SELECT 104504, '10310', 'พลับพลา', 1045
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.thai_sub_districts
    WHERE district_id = 1045
      AND BTRIM(name_th) = 'พลับพลา'
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

COMMIT;
