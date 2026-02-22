-- =============================================================================
-- HR Module: Warning Letters (ใบเตือน) + Training Certificates (ใบรับรอง)
-- =============================================================================

-- ─── Sequence for auto-numbering ────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS hr_warning_number_seq START WITH 1;
CREATE SEQUENCE IF NOT EXISTS hr_certificate_number_seq START WITH 1;

-- ─── hr_warnings ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_warnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warning_number TEXT NOT NULL UNIQUE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  warning_level TEXT NOT NULL DEFAULT 'verbal'
    CHECK (warning_level IN ('verbal','written_1','written_2','final')),
  subject TEXT NOT NULL,
  description TEXT,
  incident_date DATE NOT NULL,
  issued_date DATE NOT NULL DEFAULT CURRENT_DATE,
  issued_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  witness_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  employee_response TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','issued','acknowledged','appealed','resolved')),
  resolution_note TEXT,
  resolved_at TIMESTAMPTZ,
  attachment_urls JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_warnings_employee ON hr_warnings(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_warnings_status ON hr_warnings(status);
CREATE INDEX IF NOT EXISTS idx_hr_warnings_level ON hr_warnings(warning_level);

-- ─── hr_certificates ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_number TEXT NOT NULL UNIQUE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  training_name TEXT NOT NULL,
  training_type TEXT NOT NULL DEFAULT 'internal'
    CHECK (training_type IN ('internal','external')),
  description TEXT,
  trainer TEXT,
  training_start_date DATE NOT NULL,
  training_end_date DATE,
  training_hours NUMERIC(6,1),
  score NUMERIC(5,2),
  pass_status TEXT NOT NULL DEFAULT 'passed'
    CHECK (pass_status IN ('passed','failed','pending')),
  certificate_date DATE DEFAULT CURRENT_DATE,
  expiry_date DATE,
  issued_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','issued')),
  attachment_urls JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_certificates_employee ON hr_certificates(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_certificates_status ON hr_certificates(status);
CREATE INDEX IF NOT EXISTS idx_hr_certificates_expiry ON hr_certificates(expiry_date);

-- ─── Auto-generate warning_number on insert ─────────────────────────────────
CREATE OR REPLACE FUNCTION fn_hr_warning_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.warning_number IS NULL OR NEW.warning_number = '' THEN
    NEW.warning_number := 'WRN-' || TO_CHAR(NOW(), 'YYYY') || '-' ||
                          LPAD(nextval('hr_warning_number_seq')::TEXT, 5, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_warning_number ON hr_warnings;
CREATE TRIGGER trg_hr_warning_number
  BEFORE INSERT ON hr_warnings
  FOR EACH ROW EXECUTE FUNCTION fn_hr_warning_number();

-- ─── Auto-generate certificate_number on insert ─────────────────────────────
CREATE OR REPLACE FUNCTION fn_hr_certificate_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.certificate_number IS NULL OR NEW.certificate_number = '' THEN
    NEW.certificate_number := 'CRT-' || TO_CHAR(NOW(), 'YYYY') || '-' ||
                              LPAD(nextval('hr_certificate_number_seq')::TEXT, 5, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_certificate_number ON hr_certificates;
CREATE TRIGGER trg_hr_certificate_number
  BEFORE INSERT ON hr_certificates
  FOR EACH ROW EXECUTE FUNCTION fn_hr_certificate_number();

-- ─── RLS Policies ───────────────────────────────────────────────────────────
ALTER TABLE hr_warnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_certificates ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'hr_warnings_all' AND tablename = 'hr_warnings') THEN
    CREATE POLICY hr_warnings_all ON hr_warnings FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'hr_certificates_all' AND tablename = 'hr_certificates') THEN
    CREATE POLICY hr_certificates_all ON hr_certificates FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── updated_at trigger ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_hr_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_warnings_updated ON hr_warnings;
CREATE TRIGGER trg_hr_warnings_updated
  BEFORE UPDATE ON hr_warnings
  FOR EACH ROW EXECUTE FUNCTION fn_hr_set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_certificates_updated ON hr_certificates;
CREATE TRIGGER trg_hr_certificates_updated
  BEFORE UPDATE ON hr_certificates
  FOR EACH ROW EXECUTE FUNCTION fn_hr_set_updated_at();
