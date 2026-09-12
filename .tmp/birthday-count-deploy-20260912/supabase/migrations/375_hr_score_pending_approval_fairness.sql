-- สถานะรออนุมัติเป็นงานค้างของผู้อนุมัติ ไม่ควรหักคะแนนพนักงาน
-- ตัวคำนวณฝั่งแอปจะพักการให้คะแนนจนสถานะเปลี่ยนเป็น approved/rejected

UPDATE hr_score_rules
SET name = 'ใบลารออนุมัติ (ยังไม่หักคะแนน)',
    points = 0,
    is_active = false,
    updated_at = NOW()
WHERE event_code = 'absent_pending_leave';

UPDATE hr_score_rules
SET name = 'ยื่นขอ OT หลังเริ่มทำ',
    updated_at = NOW()
WHERE event_code = 'ot_late_request';

UPDATE hr_score_rules
SET name = 'ทำ OT โดยไม่มีคำขอหรือคำขอถูกปฏิเสธ',
    updated_at = NOW()
WHERE event_code = 'ot_unapproved';
