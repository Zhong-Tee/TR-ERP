-- Allow one qc_record per (session_id, item_uid) for upsert when saving Pass/Fail in real time.
CREATE UNIQUE INDEX IF NOT EXISTS qc_records_session_item_uid_key
  ON qc_records (session_id, item_uid);
