# TAX workflow implementation — 4 November 2026

This document records the latest approved chat requirements. They supersede the historical handoff: the customer supplies the withholding certificate; ERP tracks receipt. ERP issues its own sequential tax-invoice number and has a separate manually entered FlowAccount reference. FlowAccount API integration is outside scope.

## Implemented paths

- Orders: TAX immediately after refund return, with rejected-count badge, rejected/pending/approved/issued queues, team/owner visibility and a dedicated tax-only resubmission Modal.
- Accounting Dashboard: tax-invoice review queue and an adjacent withholding tab. Account and superadmin may approve/reject; admin has view access only. Rejection requires a reason and captures the inspected snapshot, so stale approvals are refused.
- Passed EasySlip records freeze request flags and VAT rate. Existing rejected requests can be corrected using the TAX RPC; receipt amounts and order financial fields are not accepted by that RPC.
- Work-order attachment is checked by a database trigger (UUID, legacy name link and order status) and surfaced through the existing work-order-selection blocking API. Both requested approvals must pass. Document issue/receipt can follow later.
- 3% uses rounded VAT-exclusive base after discounts and shipping. `total_amount` stays gross; `receivable_amount` is generated separately. Payment coverage, manual approval snapshots, bank matching, certification, overpayment handling and outstanding displays use net receivable.
- ERP invoice issue uses an order lock and an atomic company/month counter. Reissuing the same order returns the same document. Buyer, seller and invoice data are saved as a snapshot. FlowAccount reference is separately editable and audited.
- Existing confirmed invoices are not automatically renumbered. If legacy confirmed documents exist in the issue month, accounting must inspect its actual register and confirm the last used sequence through the shared Modal. Counters cannot move backwards. Recovering missing historical document snapshots is a manual reconciliation task, not an automatic backfill.
- Withholding receipt stores certificate number, date, actor/time and a private PDF/image attachment; cross-order attachment references and duplicate receipt are refused. Signed links are used to read files.
- Tax address fields remain separate from shipping and retain legacy full-text addresses. Auto Fill accepts only a unique labelled tax ID automatically; uncertain IDs and postcode choices require explicit selection. Structured addresses are checked against the existing Thai address tables/postal aliases before accounting approval.
- RD VAT lookup uses an authenticated Edge Function, checksum validation, selected branch, timeout, and SOAP/JSON response parsing. The form debounces for one second, discards stale responses, distinguishes not-found from unavailable, and applies registry data only after an explicit click. TIN service is not included.

## Database/runtime changes — prepared, not applied to production

Apply in order to an isolated staging database first:

1. `690_tax_workflow.sql`: receivable column, workflow guard/RPC, validation, audit, protected document tables and role-menu seeds.
2. `691_tax_invoice_numbering.sql`: issuance, legacy-sequence initialization and FlowAccount reference RPCs.
3. `692_tax_receivable_payment_paths.sql`: payment-path replacements based on the latest existing migrations; preserves gross sales reporting.
4. `693_tax_evidence.sql`: private evidence bucket and storage policies.
5. `694_tax_queue.sql`: paginated, role/menu-aware queues and cancelled-request closure.

The frontend requires these migrations before use. The `rd-vat-lookup` Edge Function must be available in the staging environment to test the whole application-to-RD path. No migration, deployment, production SQL write or production UI write was performed during development.

## Verification

- `npm run test:tax-db`: embedded PostgreSQL (PGlite), minimal legacy-schema fixtures; executes actual workflow/numbering/payment/queue SQL and verifies workflow, authorization, stale review, checksums/postcode relationships, net payments, evidence ownership, old documents and series initialization.
- `npx vitest run --exclude '**/.tmp/**'`: application tests, including React DOM tests for debounce/stale responses, explicit registry application, rejection/resubmission permissions and immutable invoice re-opening.
- `npm run build`: TypeScript plus Vite.
- Targeted ESLint for new components/helpers/tests; `git diff --check`.

An approved read-only SOAP probe sent only business TIN `0103563005345`: branch 00000 returned found, branch 00001 returned not-found, both HTTP 200. This verifies the local adapter and nonzero-branch request, not a successful result for an existing nonzero branch or connectivity from a deployed Supabase function. Not-found and transport failures are covered by fixtures.

The legacy address CSV fallback lacks district names. The new form refuses to infer a district from that incomplete fallback and displays an unavailable-address message; structured entry needs the existing Thai address tables to be accessible. Legacy full-text addresses are retained.

Before production rollout, test with a representative database copy and separate staging credentials. The embedded fixture suite is not a full replay of the entire production migration history or every existing reconciliation function. Confirm historical invoice sequence starting points with accounting and exercise the Edge Function from staging. Existing generated PDF layout is retained; no browser session was used to write real bills.
## Subsequent deployment verification — 4 November 2026

At the user's explicit request, only `rd-vat-lookup` was deployed to Supabase project `zkzjbhvsltbwbtteihiy`, matching localhost configuration, using `supabase functions deploy rd-vat-lookup --project-ref zkzjbhvsltbwbtteihiy --use-api`. No website deployment or migration was performed by the agent in this step.

Verified end to end in the existing signed-in localhost form: TIN `0103563005345`, branch `00000` returned the partnership name and structured address, and displayed the explicit apply-data button. No bill was saved, no registry data was applied automatically, and the pre-test tax-ID input was restored. Proof: `.tmp/rd-vat-localhost-proof.jpg`.
