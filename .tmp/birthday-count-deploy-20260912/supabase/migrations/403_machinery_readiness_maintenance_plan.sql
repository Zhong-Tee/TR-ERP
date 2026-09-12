-- Machinery readiness, maintenance tickets, checklist and Plan line mapping.
BEGIN;

ALTER TABLE public.pr_machinery_machines
  ADD COLUMN IF NOT EXISTS department_name text,
  ADD COLUMN IF NOT EXISTS line_index integer CHECK (line_index IS NULL OR line_index >= 0),
  ADD COLUMN IF NOT EXISTS is_primary_machine boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_substitute boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_pr_machinery_machine_plan_line
  ON public.pr_machinery_machines(department_name, line_index);

CREATE TABLE IF NOT EXISTS public.pr_machinery_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id uuid NOT NULL REFERENCES public.pr_machinery_machines(id) ON DELETE CASCADE,
  label text NOT NULL,
  description text,
  input_type text NOT NULL DEFAULT 'boolean' CHECK (input_type IN ('boolean','number','text')),
  min_value numeric,
  max_value numeric,
  unit text,
  requires_photo boolean NOT NULL DEFAULT false,
  is_required boolean NOT NULL DEFAULT true,
  frequency text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily','shift','job')),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pr_machinery_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id uuid NOT NULL REFERENCES public.pr_machinery_machines(id) ON DELETE CASCADE,
  inspection_date date NOT NULL DEFAULT CURRENT_DATE,
  shift_key text NOT NULL DEFAULT 'day',
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','passed','failed')),
  note text,
  inspected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  inspected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(machine_id, inspection_date, shift_key)
);

CREATE TABLE IF NOT EXISTS public.pr_machinery_inspection_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES public.pr_machinery_inspections(id) ON DELETE CASCADE,
  checklist_item_id uuid NOT NULL REFERENCES public.pr_machinery_checklist_items(id) ON DELETE RESTRICT,
  passed boolean,
  value_text text,
  value_number numeric,
  photo_url text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(inspection_id, checklist_item_id)
);

CREATE TABLE IF NOT EXISTS public.pr_machinery_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no text UNIQUE,
  machine_id uuid NOT NULL REFERENCES public.pr_machinery_machines(id) ON DELETE RESTRICT,
  title text NOT NULL,
  symptom text,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  status text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','accepted','repairing','testing','ready','closed','cancelled')),
  plan_job_id text REFERENCES public.plan_jobs(id) ON DELETE SET NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  repair_started_at timestamptz,
  repair_completed_at timestamptz,
  ready_at timestamptz,
  closed_at timestamptz,
  expected_ready_at timestamptz,
  root_cause text,
  resolution text,
  note text,
  reported_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pr_machinery_checklist_machine ON public.pr_machinery_checklist_items(machine_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_pr_machinery_inspection_machine_date ON public.pr_machinery_inspections(machine_id, inspection_date);
CREATE INDEX IF NOT EXISTS idx_pr_machinery_incident_machine_time ON public.pr_machinery_incidents(machine_id, reported_at);
CREATE INDEX IF NOT EXISTS idx_pr_machinery_incident_open ON public.pr_machinery_incidents(status) WHERE status NOT IN ('closed','cancelled');

CREATE OR REPLACE FUNCTION public.pr_machinery_assign_ticket_no()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ticket_no IS NULL OR btrim(NEW.ticket_no) = '' THEN
    NEW.ticket_no := 'MT-' || to_char(COALESCE(NEW.reported_at, now()) AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD-HH24MISS')
      || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pr_machinery_incident_ticket_no ON public.pr_machinery_incidents;
CREATE TRIGGER trg_pr_machinery_incident_ticket_no
  BEFORE INSERT ON public.pr_machinery_incidents
  FOR EACH ROW EXECUTE FUNCTION public.pr_machinery_assign_ticket_no();

CREATE OR REPLACE FUNCTION public.pr_machinery_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pr_machinery_checklist_items','pr_machinery_inspections','pr_machinery_inspection_results','pr_machinery_incidents'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_' || t || '_updated', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.pr_machinery_set_updated_at()', 'trg_' || t || '_updated', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (check_user_role(auth.uid(), ARRAY[''superadmin'',''admin'',''production'',''production_mb'',''manager'',''technician'']))', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (check_user_role(auth.uid(), ARRAY[''superadmin'',''admin'',''production'',''production_mb'',''manager'',''technician''])) WITH CHECK (check_user_role(auth.uid(), ARRAY[''superadmin'',''admin'',''production'',''production_mb'',''manager'',''technician'']))', t || '_write', t);
  END LOOP;
END $$;

DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pr_machinery_checklist_items','pr_machinery_inspections','pr_machinery_incidents'] LOOP
    BEGIN EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t); EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;

COMMIT;
