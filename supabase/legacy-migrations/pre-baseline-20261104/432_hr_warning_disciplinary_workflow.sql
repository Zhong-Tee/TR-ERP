-- Disciplinary-case workflow. Existing warning records remain readable and keep
-- their original document numbers/legacy levels.

CREATE SEQUENCE IF NOT EXISTS hr_warning_case_seq START 1;

CREATE TABLE IF NOT EXISTS hr_warning_offense_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  lookback_days INT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO hr_warning_offense_types(code,name,lookback_days) VALUES
  ('late','มาสาย',365), ('absence','ขาดงาน',365), ('invalid_leave','ลางานไม่ถูกต้อง',365),
  ('insubordination','ไม่ปฏิบัติตามคำสั่ง',730), ('policy_violation','ฝ่าฝืนระเบียบบริษัท',730),
  ('performance','การปฏิบัติงาน',365), ('behavior','พฤติกรรม',730), ('other','อื่น ๆ',365)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS hr_warning_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT,
  title TEXT NOT NULL,
  description TEXT,
  source_document_id UUID REFERENCES hr_documents(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO hr_warning_policies(code,title,source_document_id)
SELECT 'DOC-' || left(id::text,8), title, id FROM hr_documents
WHERE is_active=true
ON CONFLICT DO NOTHING;

ALTER TABLE hr_warnings DROP CONSTRAINT IF EXISTS hr_warnings_warning_level_check;
ALTER TABLE hr_warnings ADD CONSTRAINT hr_warnings_warning_level_check
  CHECK (warning_level IN ('verbal','verbal_2','written_1','written_2','final','termination_review'));
ALTER TABLE hr_warnings DROP CONSTRAINT IF EXISTS hr_warnings_status_check;
ALTER TABLE hr_warnings ADD CONSTRAINT hr_warnings_status_check CHECK (status IN (
  'draft','pending_review','changes_requested','pending_approval','approved',
  'pending_acknowledgement','acknowledged','acknowledgement_refused',
  'termination_review','closed','cancelled','issued','appealed','resolved'
));
ALTER TABLE hr_warnings ALTER COLUMN warning_number DROP NOT NULL;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS case_number TEXT UNIQUE;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS offense_type_id UUID REFERENCES hr_warning_offense_types(id) ON DELETE RESTRICT;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS corrective_action TEXT;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS recommended_level TEXT;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS level_override_reason TEXT;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS recommendation_basis JSONB NOT NULL DEFAULT '[]';
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS reviewer_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS approver_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS effective_until DATE;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS created_by_user UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE hr_warnings ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

UPDATE hr_warnings SET case_number = 'CASE-LEGACY-' || warning_number WHERE case_number IS NULL;
UPDATE hr_warnings SET status = 'pending_acknowledgement' WHERE status = 'issued';
UPDATE hr_warnings SET status = 'closed', closed_at = COALESCE(resolved_at, updated_at) WHERE status = 'resolved';

CREATE OR REPLACE FUNCTION fn_hr_warning_number() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.case_number IS NULL OR NEW.case_number = '' THEN
    NEW.case_number := 'DISC-' || to_char(now(),'YYYY') || '-' || lpad(nextval('hr_warning_case_seq')::text,5,'0');
  END IF;
  RETURN NEW;
END; $$;

CREATE TABLE IF NOT EXISTS hr_warning_policy_links (
  warning_id UUID NOT NULL REFERENCES hr_warnings(id) ON DELETE CASCADE,
  policy_id UUID NOT NULL REFERENCES hr_warning_policies(id) ON DELETE RESTRICT,
  PRIMARY KEY(warning_id,policy_id)
);
CREATE TABLE IF NOT EXISTS hr_warning_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), warning_id UUID NOT NULL REFERENCES hr_warnings(id) ON DELETE CASCADE,
  step TEXT NOT NULL CHECK(step IN ('review','approval')), actor_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK(action IN ('submitted','approved','returned','cancelled')), note TEXT, acted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_warning_employee_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), warning_id UUID NOT NULL REFERENCES hr_warnings(id) ON DELETE CASCADE,
  response_text TEXT NOT NULL, recorded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  attachment_urls JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_warning_acknowledgements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), warning_id UUID NOT NULL REFERENCES hr_warnings(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK(outcome IN ('acknowledged','refused')), method TEXT NOT NULL DEFAULT 'employee_portal',
  handled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL, witness_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  note TEXT, acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_warning_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), warning_id UUID NOT NULL REFERENCES hr_warnings(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK(outcome IN ('terminated','continued_employment','other_discipline','cancelled','other')),
  reason TEXT, conditions TEXT, approved_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  effective_date DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hr_warning_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, warning_id UUID NOT NULL REFERENCES hr_warnings(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL, actor_employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL, action TEXT NOT NULL,
  old_data JSONB, new_data JSONB, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_warning_offense_history ON hr_warnings(employee_id,offense_type_id,incident_date DESC);
CREATE INDEX IF NOT EXISTS idx_hr_warning_audit ON hr_warning_audit_logs(warning_id,created_at DESC);

-- Warning workflow roles requested by the business. Employees retain read-only
-- access to their own approved/pending-acknowledgement records.
DROP POLICY IF EXISTS hr_warnings_select ON hr_warnings;
DROP POLICY IF EXISTS hr_warnings_insert ON hr_warnings;
DROP POLICY IF EXISTS hr_warnings_update ON hr_warnings;
DROP POLICY IF EXISTS hr_warnings_delete ON hr_warnings;
CREATE POLICY hr_warnings_select ON hr_warnings FOR SELECT TO authenticated USING (
  check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']) OR
  (employee_id=hr_my_employee_id() AND status IN ('pending_acknowledgement','acknowledged','acknowledgement_refused','closed','issued','appealed','resolved'))
);
CREATE POLICY hr_warnings_insert ON hr_warnings FOR INSERT TO authenticated WITH CHECK (
  check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr'])
);
CREATE POLICY hr_warnings_update ON hr_warnings FOR UPDATE TO authenticated USING (
  check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr'])
) WITH CHECK (check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']));
CREATE POLICY hr_warnings_delete ON hr_warnings FOR DELETE TO authenticated USING (
  check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']) AND status='draft'
);

CREATE OR REPLACE FUNCTION hr_warning_recommend_level(p_employee UUID,p_offense UUID)
RETURNS TABLE(recommended_level TEXT,basis JSONB) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  WITH cfg AS (SELECT COALESCE(lookback_days,365) days FROM hr_warning_offense_types WHERE id=p_offense),
  history AS (
    SELECT id,warning_number,case_number,warning_level,incident_date
    FROM hr_warnings,cfg WHERE employee_id=p_employee AND offense_type_id=p_offense
      AND status IN ('approved','pending_acknowledgement','acknowledged','acknowledgement_refused','termination_review','closed')
      AND incident_date >= CURRENT_DATE-cfg.days
  ), rank AS (
    SELECT COALESCE(max(CASE warning_level WHEN 'termination_review' THEN 4 WHEN 'final' THEN 3
      WHEN 'written_2' THEN 3 WHEN 'written_1' THEN 2 WHEN 'verbal_2' THEN 2 WHEN 'verbal' THEN 1 ELSE 0 END),0) r FROM history
  )
  SELECT CASE r WHEN 0 THEN 'verbal' WHEN 1 THEN 'written_1' WHEN 2 THEN 'final' ELSE 'termination_review' END,
    COALESCE((SELECT jsonb_agg(to_jsonb(history) ORDER BY incident_date DESC) FROM history),'[]'::jsonb) FROM rank;
$$;

CREATE OR REPLACE FUNCTION hr_warning_authorized_employees()
RETURNS TABLE(id UUID,employee_code TEXT,first_name TEXT,last_name TEXT,nickname TEXT,user_id UUID)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT e.id,e.employee_code,e.first_name,e.last_name,e.nickname,e.user_id
  FROM hr_employees e JOIN us_users u ON u.id=e.user_id
  WHERE u.role IN ('superadmin','admin','account','hr') AND u.is_active=true AND e.employment_status='active'
    AND check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr'])
  ORDER BY e.employee_code;
$$;

CREATE OR REPLACE FUNCTION hr_warning_validate_case() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.recommended_level IS NOT NULL AND NEW.warning_level IS DISTINCT FROM NEW.recommended_level
     AND NULLIF(btrim(COALESCE(NEW.level_override_reason,'')),'') IS NULL THEN
    RAISE EXCEPTION 'กรุณาระบุเหตุผลในการเปลี่ยนระดับการเตือน';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_hr_warning_validate_case ON hr_warnings;
CREATE TRIGGER trg_hr_warning_validate_case BEFORE INSERT OR UPDATE OF warning_level,recommended_level,level_override_reason ON hr_warnings FOR EACH ROW EXECUTE FUNCTION hr_warning_validate_case();

CREATE OR REPLACE FUNCTION hr_warning_workflow(p_warning UUID,p_action TEXT,p_note TEXT DEFAULT NULL)
RETURNS hr_warnings LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE w hr_warnings; emp UUID;
BEGIN
  IF NOT check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการใบเตือน'; END IF;
  SELECT * INTO w FROM hr_warnings WHERE id=p_warning FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบเคสใบเตือน'; END IF;
  SELECT id INTO emp FROM hr_employees WHERE user_id=auth.uid();
  IF p_action='submit_review' AND w.status IN ('draft','changes_requested') THEN
    IF w.offense_type_id IS NULL OR NULLIF(btrim(COALESCE(w.corrective_action,'')),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุประเภทความผิดและสิ่งที่ต้องปรับปรุง'; END IF;
    UPDATE hr_warnings SET status='pending_review' WHERE id=p_warning;
    INSERT INTO hr_warning_approvals(warning_id,step,actor_id,action,note) VALUES(p_warning,'review',emp,'submitted',p_note);
  ELSIF p_action='send_approval' AND w.status='pending_review' THEN
    UPDATE hr_warnings SET status='pending_approval',reviewer_id=emp,reviewed_at=now() WHERE id=p_warning;
    INSERT INTO hr_warning_approvals(warning_id,step,actor_id,action,note) VALUES(p_warning,'review',emp,'approved',p_note);
  ELSIF p_action='return' AND w.status IN ('pending_review','pending_approval') THEN
    UPDATE hr_warnings SET status='changes_requested' WHERE id=p_warning;
    INSERT INTO hr_warning_approvals(warning_id,step,actor_id,action,note) VALUES(p_warning,CASE WHEN w.status='pending_review' THEN 'review' ELSE 'approval' END,emp,'returned',p_note);
  ELSIF p_action='approve' AND w.status='pending_approval' THEN
    IF w.approver_id IS NOT NULL AND w.approver_id IS DISTINCT FROM emp THEN RAISE EXCEPTION 'เฉพาะผู้อนุมัติที่ระบุในเคสเท่านั้นที่อนุมัติได้'; END IF;
    UPDATE hr_warnings SET status=CASE WHEN warning_level='termination_review' THEN 'termination_review' ELSE 'pending_acknowledgement' END,
      approver_id=emp,approved_at=now(),issued_date=CURRENT_DATE,
      warning_number=COALESCE(warning_number,'WRN-'||to_char(now(),'YYYY')||'-'||lpad(nextval('hr_warning_number_seq')::text,5,'0')) WHERE id=p_warning;
    INSERT INTO hr_warning_approvals(warning_id,step,actor_id,action,note) VALUES(p_warning,'approval',emp,'approved',p_note);
  ELSIF p_action='cancel' AND w.status NOT IN ('closed','cancelled') THEN
    UPDATE hr_warnings SET status='cancelled',cancelled_at=now() WHERE id=p_warning;
  ELSIF p_action='close' AND w.status IN ('acknowledged','acknowledgement_refused','termination_review') THEN
    UPDATE hr_warnings SET status='closed',closed_at=now() WHERE id=p_warning;
  ELSE RAISE EXCEPTION 'ไม่สามารถดำเนินการจากสถานะปัจจุบันได้'; END IF;
  RETURN (SELECT x FROM hr_warnings x WHERE x.id=p_warning);
END; $$;

CREATE OR REPLACE FUNCTION hr_warning_employee_response(p_warning UUID,p_outcome TEXT,p_response TEXT DEFAULT NULL,p_method TEXT DEFAULT 'employee_portal',p_attachments JSONB DEFAULT '[]')
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE emp UUID;
BEGIN
  SELECT id INTO emp FROM hr_employees WHERE user_id=auth.uid();
  IF NOT EXISTS(SELECT 1 FROM hr_warnings WHERE id=p_warning AND employee_id=emp AND status='pending_acknowledgement') THEN RAISE EXCEPTION 'ไม่พบใบเตือนที่รอรับทราบ'; END IF;
  IF p_outcome NOT IN ('acknowledged','refused') THEN RAISE EXCEPTION 'ผลการรับทราบไม่ถูกต้อง'; END IF;
  IF NULLIF(btrim(COALESCE(p_response,'')),'') IS NOT NULL THEN
    INSERT INTO hr_warning_employee_responses(warning_id,response_text,recorded_by,attachment_urls) VALUES(p_warning,p_response,auth.uid(),COALESCE(p_attachments,'[]'));
  END IF;
  INSERT INTO hr_warning_acknowledgements(warning_id,outcome,method,handled_by,note) VALUES(p_warning,p_outcome,p_method,auth.uid(),p_response);
  UPDATE hr_warnings SET status=CASE WHEN p_outcome='acknowledged' THEN 'acknowledged' ELSE 'acknowledgement_refused' END,
    acknowledged_at=now(),employee_response=COALESCE(NULLIF(btrim(COALESCE(p_response,'')),''),employee_response) WHERE id=p_warning;
END; $$;

CREATE OR REPLACE FUNCTION hr_warning_record_acknowledgement(p_warning UUID,p_outcome TEXT,p_method TEXT,p_note TEXT DEFAULT NULL,p_witness UUID DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์บันทึกการรับทราบ'; END IF;
  IF p_outcome NOT IN ('acknowledged','refused') THEN RAISE EXCEPTION 'ผลการรับทราบไม่ถูกต้อง'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hr_warnings WHERE id=p_warning AND status='pending_acknowledgement') THEN RAISE EXCEPTION 'เคสนี้ไม่ได้อยู่ในขั้นตอนรอรับทราบ'; END IF;
  IF p_outcome='refused' AND p_witness IS NULL THEN RAISE EXCEPTION 'กรุณาระบุพยานเมื่อพนักงานปฏิเสธรับทราบ'; END IF;
  INSERT INTO hr_warning_acknowledgements(warning_id,outcome,method,handled_by,witness_id,note) VALUES(p_warning,p_outcome,p_method,auth.uid(),p_witness,p_note);
  UPDATE hr_warnings SET status=CASE WHEN p_outcome='acknowledged' THEN 'acknowledged' ELSE 'acknowledgement_refused' END,acknowledged_at=now(),employee_response=COALESCE(NULLIF(btrim(COALESCE(p_note,'')),''),employee_response) WHERE id=p_warning;
END; $$;

CREATE OR REPLACE FUNCTION acknowledge_my_warning(p_warning_id UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN PERFORM hr_warning_employee_response(p_warning_id,'acknowledged',NULL,'employee_portal','[]'); END; $$;

CREATE OR REPLACE FUNCTION hr_warning_audit_trigger() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO hr_warning_audit_logs(warning_id,actor_user_id,actor_employee_id,action,old_data,new_data,reason)
  VALUES(COALESCE(NEW.id,OLD.id),auth.uid(),hr_my_employee_id(),lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    CASE WHEN TG_OP='UPDATE' AND OLD.warning_level IS DISTINCT FROM NEW.warning_level THEN NEW.level_override_reason ELSE NULL END);
  RETURN COALESCE(NEW,OLD);
END; $$;
DROP TRIGGER IF EXISTS trg_hr_warning_audit ON hr_warnings;
CREATE TRIGGER trg_hr_warning_audit AFTER INSERT OR UPDATE ON hr_warnings FOR EACH ROW EXECUTE FUNCTION hr_warning_audit_trigger();

ALTER TABLE hr_warning_offense_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_warning_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_warning_policy_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_warning_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_warning_employee_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_warning_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_warning_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_warning_audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY warning_offense_read ON hr_warning_offense_types FOR SELECT TO authenticated USING(true);
CREATE POLICY warning_policy_read ON hr_warning_policies FOR SELECT TO authenticated USING(true);
CREATE POLICY warning_admin_offense ON hr_warning_offense_types FOR ALL TO authenticated USING(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr'])) WITH CHECK(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']));
CREATE POLICY warning_admin_policy ON hr_warning_policies FOR ALL TO authenticated USING(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr'])) WITH CHECK(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']));
CREATE POLICY warning_links_read ON hr_warning_policy_links FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM hr_warnings w WHERE w.id=warning_id));
CREATE POLICY warning_links_admin ON hr_warning_policy_links FOR ALL TO authenticated USING(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr'])) WITH CHECK(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']));
CREATE POLICY warning_approval_read ON hr_warning_approvals FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM hr_warnings w WHERE w.id=warning_id));
CREATE POLICY warning_approval_admin ON hr_warning_approvals FOR ALL TO authenticated USING(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr'])) WITH CHECK(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']));
CREATE POLICY warning_response_read ON hr_warning_employee_responses FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM hr_warnings w WHERE w.id=warning_id));
CREATE POLICY warning_ack_read ON hr_warning_acknowledgements FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM hr_warnings w WHERE w.id=warning_id));
CREATE POLICY warning_decision_read ON hr_warning_decisions FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM hr_warnings w WHERE w.id=warning_id));
CREATE POLICY warning_decision_admin ON hr_warning_decisions FOR ALL TO authenticated USING(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr'])) WITH CHECK(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']));
CREATE POLICY warning_audit_read ON hr_warning_audit_logs FOR SELECT TO authenticated USING(check_user_role(auth.uid(),ARRAY['superadmin','admin','account','hr']));
GRANT EXECUTE ON FUNCTION hr_warning_recommend_level(UUID,UUID),hr_warning_authorized_employees(),hr_warning_workflow(UUID,TEXT,TEXT),hr_warning_employee_response(UUID,TEXT,TEXT,TEXT,JSONB),hr_warning_record_acknowledgement(UUID,TEXT,TEXT,TEXT,UUID) TO authenticated;
