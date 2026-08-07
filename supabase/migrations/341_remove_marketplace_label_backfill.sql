-- One-time Marketplace label backfill has completed; remove the temporary RPC.
BEGIN;

DROP FUNCTION IF EXISTS rpc_backfill_mp_shipping_labels(UUID);

COMMIT;
