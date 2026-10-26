# Work-order creation timeout follow-up

## Evidence and scope

- The two lookup indexes added in migration 667 are valid and actively used in the reported database.
- The supplied activity snapshot has repeated Plan read requests, no blocking PIDs, and no running work-order creation RPC. It cannot identify the failed statement or exclude a lock at another instant.
- Reported reproduction: SP3 with 37 bills fails; FSPTR2 with 23 bills succeeds. These are different inputs, so channel alone is not established as the cause.
- In the local SQL, the bulk order-link UPDATE fires `trg_or_orders_try_auto_non_pick` for every bill. AFTER ROW triggers can see all links from that statement, so every invocation scans the complete work order. The RPC then scans it again.

## Change and deployment

1. Apply `supabase/migrations/672_defer_work_order_auto_wms_until_linked.sql` in the intended Supabase database. A frontend deployment alone does not install PostgreSQL functions.
2. Deploy the frontend change in `WorkOrderSelectionList.tsx` to include the failing stage, bill count and allocated work-order name in its application Modal. Quantity and plan-index read errors now stop creation instead of being silently ignored.
3. Test comparable 23- and 37-bill jobs, including automatic and warehouse-picked products. Check the work-order links, plan and WMS results.

Migration 672 suppresses only the automatic-WMS order-link trigger for the UUID currently being created by the atomic RPC. It restores the transaction-local flag immediately after linking and retains the existing final WMS call. Other attachment paths, permissions and validation triggers remain enabled. The existing stock deduction, reservation and FIFO functions are not replaced.

The migration does not repair or rewrite historical orders or stock. It has been prepared locally; live application and production timing must be verified separately.

## Validation

Run `node scripts/tests/work-order-auto-wms-deferral.mjs` with the existing `.reservation-test-runtime` installed.

The isolated PostgreSQL fixture reproduces full-work-order WMS calls of 24, 38 and 51 for batches of 23, 37 and 50 bills. After the patch each batch makes one full pass, excluding the early header call that returns before bills are linked. Mixed automatic/Picker products are also covered.

The fixture uses the existing WMS, reservation and stock-deduction functions and compares before/after stock balances, reservations, movements and WMS rows. FIFO/cost helpers are recorded stubs: matching helper inputs are verified, not the internal FIFO algorithm. Direct attachment, duplicate-creation rejection, failure rollback and role checks are covered. `npx tsc -b` also passes.

## If a timeout recurs

Capture the new Modal's stage and bill count, the time in Asia/Bangkok, and the PostgreSQL error log with CONTEXT. Capture activity during the request, before cancellation. Existing cumulative RPC statistics include older requests and do not count all failed executions; their historic maximum is not proof of post-fix latency.
