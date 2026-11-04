-- The order form sorts by font_code, placing M01 immediately before TH01.
INSERT INTO public.fonts (font_code, font_name, is_active)
VALUES ('M01', 'M01', true)
ON CONFLICT (font_code) DO UPDATE
SET font_name = EXCLUDED.font_name,
    is_active = EXCLUDED.is_active;
