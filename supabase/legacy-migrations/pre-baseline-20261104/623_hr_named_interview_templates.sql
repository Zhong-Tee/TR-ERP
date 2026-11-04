BEGIN;
CREATE TABLE public.hr_interview_template_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
  criteria JSONB NOT NULL CHECK (jsonb_typeof(criteria) = 'array' AND jsonb_array_length(criteria) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE public.hr_interview_template_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), template_id UUID NOT NULL REFERENCES public.hr_interview_template_sets(id),
  position_id UUID REFERENCES public.hr_positions(id) ON DELETE CASCADE,
  department_id UUID REFERENCES public.hr_departments(id) ON DELETE CASCADE,
  CHECK ((position_id IS NOT NULL)::INT + (department_id IS NOT NULL)::INT = 1),
  UNIQUE(position_id), UNIQUE(department_id)
);
ALTER TABLE public.hr_interview_template_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_interview_template_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY template_sets_read ON public.hr_interview_template_sets FOR SELECT TO authenticated USING (true);
CREATE POLICY template_sets_write ON public.hr_interview_template_sets FOR ALL TO authenticated USING (public.hr_is_admin()) WITH CHECK (public.hr_is_admin());
CREATE POLICY template_assignments_read ON public.hr_interview_template_assignments FOR SELECT TO authenticated USING (true);
CREATE POLICY template_assignments_write ON public.hr_interview_template_assignments FOR ALL TO authenticated USING (public.hr_is_admin()) WITH CHECK (public.hr_is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_interview_template_sets, public.hr_interview_template_assignments TO authenticated;

-- Ten criteria per standard set, each weighted 10 points. Evaluate job evidence,
-- work samples and situational answers, rather than personal characteristics.
INSERT INTO public.hr_interview_template_sets(name, criteria)
SELECT name, (SELECT jsonb_agg(jsonb_build_object('name', topic, 'max_score', 10) ORDER BY seq)
  FROM unnest(string_to_array('ความเข้าใจหน้าที่และผลงานที่ต้องส่งมอบ|ตัวอย่างความรับผิดชอบและการทำงานให้เสร็จตามกำหนด|การสื่อสารและทำงานร่วมกับผู้อื่น|การแก้ปัญหาจากสถานการณ์งานจริง|การเรียนรู้จากข้อผิดพลาดและรับคำแนะนำ|' || topics, '|')) WITH ORDINALITY AS items(topic, seq))
FROM (VALUES
 ('มาตรฐาน — พนักงานปฏิบัติการ', 'การทำตามขั้นตอนและคำสั่งงาน|ความละเอียดและตรวจสอบคุณภาพ|ความรู้ความปลอดภัยในการทำงาน|การจัดลำดับงานและบริหารเวลา|ทักษะพื้นฐานจากแบบทดสอบที่เกี่ยวกับงาน'),
 ('มาตรฐาน — เจ้าหน้าที่', 'ความรู้เฉพาะหน้าที่จากตัวอย่างงาน|ความถูกต้องของเอกสารและข้อมูล|การใช้เครื่องมือหรือระบบที่เกี่ยวข้อง|การประสานงานและติดตามผล|การวางแผนงานด้วยตนเอง'),
 ('มาตรฐาน — ผู้เชี่ยวชาญ / อาวุโส', 'ความลึกของความรู้เฉพาะทาง|การวิเคราะห์ปัญหาซับซ้อน|การออกแบบวิธีทำงานและมาตรฐาน|การสอนงานและถ่ายทอดความรู้|ผลลัพธ์การปรับปรุงงานที่วัดได้'),
 ('มาตรฐาน — หัวหน้างาน', 'การวางแผนกำลังคนและจัดสรรงาน|การควบคุมคุณภาพและติดตามเป้าหมาย|การสอนงานและให้ข้อเสนอแนะ|การจัดการความขัดแย้งในทีม|การตัดสินใจและรับผิดชอบผลลัพธ์'),
 ('มาตรฐาน — ผู้จัดการ', 'การแปลงเป้าหมายเป็นแผนและตัวชี้วัด|การบริหารงบประมาณและทรัพยากร|การพัฒนาทีมและผู้สืบทอด|การบริหารความเสี่ยงและการควบคุมภายใน|การประสานงานระหว่างหน่วยงาน'),
 ('มาตรฐาน — ผู้บริหาร', 'วิสัยทัศน์และการวางกลยุทธ์ธุรกิจ|การวิเคราะห์การเงินและตัดสินใจลงทุน|การบริหารการเปลี่ยนแปลงองค์กร|ธรรมาภิบาลและการจัดการความเสี่ยง|การสร้างทีมผู้นำและติดตามผลระดับองค์กร'),
 ('มาตรฐาน — คลังสินค้า / จัดส่ง', 'การรับเข้าและตรวจนับสินค้า|การหยิบแพ็กและตรวจสอบคำสั่งซื้อ|ความเข้าใจสต๊อกและการตรวจสอบยอด|การใช้ระบบคลังและเอกสารขนส่ง|ความปลอดภัยและการดูแลสินค้า'),
 ('มาตรฐาน — ผลิต / ควบคุมคุณภาพ', 'ความเข้าใจกระบวนการผลิต|การใช้เครื่องมือและตรวจงานตัวอย่าง|การตรวจพบข้อบกพร่องและป้องกันงานเสีย|การรักษามาตรฐานคุณภาพและความปลอดภัย|การปรับปรุงประสิทธิภาพและลดของเสีย'),
 ('มาตรฐาน — ออกแบบ / สร้างสรรค์', 'คุณภาพ Portfolio และบทบาทในผลงาน|การตีความโจทย์และข้อจำกัด|ทักษะเครื่องมือจากงานทดลอง|การเตรียมไฟล์และตรวจความพร้อมผลิต|การรับข้อเสนอแนะและแก้งานตามกำหนด'),
 ('มาตรฐาน — ขาย / บริการลูกค้า', 'การค้นหาความต้องการและให้ข้อมูลสินค้า|การเสนอขายและเจรจาต่อรอง|การรับข้อร้องเรียนอย่างเหมาะสม|การติดตามลูกค้าและบันทึกข้อมูล|ผลงานขายหรือบริการที่ตรวจสอบได้'),
 ('มาตรฐาน — บัญชี / การเงิน', 'ความเข้าใจเอกสารและรายการบัญชี|การตรวจสอบและกระทบยอด|การวิเคราะห์ตัวเลขและค้นหาความผิดปกติ|การใช้ระบบบัญชีและตารางคำนวณ|การรักษาความลับและการควบคุมภายใน'),
 ('มาตรฐาน — HR / ธุรการ', 'ความถูกต้องของเอกสารและข้อมูลบุคลากร|การประสานงานและบริการภายใน|การใช้ระบบและจัดการเอกสาร|การจัดการข้อมูลส่วนบุคคลตามหน้าที่|การแก้สถานการณ์งานบุคคลหรือธุรการ'),
 ('มาตรฐาน — IT / พัฒนาระบบ', 'ความรู้ระบบหรือเทคโนโลยีที่ใช้ในงาน|การวิเคราะห์และแก้ปัญหาจากโจทย์จริง|การทดสอบและดูแลคุณภาพระบบ|ความปลอดภัยและการจัดการสิทธิ์ข้อมูล|การอธิบายงานเทคนิคและจัดทำเอกสาร'),
 ('มาตรฐาน — จัดซื้อ', 'การเปรียบเทียบราคาและต้นทุนรวม|การประเมินและติดตามผู้ขาย|การเจรจาและเงื่อนไขจัดซื้อ|ความถูกต้องของเอกสารและการอนุมัติ|การวางแผนจัดหาและจัดการความเสี่ยง')
) AS presets(name, topics);

-- Preserve existing custom position criteria as named sets before adding defaults.
INSERT INTO public.hr_interview_template_sets(name, criteria)
SELECT 'เกณฑ์เดิม — ' || p.name || ' [' || p.id || ']', jsonb_agg(jsonb_build_object('name', c.name, 'max_score', c.max_score) ORDER BY c.sort_order, c.id)
FROM public.hr_positions p JOIN public.hr_interview_criteria_templates c ON c.position_id = p.id AND c.is_active
GROUP BY p.id, p.name;
INSERT INTO public.hr_interview_template_assignments(template_id, position_id)
SELECT t.id, p.id FROM public.hr_positions p JOIN public.hr_interview_template_sets t ON t.name = 'เกณฑ์เดิม — ' || p.name || ' [' || p.id || ']';

-- Generate a separate editable template for every actual position in this database.
INSERT INTO public.hr_interview_template_sets(name, criteria)
SELECT 'ตำแหน่ง — ' || p.name || ' [' || p.id || ']', t.criteria
FROM public.hr_positions p JOIN public.hr_interview_template_sets t ON t.name = CASE
 WHEN p.name ~* '(director|chief|ceo|executive|ผู้อำนวยการ|ผู้บริหาร)' THEN 'มาตรฐาน — ผู้บริหาร'
 WHEN p.name ~* '(manager|ผู้จัดการ)' THEN 'มาตรฐาน — ผู้จัดการ'
 WHEN p.name ~* '(supervisor|หัวหน้า|team lead)' THEN 'มาตรฐาน — หัวหน้างาน'
 WHEN p.name ~* '(design|graphic|creative|ออกแบบ|กราฟิก)' THEN 'มาตรฐาน — ออกแบบ / สร้างสรรค์'
 WHEN p.name ~* '(warehouse|logistic|packing|delivery|คลัง|จัดส่ง|แพ็ก|ขนส่ง)' THEN 'มาตรฐาน — คลังสินค้า / จัดส่ง'
 WHEN p.name ~* '(production|quality|qc|ผลิต|คุณภาพ)' THEN 'มาตรฐาน — ผลิต / ควบคุมคุณภาพ'
 WHEN p.name ~* '(account|financ|บัญชี|การเงิน)' THEN 'มาตรฐาน — บัญชี / การเงิน'
 WHEN p.name ~* '(sales|service|ขาย|บริการ|ลูกค้า)' THEN 'มาตรฐาน — ขาย / บริการลูกค้า'
 WHEN p.name ~* '(developer|programmer|software|system|\mIT\M|พัฒนาระบบ|ไอที)' THEN 'มาตรฐาน — IT / พัฒนาระบบ'
 WHEN p.name ~* '(purchase|procurement|จัดซื้อ)' THEN 'มาตรฐาน — จัดซื้อ'
 WHEN p.name ~* '(\mHR\M|human|admin|บุคคล|ธุรการ)' THEN 'มาตรฐาน — HR / ธุรการ'
 WHEN p.name ~* '(senior|specialist|อาวุโส|ผู้เชี่ยวชาญ)' THEN 'มาตรฐาน — ผู้เชี่ยวชาญ / อาวุโส'
 WHEN p.name ~* '(operator|worker|พนักงานทั่วไป|ปฏิบัติการ)' THEN 'มาตรฐาน — พนักงานปฏิบัติการ'
 ELSE 'มาตรฐาน — เจ้าหน้าที่' END;
INSERT INTO public.hr_interview_template_assignments(template_id, position_id)
SELECT t.id, p.id FROM public.hr_positions p JOIN public.hr_interview_template_sets t ON t.name = 'ตำแหน่ง — ' || p.name || ' [' || p.id || ']'
ON CONFLICT(position_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.hr_assign_interview_template(p_template_id UUID, p_position_id UUID, p_department_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF (p_position_id IS NOT NULL)::INT + (p_department_id IS NOT NULL)::INT <> 1 THEN RAISE EXCEPTION 'เลือกแผนกหรือตำแหน่ง'; END IF;
  IF p_position_id IS NOT NULL THEN
    INSERT INTO public.hr_interview_template_assignments(template_id, position_id) VALUES(p_template_id, p_position_id)
    ON CONFLICT(position_id) DO UPDATE SET template_id = excluded.template_id;
  ELSE
    INSERT INTO public.hr_interview_template_assignments(template_id, department_id) VALUES(p_template_id, p_department_id)
    ON CONFLICT(department_id) DO UPDATE SET template_id = excluded.template_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.hr_assign_interview_template(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_assign_interview_template(UUID,UUID,UUID) TO authenticated;
COMMIT;
