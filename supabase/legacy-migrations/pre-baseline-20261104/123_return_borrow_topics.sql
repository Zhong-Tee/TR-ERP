-- Create wms_return_topics table
CREATE TABLE IF NOT EXISTS wms_return_topics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  topic_name TEXT UNIQUE NOT NULL,
  category_4m TEXT DEFAULT 'Man' CHECK (category_4m IN ('Man', 'Machine', 'Material', 'Method')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wms_return_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "WMS return topics read"
  ON wms_return_topics FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','store','production','manager','production_mb')
    )
  );

CREATE POLICY "WMS return topics write"
  ON wms_return_topics FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','store')
    )
  );

-- Create wms_borrow_topics table
CREATE TABLE IF NOT EXISTS wms_borrow_topics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  topic_name TEXT UNIQUE NOT NULL,
  category_4m TEXT DEFAULT 'Man' CHECK (category_4m IN ('Man', 'Machine', 'Material', 'Method')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wms_borrow_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "WMS borrow topics read"
  ON wms_borrow_topics FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','store','production','manager','production_mb')
    )
  );

CREATE POLICY "WMS borrow topics write"
  ON wms_borrow_topics FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin','admin','store')
    )
  );
