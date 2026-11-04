# Historical migration archive

All 722 SQL files are preserved byte-for-byte from the pre-baseline working tree. Duplicate legacy versions had already been split using the mapping in `docs/legacy-migration-version-map-2026-11-04.json`; the SQL contents did not change. The tax-numbering reconciliation is also preserved.

The user confirmed that all historical migrations had previously been run and chose the current production schema as the source of truth. Older definitions may have been superseded or changed later. These files are historical references and isolated-test fixtures, not a production deployment queue.

**Do not run these files against production or copy them back into `supabase/migrations`.** Create a new timestamped migration for any intentional change. Legacy live-deployment scripts are guarded against replay after baseline adoption.

`migration-history-before-baseline.json` preserves the 52 migration-history records present immediately before adoption. Missing older metadata is not retroactively presented as a verified execution log. The actual current schema is captured in `supabase/migrations/20261104140132_production_baseline.sql`, registered as applied without executing its SQL against production.

Run `node scripts/check-production-baseline.mjs` to verify hashes and archive completeness. Add `--remote` for read-only history verification after setting up the temporary PostgreSQL client documented in `scripts/lib/migration-audit-db.mjs`.

This is a schema baseline for a Supabase/PostgreSQL 17 environment. It is not a backup of customer/business data, uploaded files, auth users, sequence current values, scheduled jobs, secrets or other environment configuration. Provisioning a new environment still requires its own configuration and authorized seed/data restore process.
