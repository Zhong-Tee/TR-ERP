-- Allow WMS roles to read usernames for GR detail (received_by display)
BEGIN;

DROP POLICY IF EXISTS "Admins can view all users" ON us_users;

CREATE POLICY "Admins can view all users"
  ON us_users FOR SELECT
  TO authenticated
  USING (
    auth.uid() = id OR
    check_user_role(
      auth.uid(),
      ARRAY['superadmin', 'admin', 'sales-tr', 'manager', 'picker', 'auditor', 'store', 'account']
    )
  );

COMMIT;
