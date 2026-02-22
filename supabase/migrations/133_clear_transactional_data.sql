-- ============================================
-- 133: Clear All Transactional Data
-- เคลียร์ข้อมูล transactional ทั้งหมด เหลือเฉพาะ
--   - pr_products (master สินค้า)
--   - ตาราง settings / reference / config ทั้งหมด
-- ลำดับ TRUNCATE เรียงจาก child → parent ตาม FK
-- ============================================

BEGIN;

-- ═══════════════════════════════════════════
-- Layer 0: Leaf nodes (ไม่มีใครอ้างอิง)
-- ═══════════════════════════════════════════

-- Standalone
TRUNCATE plan_jobs;
TRUNCATE roll_usage_logs;
TRUNCATE or_work_orders;
TRUNCATE or_order_chat_reads;
TRUNCATE qc_skip_logs;
TRUNCATE inv_stock_balances;
TRUNCATE wms_orders;
TRUNCATE wms_order_summaries;
TRUNCATE wms_notifications;
TRUNCATE hr_notification_logs;

-- Deepest children
TRUNCATE or_order_reviews;
TRUNCATE or_order_chat_logs;
TRUNCATE or_order_amendments;
TRUNCATE or_order_revisions;
TRUNCATE or_issue_messages;
TRUNCATE or_issue_reads;
TRUNCATE pk_packing_logs;
TRUNCATE pk_packing_videos;
TRUNCATE qc_records;
TRUNCATE ac_verified_slips;
TRUNCATE ac_refunds;
TRUNCATE ac_slip_verification_logs;
TRUNCATE ac_bill_edit_logs;
TRUNCATE ac_manual_slip_checks;
TRUNCATE ac_credit_note_items;
TRUNCATE inv_lot_consumptions;
TRUNCATE inv_pr_items;
TRUNCATE inv_po_items;
TRUNCATE inv_gr_items;
TRUNCATE inv_audit_count_logs;
TRUNCATE inv_adjustment_items;
TRUNCATE inv_return_items;
TRUNCATE inv_sample_items;
TRUNCATE wms_requisition_items;
TRUNCATE wms_return_requisition_items;
TRUNCATE wms_borrow_requisition_items;
TRUNCATE pp_production_order_items;
TRUNCATE hr_leave_requests;
TRUNCATE hr_leave_balances;
TRUNCATE hr_interview_scores;
TRUNCATE hr_attendance_summary;
TRUNCATE hr_attendance_daily;
TRUNCATE hr_contracts;
TRUNCATE hr_exam_results;
TRUNCATE hr_document_reads;
TRUNCATE hr_onboarding_progress;
TRUNCATE hr_employee_career;
TRUNCATE hr_career_history;
TRUNCATE hr_notifications;
TRUNCATE hr_warnings;
TRUNCATE hr_certificates;

-- ═══════════════════════════════════════════
-- Layer 1: Parent ของ Layer 0
-- ═══════════════════════════════════════════

TRUNCATE or_order_items;
TRUNCATE or_issues;
TRUNCATE qc_sessions;
TRUNCATE ac_credit_notes;
TRUNCATE inv_stock_lots;
TRUNCATE inv_stock_movements;
TRUNCATE inv_audit_items;
TRUNCATE inv_gr;
TRUNCATE inv_returns;
TRUNCATE inv_samples;
TRUNCATE wms_requisitions;
TRUNCATE wms_return_requisitions;
TRUNCATE wms_borrow_requisitions;
TRUNCATE pp_production_orders;
TRUNCATE hr_interviews;
TRUNCATE hr_attendance_uploads;
TRUNCATE hr_documents;
TRUNCATE hr_onboarding_plans;

-- ═══════════════════════════════════════════
-- Layer 2: Parent ของ Layer 1
-- ═══════════════════════════════════════════

TRUNCATE or_orders;
TRUNCATE inv_audits;
TRUNCATE inv_po;
TRUNCATE hr_candidates;
TRUNCATE hr_employees;

-- ═══════════════════════════════════════════
-- Layer 3: Root parents (ลบท้ายสุด)
-- ═══════════════════════════════════════════

TRUNCATE inv_adjustments;
TRUNCATE inv_pr;

-- ═══════════════════════════════════════════
-- Reset ค่าคำนวณใน pr_products
-- (landed_cost คำนวณจาก inv_stock_lots ที่ลบไปแล้ว)
-- ═══════════════════════════════════════════

UPDATE pr_products SET landed_cost = 0;

COMMIT;
