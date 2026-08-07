import { describe, it, expect } from 'vitest'
import {
  applyCumulativeRules,
  buildMonthlyScores,
  evaluateDay,
  indexRules,
  isLateLeaveNotice,
  minutesToClock,
  otRequestedBeforeStart,
  pickLateRule,
  scoringEndDate,
  splitAbsenceGroup,
  summarizeMonth,
  type AttendanceFact,
  type ScoreCategory,
  type ScoreEventDraft,
  type ScoreRule,
} from './workScore'

const CATEGORY: ScoreCategory = {
  id: 'cat-1',
  code: 'discipline',
  name: 'คะแนนวินัย',
  description: null,
  base_points: 100,
  min_points: 0,
  weight: 1,
  is_active: true,
  sort_order: 1,
}

const rule = (
  event_code: string,
  group_code: string,
  points: number,
  extra: Partial<ScoreRule> = {},
): ScoreRule => ({
  id: `rule-${event_code}`,
  category_id: CATEGORY.id,
  group_code,
  event_code,
  name: event_code,
  points,
  threshold_min: null,
  threshold_max: null,
  cap_per_month: null,
  applies_to: 'all',
  counts_event_prefix: null,
  points_step: 0,
  is_active: true,
  sort_order: 0,
  ...extra,
})

/** ชุดกติกาเดียวกับที่ seed ไว้ใน migration 326 */
const RULES: ScoreRule[] = [
  rule('late_1_15', 'attendance', -1, { threshold_min: 1, threshold_max: 15 }),
  rule('late_16_30', 'attendance', -2, { threshold_min: 16, threshold_max: 30 }),
  rule('late_over_30', 'attendance', -4, { threshold_min: 31 }),
  rule('early_leave', 'attendance', -4, { threshold_min: 1 }),
  rule('missing_in_certified', 'time_entry', 0),
  rule('missing_in_unproven', 'time_entry', -5, { threshold_min: 240 }),
  rule('missing_out_certified', 'time_entry', 0),
  rule('missing_out_unproven', 'time_entry', -5),
  rule('leave_approved', 'leave', 0),
  rule('leave_late_notice', 'leave', -2),
  rule('absent_pending_leave', 'leave', -10),
  rule('absent', 'leave', -20),
  rule('ot_late_request', 'ot', -2),
  rule('ot_unapproved', 'ot', -3),
]

const INDEX = indexRules(RULES)

/** วันทำงานปกติ 08:00–17:00 มาตรงเวลา กลับตรงเวลา */
const baseFact = (over: Partial<AttendanceFact> = {}): AttendanceFact => ({
  employee_id: 'emp-1',
  employee_code: 'E001',
  employee_name: 'สมชาย ใจดี',
  department_id: 'dept-1',
  work_date: '2026-08-03',
  day_type: 'work',
  work_mode: 'office',
  is_remote_day: false,
  expected_start_min: 8 * 60,
  expected_end_min: 17 * 60,
  grace_min: 0,
  actual_in_min: 8 * 60,
  actual_in_source: 'entry',
  actual_in_ref: 'entry-in',
  actual_out_min: 17 * 60,
  actual_out_source: 'entry',
  actual_out_ref: 'entry-out',
  ot_in_min: null,
  ot_in_ref: null,
  ot_request_id: null,
  ot_request_status: null,
  ot_request_created_date: null,
  ot_request_created_min: null,
  leave_id: null,
  leave_status: null,
  leave_mode: null,
  leave_type_name: null,
  leave_start_date: null,
  leave_filed_date: null,
  leave_filed_min: null,
  leave_start_min: null,
  leave_end_min: null,
  ...over,
})

const codes = (fact: AttendanceFact) => evaluateDay(fact, INDEX).map((e) => e.event_code)
const points = (fact: AttendanceFact) => evaluateDay(fact, INDEX).reduce((s, e) => s + e.points, 0)

describe('pickLateRule', () => {
  const onsite = baseFact()
  it('เลือกขั้นตามจำนวนนาทีที่สาย', () => {
    expect(pickLateRule(INDEX, 1, onsite)?.event_code).toBe('late_1_15')
    expect(pickLateRule(INDEX, 15, onsite)?.event_code).toBe('late_1_15')
    expect(pickLateRule(INDEX, 16, onsite)?.event_code).toBe('late_16_30')
    expect(pickLateRule(INDEX, 30, onsite)?.event_code).toBe('late_16_30')
    expect(pickLateRule(INDEX, 31, onsite)?.event_code).toBe('late_over_30')
    expect(pickLateRule(INDEX, 600, onsite)?.event_code).toBe('late_over_30')
  })
  it('ไม่สาย → ไม่มีขั้นไหนตรง', () => {
    expect(pickLateRule(INDEX, 0, onsite)).toBeNull()
  })
})

describe('1. การมาทำงาน', () => {
  it('มาตรงเวลา กลับตรงเวลา → ไม่มีเหตุการณ์', () => {
    expect(codes(baseFact())).toEqual([])
  })
  it('มาสาย 12 นาที → -1', () => {
    const f = baseFact({ actual_in_min: 8 * 60 + 12 })
    expect(codes(f)).toEqual(['late_1_15'])
    expect(points(f)).toBe(-1)
  })
  it('มาสาย 25 นาที → -2', () => {
    expect(points(baseFact({ actual_in_min: 8 * 60 + 25 }))).toBe(-2)
  })
  it('มาสาย 45 นาที → -4', () => {
    expect(points(baseFact({ actual_in_min: 8 * 60 + 45 }))).toBe(-4)
  })
  it('เวลาผ่อนผันหักออกก่อนคิดขั้นความสาย', () => {
    // สายจริง 10 นาที ผ่อนผัน 10 → ไม่สาย
    expect(codes(baseFact({ actual_in_min: 8 * 60 + 10, grace_min: 10 }))).toEqual([])
    // สายจริง 20 นาที ผ่อนผัน 10 → เหลือ 10 → ขั้นแรก
    expect(codes(baseFact({ actual_in_min: 8 * 60 + 20, grace_min: 10 }))).toEqual(['late_1_15'])
  })
  it('กลับก่อนเวลา → -4', () => {
    const f = baseFact({ actual_out_min: 16 * 60 })
    expect(codes(f)).toEqual(['early_leave'])
    expect(points(f)).toBe(-4)
  })
  it('สายและกลับก่อนเวลาในวันเดียวกัน → หักทั้งสองอย่าง', () => {
    const f = baseFact({ actual_in_min: 8 * 60 + 20, actual_out_min: 15 * 60 })
    expect(codes(f)).toEqual(['late_16_30', 'early_leave'])
    expect(points(f)).toBe(-6)
  })
  it('วันหยุดไม่คิดคะแนน', () => {
    expect(codes(baseFact({ day_type: 'weekly_off', actual_in_min: null, actual_out_min: null }))).toEqual([])
    expect(codes(baseFact({ day_type: 'company_holiday', actual_in_min: null, actual_out_min: null }))).toEqual([])
  })
  it('ใช้เวลาเข้า-ออกตามตารางของวันนั้น ไม่ใช่ค่าคงที่', () => {
    // กะบ่าย 13:00–22:00 มา 13:05 = สาย 5 นาที
    const f = baseFact({
      expected_start_min: 13 * 60,
      expected_end_min: 22 * 60,
      actual_in_min: 13 * 60 + 5,
      actual_out_min: 22 * 60,
    })
    expect(codes(f)).toEqual(['late_1_15'])
  })
})

describe('2. การลงเวลา', () => {
  it('ไม่มีเวลาเข้า แต่หัวหน้ารับรอง และไม่สาย → ไม่หัก', () => {
    const f = baseFact({ actual_in_source: 'certified', actual_in_ref: 'cert-in' })
    expect(codes(f)).toEqual(['missing_in_certified'])
    expect(points(f)).toBe(0)
  })
  it('หัวหน้ารับรองเวลาที่สาย → ยังหักตามขั้นความสาย', () => {
    const f = baseFact({
      actual_in_min: 8 * 60 + 40,
      actual_in_source: 'certified',
      actual_in_ref: 'cert-in',
    })
    expect(codes(f)).toEqual(['missing_in_certified', 'late_over_30'])
    expect(points(f)).toBe(-4)
  })
  it('ไม่มีเวลาเข้า พิสูจน์ไม่ได้ แต่ทำงานยาวพอ → -5', () => {
    const f = baseFact({ actual_in_min: null, actual_in_source: null, actual_in_ref: null })
    expect(codes(f)).toEqual(['missing_in_unproven'])
    expect(points(f)).toBe(-5)
  })
  it('ไม่มีเวลาเข้า และเวลาออกสั้นเกินกว่าจะเชื่อว่ามาทำงาน → นับเป็นขาดงาน', () => {
    // แวะมากดออกตอน 09:00 (ห่างเวลาเข้างานแค่ 60 นาที < 240)
    const f = baseFact({
      actual_in_min: null, actual_in_source: null, actual_in_ref: null,
      actual_out_min: 9 * 60,
    })
    expect(codes(f)).toEqual(['absent'])
    expect(points(f)).toBe(-20)
  })
  it('ไม่มีเวลาออก แต่หัวหน้ารับรอง → 0', () => {
    const f = baseFact({ actual_out_source: 'certified', actual_out_ref: 'cert-out' })
    expect(codes(f)).toEqual(['missing_out_certified'])
    expect(points(f)).toBe(0)
  })
  it('ไม่มีเวลาออก และพิสูจน์ไม่ได้ → -5', () => {
    const f = baseFact({ actual_out_min: null, actual_out_source: null, actual_out_ref: null })
    expect(codes(f)).toEqual(['missing_out_unproven'])
    expect(points(f)).toBe(-5)
  })
  it('เหตุการณ์ผูกกลับไปยังบันทึกต้นทางเสมอ', () => {
    const [ev] = evaluateDay(baseFact({ actual_in_min: 8 * 60 + 5 }), INDEX)
    expect(ev.ref_table).toBe('hr_time_entries')
    expect(ev.ref_id).toBe('entry-in')
    expect(ev.detail).toMatchObject({ late_min: 5 })
  })
})

describe('3. การลา', () => {
  const leaveDay = (over: Partial<AttendanceFact> = {}) => baseFact({
    actual_in_min: null, actual_in_source: null, actual_in_ref: null,
    actual_out_min: null, actual_out_source: null, actual_out_ref: null,
    leave_id: 'leave-1',
    leave_status: 'approved',
    leave_mode: 'full_day',
    leave_type_name: 'ลาป่วย',
    leave_start_date: '2026-08-03',
    leave_filed_date: '2026-08-01',
    leave_filed_min: 10 * 60,
    ...over,
  })

  it('ลาถูกต้องตามระเบียบ → 0 และไม่โดนหักเรื่องไม่ลงเวลา', () => {
    const f = leaveDay()
    expect(codes(f)).toEqual(['leave_approved'])
    expect(points(f)).toBe(0)
  })
  it('แจ้งลาหลังเวลาเริ่มงานของวันแรก → -2', () => {
    const f = leaveDay({ leave_filed_date: '2026-08-03', leave_filed_min: 9 * 60 })
    expect(codes(f)).toEqual(['leave_late_notice'])
    expect(points(f)).toBe(-2)
  })
  it('แจ้งลาเช้าวันเดียวกันแต่ก่อนเวลาเข้างาน → ไม่หัก', () => {
    const f = leaveDay({ leave_filed_date: '2026-08-03', leave_filed_min: 7 * 60 + 30 })
    expect(codes(f)).toEqual(['leave_approved'])
  })
  it('ลาหลายวัน แจ้งก่อนวันแรก → วันที่สองก็ไม่หัก', () => {
    const f = leaveDay({ work_date: '2026-08-04', leave_start_date: '2026-08-03', leave_filed_date: '2026-08-01' })
    expect(codes(f)).toEqual(['leave_approved'])
  })
  it('ไม่มาทำงาน ทั้งที่การลายังไม่อนุมัติ → -10', () => {
    const f = leaveDay({ leave_status: 'pending' })
    expect(codes(f)).toEqual(['absent_pending_leave'])
    expect(points(f)).toBe(-10)
  })
  it('ขาดงาน (ไม่มีทั้งเวลาและใบลา) → -20', () => {
    const f = leaveDay({ leave_id: null, leave_status: null, leave_mode: null, leave_start_date: null, leave_filed_date: null })
    expect(codes(f)).toEqual(['absent'])
    expect(points(f)).toBe(-20)
  })
  it('ลาชั่วโมงช่วงเช้าที่อนุมัติแล้ว → มาสายไม่หัก', () => {
    const f = baseFact({
      actual_in_min: 10 * 60,
      leave_id: 'leave-2',
      leave_status: 'approved',
      leave_mode: 'hourly',
      leave_start_min: 8 * 60,
      leave_end_min: 10 * 60,
      leave_start_date: '2026-08-03',
      leave_filed_date: '2026-08-01',
      leave_filed_min: 9 * 60,
    })
    expect(codes(f)).toEqual([])
  })
  it('ลาชั่วโมงช่วงบ่ายที่อนุมัติแล้ว → กลับก่อนเวลาไม่หัก', () => {
    const f = baseFact({
      actual_out_min: 15 * 60,
      leave_id: 'leave-3',
      leave_status: 'approved',
      leave_mode: 'hourly',
      leave_start_min: 15 * 60,
      leave_end_min: 17 * 60,
      leave_start_date: '2026-08-03',
      leave_filed_date: '2026-08-01',
      leave_filed_min: 9 * 60,
    })
    expect(codes(f)).toEqual([])
  })
})

describe('4. OT', () => {
  const otDay = (over: Partial<AttendanceFact> = {}) => baseFact({
    ot_in_min: 18 * 60,
    ot_in_ref: 'entry-ot',
    ...over,
  })

  it('ขอ OT ไว้ล่วงหน้าและอนุมัติแล้ว → ไม่หัก', () => {
    const f = otDay({
      ot_request_id: 'ot-1',
      ot_request_status: 'approved',
      ot_request_created_date: '2026-08-02',
      ot_request_created_min: 15 * 60,
    })
    expect(codes(f)).toEqual([])
  })
  it('ลืมขอ OT ก่อนทำ (ขอหลังเริ่มไปแล้ว) → -2', () => {
    const f = otDay({
      ot_request_id: 'ot-1',
      ot_request_status: 'approved',
      ot_request_created_date: '2026-08-03',
      ot_request_created_min: 19 * 60,
    })
    expect(codes(f)).toEqual(['ot_late_request'])
    expect(points(f)).toBe(-2)
  })
  it('ทำ OT โดยไม่มีคำขออนุมัติ → -3', () => {
    expect(points(otDay())).toBe(-3)
    expect(points(otDay({ ot_request_id: 'ot-1', ot_request_status: 'pending' }))).toBe(-3)
    expect(points(otDay({ ot_request_id: 'ot-1', ot_request_status: 'rejected' }))).toBe(-3)
  })
  it('ทำ OT วันหยุดโดยไม่ได้รับอนุมัติ ก็ยังหัก', () => {
    const f = otDay({ day_type: 'weekly_off', actual_in_min: null, actual_out_min: null })
    expect(codes(f)).toEqual(['ot_unapproved'])
  })
  it('ไม่ได้ทำ OT → ไม่เกิดเหตุการณ์ OT แม้มีคำขอค้างอยู่', () => {
    expect(codes(baseFact({ ot_request_id: 'ot-1', ot_request_status: 'pending' }))).toEqual([])
  })
})

describe('otRequestedBeforeStart / isLateLeaveNotice', () => {
  it('ขอ OT ข้ามวันมาก่อน → นับว่าขอทัน', () => {
    expect(otRequestedBeforeStart(baseFact({
      ot_in_min: 18 * 60, ot_request_created_date: '2026-08-02', ot_request_created_min: 23 * 60,
    }))).toBe(true)
  })
  it('ยื่นใบลาก่อนวันเริ่มลา → ไม่ถือว่าแจ้งช้า', () => {
    expect(isLateLeaveNotice(baseFact({
      leave_start_date: '2026-08-03', leave_filed_date: '2026-08-02', leave_filed_min: 22 * 60,
    }))).toBe(false)
  })
})

describe('summarizeMonth', () => {
  const eventsOf = (facts: AttendanceFact[]) => facts.flatMap((f) => evaluateDay(f, INDEX))

  it('เริ่มที่ 100 แล้วหักตามเหตุการณ์', () => {
    const facts = [
      baseFact({ work_date: '2026-08-03', actual_in_min: 8 * 60 + 5 }),   // -1
      baseFact({ work_date: '2026-08-04', actual_in_min: 8 * 60 + 20 }),  // -2
      baseFact({ work_date: '2026-08-05', actual_out_min: 15 * 60 }),     // -4
    ]
    const s = summarizeMonth('emp-1', eventsOf(facts), CATEGORY, INDEX)
    expect(s.raw_deduction).toBe(7)
    expect(s.total_points).toBe(93)
    expect(s.by_group).toEqual({ attendance: -7 })
  })

  it('หักเกิน 100 → คะแนนหยุดที่ 0 แต่ยอดหักจริงยังเก็บไว้', () => {
    const facts = Array.from({ length: 6 }, (_, i) => baseFact({
      work_date: `2026-08-0${i + 3}`,
      actual_in_min: null, actual_in_source: null, actual_in_ref: null,
      actual_out_min: null, actual_out_source: null, actual_out_ref: null,
    }))
    const s = summarizeMonth('emp-1', eventsOf(facts), CATEGORY, INDEX)
    expect(s.raw_deduction).toBe(120)
    expect(s.total_points).toBe(0)
  })

  it('เพดานรายเดือนของกติกาจำกัดยอดหัก', () => {
    const capped = indexRules(RULES.map((r) =>
      r.event_code === 'late_1_15' ? { ...r, cap_per_month: 5 } : r))
    const facts = Array.from({ length: 8 }, (_, i) => baseFact({
      work_date: `2026-08-1${i}`,
      actual_in_min: 8 * 60 + 5,
    }))
    const events = facts.flatMap((f) => evaluateDay(f, capped))
    const s = summarizeMonth('emp-1', events, CATEGORY, capped)
    expect(s.raw_deduction).toBe(5)
    expect(s.capped_amount).toBe(3)
    expect(s.total_points).toBe(95)
  })
})

describe('buildMonthlyScores', () => {
  it('แยกคะแนนรายคน และใช้เฉพาะกติกาของหมวดที่ระบุ', () => {
    const otherCategoryRule = rule('bonus_x', 'quality', -50, {})
    otherCategoryRule.category_id = 'cat-2'
    const facts = [
      baseFact({ employee_id: 'emp-1', actual_in_min: 8 * 60 + 5 }),
      baseFact({ employee_id: 'emp-2', work_date: '2026-08-03', actual_out_min: 15 * 60 }),
      baseFact({ employee_id: 'emp-2', work_date: '2026-08-04' }),
    ]
    const result = buildMonthlyScores(facts, CATEGORY, [...RULES, otherCategoryRule])
    expect(result.get('emp-1')?.total_points).toBe(99)
    expect(result.get('emp-2')?.total_points).toBe(96)
    expect(result.get('emp-2')?.events).toHaveLength(1)
  })

  it('กติกาที่ปิดใช้งานไม่ถูกนำมาคิด', () => {
    const rules = RULES.map((r) => (r.event_code === 'late_1_15' ? { ...r, is_active: false } : r))
    const result = buildMonthlyScores([baseFact({ actual_in_min: 8 * 60 + 5 })], CATEGORY, rules)
    expect(result.get('emp-1')?.total_points).toBe(100)
  })
})

describe('WFH / ขอบเขตกติกา (applies_to)', () => {
  it('วัน WFH ยังคิดคะแนนตามปกติ ถ้ากติกาเป็น all', () => {
    const f = baseFact({ work_mode: 'wfh', is_remote_day: true, actual_in_min: 8 * 60 + 20 })
    expect(codes(f)).toEqual(['late_16_30'])
  })
  it('กติกา onsite ไม่ถูกใช้ในวัน WFH', () => {
    const onsiteOnly = indexRules(RULES.map((r) =>
      r.event_code === 'early_leave' ? { ...r, applies_to: 'onsite' as const } : r))
    const remote = baseFact({ work_mode: 'wfh', is_remote_day: true, actual_out_min: 15 * 60 })
    const office = baseFact({ actual_out_min: 15 * 60 })
    expect(evaluateDay(remote, onsiteOnly)).toEqual([])
    expect(evaluateDay(office, onsiteOnly).map((e) => e.event_code)).toEqual(['early_leave'])
  })
  it('hybrid ที่มีใบ WFH อนุมัติ นับเป็น remote เหมือนกัน', () => {
    const remoteOnly = indexRules(RULES.map((r) =>
      r.event_code === 'absent' ? { ...r, applies_to: 'remote' as const } : r))
    const noShow = { actual_in_min: null, actual_in_source: null, actual_in_ref: null,
      actual_out_min: null, actual_out_source: null, actual_out_ref: null }
    const hybrid = baseFact({ work_mode: 'hybrid', is_remote_day: true, ...noShow })
    const office = baseFact({ ...noShow })
    expect(evaluateDay(hybrid, remoteOnly).map((e) => e.event_code)).toEqual(['absent'])
    expect(evaluateDay(office, remoteOnly)).toEqual([])
  })
  it('ขั้นความสายที่จำกัดเฉพาะ onsite ไม่ถูกเลือกในวัน WFH', () => {
    const scoped = indexRules(RULES.map((r) =>
      r.event_code === 'late_1_15' ? { ...r, applies_to: 'onsite' as const } : r))
    expect(pickLateRule(scoped, 5, baseFact({ is_remote_day: true }))).toBeNull()
    expect(pickLateRule(scoped, 5, baseFact())?.event_code).toBe('late_1_15')
  })
})

describe('กติกาสะสม (attendance_cumulative)', () => {
  const lateRepeat = rule('late_repeat', 'attendance_cumulative', -2, {
    threshold_min: 5,
    counts_event_prefix: 'late_',
  })
  const absentRepeat = rule('absent_repeat', 'attendance_cumulative', -5, {
    threshold_min: 1,
    counts_event_prefix: 'absent',
  })
  const WITH_CUMULATIVE = indexRules([...RULES, lateRepeat, absentRepeat])

  const lateDays = (n: number) => Array.from({ length: n }, (_, i) =>
    baseFact({ work_date: `2026-08-${String(i + 3).padStart(2, '0')}`, actual_in_min: 8 * 60 + 5 }))

  it('สายไม่เกินโควตา → ไม่มีเหตุการณ์สะสม', () => {
    const events = lateDays(5).flatMap((f) => evaluateDay(f, WITH_CUMULATIVE))
    expect(applyCumulativeRules(events, WITH_CUMULATIVE)).toEqual([])
  })

  it('สาย 8 ครั้ง → หักเพิ่ม 3 ครั้ง ลงวันที่ของครั้งที่ 6–8', () => {
    const events = lateDays(8).flatMap((f) => evaluateDay(f, WITH_CUMULATIVE))
    const extra = applyCumulativeRules(events, WITH_CUMULATIVE)
    expect(extra).toHaveLength(3)
    expect(extra.map((e) => e.event_date)).toEqual(['2026-08-08', '2026-08-09', '2026-08-10'])
    expect(extra[0].detail).toMatchObject({ occurrence: 6, allowance: 5, triggered_by: 'late_1_15' })
    // แต่ละวันไม่ซ้ำกัน จึงไม่ชน unique index ของ hr_score_events
    expect(new Set(extra.map((e) => e.event_date)).size).toBe(3)
  })

  it('นับข้ามขั้นความสาย — สายเบาบ้างหนักบ้างก็นับรวมกัน', () => {
    const facts = [
      baseFact({ work_date: '2026-08-03', actual_in_min: 8 * 60 + 5 }),
      baseFact({ work_date: '2026-08-04', actual_in_min: 8 * 60 + 20 }),
      baseFact({ work_date: '2026-08-05', actual_in_min: 8 * 60 + 40 }),
    ]
    const events = facts.flatMap((f) => evaluateDay(f, WITH_CUMULATIVE))
    const relaxed = indexRules([...RULES, { ...lateRepeat, threshold_min: 2 }])
    expect(applyCumulativeRules(events, relaxed)).toHaveLength(1)
  })

  it('สาย 1–15 นาทีทุกวัน 26 วัน → คะแนนลงมาต่ำกว่าเกณฑ์ผ่าน (โจทย์เดิม 74)', () => {
    const facts = Array.from({ length: 26 }, (_, i) =>
      baseFact({ work_date: `2026-08-${String(i + 1).padStart(2, '0')}`, actual_in_min: 8 * 60 + 5 }))
    const events = facts.flatMap((f) => evaluateDay(f, WITH_CUMULATIVE))
    const s = summarizeMonth('emp-1', events, CATEGORY, WITH_CUMULATIVE)
    // -26 จากขั้นความสาย + (26-5)*2 = -42 จากกติกาสะสม
    expect(s.raw_deduction).toBe(68)
    expect(s.total_points).toBe(32)
  })

  it('เหตุการณ์สะสมไม่ถูกนับซ้ำเป็นฐานของกติกาสะสมอื่น', () => {
    const noShow = { actual_in_min: null, actual_in_source: null, actual_in_ref: null,
      actual_out_min: null, actual_out_source: null, actual_out_ref: null }
    const facts = Array.from({ length: 3 }, (_, i) =>
      baseFact({ work_date: `2026-08-0${i + 3}`, ...noShow }))
    const events = facts.flatMap((f) => evaluateDay(f, WITH_CUMULATIVE))
    const extra = applyCumulativeRules(events, WITH_CUMULATIVE)
    // ขาด 3 ครั้ง ยอมให้ 1 → หักเพิ่ม 2 ครั้ง และ absent_repeat ไม่นับตัวเอง
    expect(extra.filter((e) => e.event_code === 'absent_repeat')).toHaveLength(2)
    expect(applyCumulativeRules([...events, ...extra], WITH_CUMULATIVE)
      .filter((e) => e.event_code === 'absent_repeat')).toHaveLength(2)
  })

  it('เหตุการณ์ที่ HR คืนคะแนนให้แล้ว ไม่ถูกนับเป็นความผิดสะสมอีก', () => {
    const events = lateDays(8).flatMap((f) => evaluateDay(f, WITH_CUMULATIVE))
    // ยอมรับคำทักท้วงของวันที่ 3 และ 4 → สร้างเหตุการณ์ชดเชย
    const reversal = (date: string): ScoreEventDraft => ({
      employee_id: 'emp-1', event_date: date, event_code: 'late_1_15_reversed',
      rule_id: '', category_id: CATEGORY.id, group_code: 'manual',
      label: 'ยอมรับคำทักท้วง', points: 1, ref_table: 'hr_score_appeals', ref_id: 'appeal-1', detail: {},
    })
    const withReversals = [...events, reversal('2026-08-03'), reversal('2026-08-04')]
    // เหลือสายจริง 6 ครั้ง โควตา 5 → หักเพิ่มครั้งเดียว (จากเดิม 3 ครั้ง)
    expect(applyCumulativeRules(withReversals, WITH_CUMULATIVE)).toHaveLength(1)
  })

  it('รายการชดเชย (คะแนนบวก) ไม่ถูกนับเป็นฐานของกติกาสะสม', () => {
    const bonus: ScoreEventDraft = {
      employee_id: 'emp-1', event_date: '2026-08-03', event_code: 'late_bonus',
      rule_id: '', category_id: CATEGORY.id, group_code: 'attendance',
      label: 'โบนัส', points: 3, ref_table: null, ref_id: null, detail: {},
    }
    expect(applyCumulativeRules(Array(8).fill(bonus), WITH_CUMULATIVE)).toEqual([])
  })

  it('points_step = 0 → หักเท่ากันทุกครั้งที่เกิน (พฤติกรรมเดิม)', () => {
    const events = lateDays(8).flatMap((f) => evaluateDay(f, WITH_CUMULATIVE))
    const extra = applyCumulativeRules(events, WITH_CUMULATIVE)
    expect(extra.map((e) => e.points)).toEqual([-2, -2, -2])
  })

  it('points_step ติดลบ → หักเพิ่มขึ้นทีละขั้นในแต่ละครั้งที่เกิน', () => {
    // ยอมให้ 5 ครั้ง · ฐาน -2 · เพิ่มขึ้นครั้งละ -2
    const escalating = indexRules([...RULES, { ...lateRepeat, points_step: -2 }])
    const events = lateDays(9).flatMap((f) => evaluateDay(f, escalating))
    const extra = applyCumulativeRules(events, escalating)
    expect(extra.map((e) => e.points)).toEqual([-2, -4, -6, -8])
    expect(extra[2].detail).toMatchObject({ escalation_nth: 3, base_points: -2, points_step: -2 })
    // สาย 9 ครั้ง: -1 × 9 จากขั้นความสาย + (2+4+6+8) จากสะสม
    const s = summarizeMonth('emp-1', events, CATEGORY, escalating)
    expect(s.raw_deduction).toBe(29)
    expect(s.total_points).toBe(71)
  })

  it('เพดานต่อเดือนยังคุมยอดสะสมที่ไล่ระดับได้', () => {
    const capped = indexRules([...RULES, { ...lateRepeat, points_step: -2, cap_per_month: 10 }])
    const events = lateDays(9).flatMap((f) => evaluateDay(f, capped))
    const s = summarizeMonth('emp-1', events, CATEGORY, capped)
    // สะสมรวม -20 แต่เพดาน 10 → หักจริง 10 (+9 จากขั้นความสาย)
    expect(s.raw_deduction).toBe(19)
    expect(s.capped_amount).toBe(10)
  })

  it('step ผิดทาง (บวกในกติกาหัก) ไม่ทำให้กลายเป็นให้คะแนน', () => {
    const wrongWay = indexRules([...RULES, { ...lateRepeat, points_step: 5 }])
    const events = lateDays(9).flatMap((f) => evaluateDay(f, wrongWay))
    const extra = applyCumulativeRules(events, wrongWay)
    // -2, +3→0, +8→0, +13→0 — หยุดที่ 0 ไม่กลายเป็นคะแนนบวก
    expect(extra.map((e) => e.points)).toEqual([-2, 0, 0, 0])
  })

  it('summarizeMonth เติมเหตุการณ์สะสมให้เอง', () => {
    const events = lateDays(7).flatMap((f) => evaluateDay(f, WITH_CUMULATIVE))
    const s = summarizeMonth('emp-1', events, CATEGORY, WITH_CUMULATIVE)
    expect(s.events).toHaveLength(9)
    expect(s.by_group.attendance_cumulative).toBe(-4)
    expect(s.total_points).toBe(89)
  })

  it('ส่งผลลัพธ์เดิมกลับเข้า summarizeMonth ซ้ำ → ได้คะแนนเท่าเดิม (ไม่หักซ้อน)', () => {
    const events = lateDays(7).flatMap((f) => evaluateDay(f, WITH_CUMULATIVE))
    const once = summarizeMonth('emp-1', events, CATEGORY, WITH_CUMULATIVE)
    const twice = summarizeMonth('emp-1', once.events, CATEGORY, WITH_CUMULATIVE)
    const thrice = summarizeMonth('emp-1', twice.events, CATEGORY, WITH_CUMULATIVE)
    expect(twice.total_points).toBe(once.total_points)
    expect(thrice.total_points).toBe(once.total_points)
    expect(twice.events).toHaveLength(once.events.length)
  })

  it('รวมเหตุการณ์ที่ HR เพิ่มเองเข้ากับผลเดิม → กติกาสะสมคำนวณใหม่ครั้งเดียว', () => {
    const events = lateDays(7).flatMap((f) => evaluateDay(f, WITH_CUMULATIVE))
    const once = summarizeMonth('emp-1', events, CATEGORY, WITH_CUMULATIVE)
    const manual: ScoreEventDraft = {
      employee_id: 'emp-1', event_date: '2026-08-20', event_code: 'absent',
      rule_id: 'rule-absent', category_id: CATEGORY.id, group_code: 'leave',
      label: 'ขาดงาน', points: -20, ref_table: null, ref_id: null, detail: {},
    }
    const merged = summarizeMonth('emp-1', [...once.events, manual], CATEGORY, WITH_CUMULATIVE)
    // -7 ขั้นความสาย · -4 สายสะสม (7-5=2 ครั้ง) · -20 ขาดงาน (ยังไม่เกินโควตา 1 ครั้ง)
    expect(merged.raw_deduction).toBe(31)
    expect(merged.total_points).toBe(69)
  })
})

describe('scoringEndDate', () => {
  it('เดือนที่ผ่านไปแล้ว → คิดถึงวันสุดท้ายของเดือน', () => {
    expect(scoringEndDate('2026-07', '2026-08-06')).toBe('2026-07-31')
    expect(scoringEndDate('2026-02', '2026-08-06')).toBe('2026-02-28')
  })
  it('เดือนปัจจุบัน → คิดถึงเมื่อวาน ไม่คิดวันนี้และอนาคต', () => {
    // วันนี้ยังไม่จบ คนที่ยังไม่กดออกงานจะกลายเป็น "ไม่มีเวลาออก"
    expect(scoringEndDate('2026-08', '2026-08-06')).toBe('2026-08-05')
  })
  it('วันที่ 1 ของเดือน → ยังไม่มีวันที่คิดได้', () => {
    expect(scoringEndDate('2026-08', '2026-08-01')).toBeNull()
  })
  it('วันที่ 2 ของเดือน → คิดได้แค่วันที่ 1', () => {
    expect(scoringEndDate('2026-08', '2026-08-02')).toBe('2026-08-01')
  })
  it('เดือนในอนาคต → ยังไม่มีวันที่คิดได้', () => {
    expect(scoringEndDate('2026-09', '2026-08-06')).toBeNull()
  })
})

describe('splitAbsenceGroup', () => {
  const ev = (event_code: string, group_code: string, points: number): ScoreEventDraft => ({
    employee_id: 'emp-1', event_date: '2026-08-03', event_code,
    rule_id: `rule-${event_code}`, category_id: CATEGORY.id, group_code,
    label: event_code, points, ref_table: null, ref_id: null, detail: {},
  })

  it('แยกขาดงานออกจากการลา โดยยอดรวมทั้งสองหัวข้อเท่าเดิม', () => {
    const events = [
      ev('leave_late_notice', 'leave', -2),
      ev('absent', 'leave', -20),
      ev('absent_pending_leave', 'leave', -10),
    ]
    const result = splitAbsenceGroup({ leave: -32, attendance: -4 }, events)
    expect(result).toEqual({ leave: -2, absence: -30, attendance: -4 })
  })

  it('รายการชดเชยจากคำทักท้วง (absent_reversed) นับเข้าหัวข้อขาดงานด้วย', () => {
    const events = [ev('absent', 'leave', -20), ev('absent_reversed', 'leave', 20)]
    expect(splitAbsenceGroup({ leave: 0 }, events)).toEqual({ leave: 0, absence: 0 })
  })

  it('ไม่มีเหตุการณ์ขาดงาน → คงหัวข้อการลาไว้เหมือนเดิม และมีคอลัมน์ขาดงานเป็น 0', () => {
    const events = [ev('leave_late_notice', 'leave', -2)]
    expect(splitAbsenceGroup({ leave: -2 }, events)).toEqual({ leave: -2, absence: 0 })
  })

  it('เหตุการณ์ absent ที่อยู่กลุ่มอื่น (เช่นกติกาสะสม) ไม่ถูกดึงออกจากการลา', () => {
    const events = [ev('absent_repeat', 'attendance_cumulative', -5), ev('absent', 'leave', -20)]
    const result = splitAbsenceGroup({ leave: -20, attendance_cumulative: -5 }, events)
    expect(result).toEqual({ leave: 0, absence: -20, attendance_cumulative: -5 })
  })
})

describe('minutesToClock', () => {
  it('แปลงนาทีเป็นเวลา และรองรับข้ามเที่ยงคืน', () => {
    expect(minutesToClock(8 * 60)).toBe('08:00')
    expect(minutesToClock(17 * 60 + 30)).toBe('17:30')
    expect(minutesToClock(25 * 60)).toBe('25:00')
    expect(minutesToClock(null)).toBe('-')
  })
})
