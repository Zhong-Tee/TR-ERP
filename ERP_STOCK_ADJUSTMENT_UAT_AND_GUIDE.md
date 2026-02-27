# ERP Stock Adjustment (FIFO) - UAT and Operating Guide

## 1) Document Types

- `audit_adjustment`: Use when physical count does not match system quantity.
  - Impacts quantity and inventory value.
  - Uses FIFO cost logic in stock lots.
- `safety_reclass`: Use when moving quantity between `on_hand` and `safety_stock`.
  - Does not change total quantity.
  - Should not change total inventory value.

## 2) User Workflow

1. Go to Warehouse > Stock Adjustment.
2. Click `+ สร้างใบปรับสต๊อค`.
3. Select `ประเภทใบปรับ`.
4. Fill `หัวข้อการปรับ` and (optional) `Reason Code`.
5. Add product rows and set target values.
6. Save as pending document.
7. Approver reviews details (`เดิม -> ใหม่` and cost impact) then approves.

## 3) UAT Scenarios (Must Pass)

### Scenario A: Audit Increase
- Before: on_hand = 100, safety = 10
- Create `audit_adjustment`, target on_hand = 120, safety = 10
- Expect:
  - qty_delta = +20
  - movement created with positive qty and cost fields
  - new lot created
  - landed cost recalculated

### Scenario B: Audit Decrease
- Before: on_hand = 100, safety = 10
- Create `audit_adjustment`, target on_hand = 90, safety = 10
- Expect:
  - qty_delta = -10
  - FIFO consumption recorded in lot consumptions
  - movement total_cost reflects consumed FIFO layers
  - landed cost recalculated

### Scenario C: Safety Reclass
- Before: on_hand = 100, safety = 10
- Create `safety_reclass`, target safety = 30
- Expect:
  - qty_delta = 0 (no audit in/out)
  - safety changes 10 -> 30
  - on_hand adjusts to keep total quantity stable (100 -> 80)
  - total inventory value should remain stable

### Scenario D: Concurrent Change Before Approval
- Create pending document, then modify stock from another process.
- Approve the pending document.
- Expect:
  - snapshot fields still show original `before -> after` from document creation
  - reconcile report identifies any mismatch if current state diverges

## 4) Reconcile Checks (Post Approval)

Run via RPC:

```sql
select * from fn_inventory_adjustment_reconcile('<adjustment_id>');
```

Pass criteria:
- `qty_consistent = true`
- `balance_total_qty` aligned with expected after quantities
- `movement_total_cost_impact` is populated for audit adjustments
- `lot_qty_remaining` and `lot_total_value` are sensible and non-negative

## 5) Accounting Notes

- Audit adjustments should map to inventory gain/loss accounts by reason code.
- Safety reclass should be treated as internal reclassification, not purchase/sale.
- Use `approved_total_cost_impact` for finalized financial impact.
