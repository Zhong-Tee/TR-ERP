/**
 * คะแนนการปฏิบัติงาน — Phase 1: คะแนนวินัย (Discipline Score)
 *
 * ตรรกะการให้คะแนนอยู่ที่ไฟล์นี้ที่เดียว: รับ "ข้อเท็จจริงรายวัน" (จาก RPC hr_attendance_facts)
 * + "กติกา" (จาก hr_score_rules ที่ HR แก้ได้) แล้วคืนรายการเหตุการณ์ที่หัก/ให้คะแนน
 * ไม่แตะ network ไม่แตะ Date.now() — เทสต์ได้ทุกเคส
 *
 * กติกาสำคัญ: หนึ่งวันเกิดเหตุการณ์ได้อย่างละ 1 รายการต่อกลุ่ม (เข้า / ออก / ลา / OT)
 * ไม่หักซ้อน เช่น "ไม่มีเวลาเข้า" กับ "มาสาย" จะไม่เกิดพร้อมกัน
 */

export type ScoreGroupCode = 'attendance' | 'attendance_cumulative' | 'time_entry' | 'leave' | 'ot'
export type DayType = 'work' | 'weekly_off' | 'company_holiday'
export type TimeSource = 'entry' | 'certified'
export type WorkMode = 'office' | 'hybrid' | 'wfh'
/** ขอบเขตการใช้กติกา — วันทำงานนอกสถานที่ (WFH) นับเป็น remote */
export type RuleScope = 'all' | 'onsite' | 'remote'

export interface ScoreCategory {
  id: string
  code: string
  name: string
  description: string | null
  base_points: number
  min_points: number
  weight: number
  is_active: boolean
  sort_order: number
}

export interface ScoreRule {
  id: string
  category_id: string
  group_code: string
  event_code: string
  name: string
  points: number
  /** ความหมายต่างกันตาม event_code — ดู EVENT ต่าง ๆ ด้านล่าง */
  threshold_min: number | null
  threshold_max: number | null
  /** เพดานหักรวมของกติกานี้ต่อเดือน (ค่าบวก) — null = ไม่จำกัด */
  cap_per_month: number | null
  /** กติกานี้ใช้กับวันแบบไหน */
  applies_to: RuleScope
  /**
   * กติกาสะสม: นับเหตุการณ์ในเดือนเดียวกันที่ event_code ขึ้นต้นด้วยค่านี้
   * เกิน threshold_min ครั้ง → หัก points เพิ่มต่อครั้งที่เกิน (null = ไม่ใช่กติกาสะสม)
   */
  counts_event_prefix: string | null
  is_active: boolean
  sort_order: number
}

/** หนึ่งแถว = พนักงาน 1 คน 1 วัน (ตรงกับ RETURNS TABLE ของ hr_attendance_facts) */
export interface AttendanceFact {
  employee_id: string
  employee_code: string
  employee_name: string
  department_id: string | null
  work_date: string
  day_type: DayType
  work_mode: WorkMode
  /** WFH ประจำ หรือ hybrid ที่มีใบ WFH อนุมัติครอบคลุมวันนี้ */
  is_remote_day: boolean
  /** นาทีนับจากเที่ยงคืนของ work_date ตามเวลาไทย */
  expected_start_min: number
  expected_end_min: number
  grace_min: number
  actual_in_min: number | null
  actual_in_source: TimeSource | null
  actual_in_ref: string | null
  actual_out_min: number | null
  actual_out_source: TimeSource | null
  actual_out_ref: string | null
  ot_in_min: number | null
  ot_in_ref: string | null
  ot_request_id: string | null
  ot_request_status: 'approved' | 'pending' | 'rejected' | null
  ot_request_created_date: string | null
  ot_request_created_min: number | null
  leave_id: string | null
  leave_status: 'approved' | 'pending' | null
  leave_mode: 'full_day' | 'hourly' | null
  leave_type_name: string | null
  leave_start_date: string | null
  leave_filed_date: string | null
  leave_filed_min: number | null
  leave_start_min: number | null
  leave_end_min: number | null
}

export interface ScoreEventDraft {
  employee_id: string
  event_date: string
  event_code: string
  rule_id: string
  category_id: string
  group_code: string
  /** ชื่อกติกา ณ ตอนคำนวณ — ใช้แสดงผลโดยไม่ต้อง join กลับ */
  label: string
  points: number
  ref_table: string | null
  ref_id: string | null
  detail: Record<string, unknown>
}

/** กติกาที่ engine อ้างถึงตรง ๆ — เปลี่ยน event_code ในตารางแล้วต้องแก้ที่นี่ด้วย */
export const EVENT = {
  earlyLeave: 'early_leave',
  missingInCertified: 'missing_in_certified',
  missingInUnproven: 'missing_in_unproven',
  missingOutCertified: 'missing_out_certified',
  missingOutUnproven: 'missing_out_unproven',
  leaveApproved: 'leave_approved',
  leaveLateNotice: 'leave_late_notice',
  absentPendingLeave: 'absent_pending_leave',
  absent: 'absent',
  otLateRequest: 'ot_late_request',
  otUnapproved: 'ot_unapproved',
} as const

/** ขอบเขตของวันนี้ ใช้เทียบกับ ScoreRule.applies_to */
export const scopeOfDay = (fact: AttendanceFact): Exclude<RuleScope, 'all'> =>
  fact.is_remote_day ? 'remote' : 'onsite'

/** ขั้นความสายเป็นกติกาในกลุ่ม attendance ที่ event_code ขึ้นต้นด้วย late_ — HR เพิ่มขั้นเองได้ */
const LATE_PREFIX = 'late_'

/** นาทีขั้นต่ำระหว่างเวลาเข้างานถึงเวลาที่กดออก จึงจะเชื่อว่ามาทำงานจริงแต่ลืมกดเข้า */
const DEFAULT_PRESENCE_MIN = 240

/** นาทีที่ออกก่อนเวลาเลิกงานแล้วเริ่มนับว่าผิด */
const DEFAULT_EARLY_LEAVE_GRACE = 1

export type RuleIndex = Map<string, ScoreRule>

export function indexRules(rules: ScoreRule[]): RuleIndex {
  return new Map(rules.filter((r) => r.is_active).map((r) => [r.event_code, r]))
}

/** กติกาที่ใช้กับวันนี้ได้ — ขอบเขตไม่ตรง (เช่นกติกาเฉพาะวันเข้าออฟฟิศ แต่วันนี้ WFH) → undefined */
function ruleFor(rules: RuleIndex, code: string, fact: AttendanceFact): ScoreRule | undefined {
  const rule = rules.get(code)
  if (!rule) return undefined
  return rule.applies_to === 'all' || rule.applies_to === scopeOfDay(fact) ? rule : undefined
}

function draft(
  fact: AttendanceFact,
  rule: ScoreRule,
  detail: Record<string, unknown>,
  ref?: { table: string; id: string | null },
): ScoreEventDraft {
  return {
    employee_id: fact.employee_id,
    event_date: fact.work_date,
    event_code: rule.event_code,
    rule_id: rule.id,
    category_id: rule.category_id,
    group_code: rule.group_code,
    label: rule.name,
    points: rule.points,
    ref_table: ref?.table ?? null,
    ref_id: ref?.id ?? null,
    detail,
  }
}

/** ขั้นความสายที่ตรงกับจำนวนนาที — ไม่มีขั้นไหนครอบคลุม → null (ไม่หัก) */
export function pickLateRule(rules: RuleIndex, lateMin: number, fact: AttendanceFact): ScoreRule | null {
  const scope = scopeOfDay(fact)
  let best: ScoreRule | null = null
  for (const rule of rules.values()) {
    if (rule.group_code !== 'attendance' || !rule.event_code.startsWith(LATE_PREFIX)) continue
    if (rule.applies_to !== 'all' && rule.applies_to !== scope) continue
    const min = rule.threshold_min ?? 1
    const max = rule.threshold_max ?? Number.POSITIVE_INFINITY
    if (lateMin < min || lateMin > max) continue
    // ขั้นที่แคบ/สูงกว่าชนะ เผื่อ HR ตั้งช่วงทับกัน
    if (!best || min > (best.threshold_min ?? 1)) best = rule
  }
  return best
}

/** ใบลารายชั่วโมงครอบคลุมนาทีนี้อยู่หรือไม่ */
function hourlyLeaveCovers(fact: AttendanceFact, minute: number): boolean {
  if (fact.leave_status !== 'approved' || fact.leave_mode !== 'hourly') return false
  if (fact.leave_start_min === null || fact.leave_end_min === null) return false
  return fact.leave_start_min <= minute && minute <= fact.leave_end_min
}

/** แจ้งลาหลังเวลาเริ่มงานของวันแรกที่ลาหรือไม่ */
export function isLateLeaveNotice(fact: AttendanceFact): boolean {
  if (!fact.leave_start_date || !fact.leave_filed_date) return false
  if (fact.leave_filed_date < fact.leave_start_date) return false
  if (fact.leave_filed_date > fact.leave_start_date) return true
  return (fact.leave_filed_min ?? 0) > fact.expected_start_min
}

/** ขอ OT ไว้ก่อนเริ่มทำจริงหรือไม่ */
export function otRequestedBeforeStart(fact: AttendanceFact): boolean {
  if (fact.ot_request_created_date === null || fact.ot_in_min === null) return false
  if (fact.ot_request_created_date < fact.work_date) return true
  if (fact.ot_request_created_date > fact.work_date) return false
  return (fact.ot_request_created_min ?? 0) <= fact.ot_in_min
}

function evaluateOt(fact: AttendanceFact, rules: RuleIndex): ScoreEventDraft[] {
  if (fact.ot_in_min === null) return []
  const ref = { table: 'hr_time_entries', id: fact.ot_in_ref }

  if (fact.ot_request_status !== 'approved') {
    const rule = ruleFor(rules, EVENT.otUnapproved, fact)
    if (!rule) return []
    return [draft(fact, rule, { ot_in_min: fact.ot_in_min, request_status: fact.ot_request_status }, ref)]
  }
  if (!otRequestedBeforeStart(fact)) {
    const rule = ruleFor(rules, EVENT.otLateRequest, fact)
    if (!rule) return []
    return [draft(fact, rule, {
      ot_in_min: fact.ot_in_min,
      requested_at_min: fact.ot_request_created_min,
      requested_date: fact.ot_request_created_date,
    }, ref)]
  }
  return []
}

/** เหตุการณ์ของ "เวลาออกงาน" — แยกออกมาเพราะใช้ทั้งเส้นทางปกติและเส้นทางหัวหน้ารับรองเวลาเข้า */
function evaluateClockOut(fact: AttendanceFact, rules: RuleIndex): ScoreEventDraft[] {
  if (fact.actual_out_min === null) {
    const rule = ruleFor(rules, EVENT.missingOutUnproven, fact)
    return rule ? [draft(fact, rule, {})] : []
  }
  if (fact.actual_out_source === 'certified') {
    const rule = ruleFor(rules, EVENT.missingOutCertified, fact)
    return rule ? [draft(fact, rule, { certified_min: fact.actual_out_min },
      { table: 'hr_time_certifications', id: fact.actual_out_ref })] : []
  }
  const rule = ruleFor(rules, EVENT.earlyLeave, fact)
  if (!rule) return []
  const earlyMin = fact.expected_end_min - fact.actual_out_min
  const threshold = rule.threshold_min ?? DEFAULT_EARLY_LEAVE_GRACE
  if (earlyMin < threshold) return []
  // ลาชั่วโมงที่อนุมัติแล้วครอบคลุมช่วงท้ายวัน = กลับได้ ไม่หัก
  if (hourlyLeaveCovers(fact, fact.expected_end_min - 1)) return []
  return [draft(fact, rule, { early_min: earlyMin, clock_out_min: fact.actual_out_min },
    { table: 'hr_time_entries', id: fact.actual_out_ref })]
}

/**
 * ตัดสินคะแนนของพนักงาน 1 คนใน 1 วัน
 * ลำดับ: OT (คิดได้ทุกวัน) → วันไม่ทำงานจบ → ลาอนุมัติ → ลารออนุมัติ → ขาดงาน → สาย → ออกงาน
 */
export function evaluateDay(fact: AttendanceFact, rules: RuleIndex): ScoreEventDraft[] {
  const events = evaluateOt(fact, rules)
  if (fact.day_type !== 'work') return events

  const hasIn = fact.actual_in_min !== null
  const hasOut = fact.actual_out_min !== null

  // ── ลาเต็มวันที่อนุมัติแล้ว: ไม่ต้องมาทำงาน คิดแค่ว่าแจ้งทันเวลาไหม
  if (fact.leave_status === 'approved' && fact.leave_mode !== 'hourly') {
    const leaveRef = { table: 'hr_leave_requests', id: fact.leave_id }
    const lateRule = isLateLeaveNotice(fact) ? ruleFor(rules, EVENT.leaveLateNotice, fact) : undefined
    if (lateRule) {
      events.push(draft(fact, lateRule, {
        leave_type: fact.leave_type_name,
        filed_date: fact.leave_filed_date,
        filed_min: fact.leave_filed_min,
      }, leaveRef))
    } else {
      const okRule = ruleFor(rules, EVENT.leaveApproved, fact)
      if (okRule) events.push(draft(fact, okRule, { leave_type: fact.leave_type_name }, leaveRef))
    }
    return events
  }

  // ── ไม่มา ทั้งที่ใบลายังไม่อนุมัติ
  if (!hasIn && !hasOut && fact.leave_status === 'pending') {
    const rule = ruleFor(rules, EVENT.absentPendingLeave, fact)
    if (rule) {
      events.push(draft(fact, rule, { leave_type: fact.leave_type_name },
        { table: 'hr_leave_requests', id: fact.leave_id }))
    }
    return events
  }

  // ── ไม่มีเวลาเข้า (และไม่มีใบรับรอง)
  if (!hasIn) {
    const unprovenRule = ruleFor(rules, EVENT.missingInUnproven, fact)
    const presenceMin = unprovenRule?.threshold_min ?? DEFAULT_PRESENCE_MIN
    const workedLongEnough =
      hasOut && (fact.actual_out_min as number) - fact.expected_start_min >= presenceMin
    if (workedLongEnough && unprovenRule) {
      events.push(draft(fact, unprovenRule, { clock_out_min: fact.actual_out_min },
        { table: 'hr_time_entries', id: fact.actual_out_ref }))
      return events
    }
    // ไม่มีทั้งเข้าและออก หรือมีแต่เวลาออกที่สั้นเกินกว่าจะเชื่อว่ามาทำงาน → ขาดงาน
    const absentRule = ruleFor(rules, EVENT.absent, fact)
    if (absentRule) {
      events.push(draft(fact, absentRule, { clock_out_min: fact.actual_out_min }))
    }
    return events
  }

  // ── มีเวลาเข้า (จากบันทึกจริง หรือหัวหน้ารับรอง)
  if (fact.actual_in_source === 'certified') {
    const rule = ruleFor(rules, EVENT.missingInCertified, fact)
    if (rule) {
      events.push(draft(fact, rule, { certified_min: fact.actual_in_min },
        { table: 'hr_time_certifications', id: fact.actual_in_ref }))
    }
  }

  const lateMin = (fact.actual_in_min as number) - (fact.expected_start_min + fact.grace_min)
  if (lateMin > 0 && !hourlyLeaveCovers(fact, fact.expected_start_min)) {
    const lateRule = pickLateRule(rules, lateMin, fact)
    if (lateRule) {
      events.push(draft(fact, lateRule, { late_min: lateMin, clock_in_min: fact.actual_in_min },
        { table: 'hr_time_entries', id: fact.actual_in_ref }))
    }
  }

  events.push(...evaluateClockOut(fact, rules))
  return events
}

export interface ScoreSummary {
  employee_id: string
  base_points: number
  /** ยอดหักจริงหลังใช้เพดานรายเดือน (ค่าบวก) — อาจเกิน base_points */
  raw_deduction: number
  /** ยอดที่ถูกตัดออกเพราะชนเพดานของกติกา */
  capped_amount: number
  /** คะแนนสุทธิ หลังชนพื้น min_points */
  total_points: number
  /** ยอดคะแนนแยกตามหัวข้อย่อย (ค่าติดลบ = หัก) */
  by_group: Record<string, number>
  events: ScoreEventDraft[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * เหตุการณ์เพิ่มจากกติกาสะสม — ทำผิดซ้ำ ๆ ต้องหักหนักขึ้น ไม่ใช่หักเท่าเดิมทุกครั้ง
 * เช่น late_repeat (ยอมให้ 5 ครั้ง หักเพิ่มครั้งละ -2): สาย 8 ครั้ง → เกิดเหตุการณ์เพิ่ม 3 รายการ
 * ลงวันที่ของครั้งที่ 6, 7, 8 (คนละวันเสมอ จึงไม่ชน unique index ของ hr_score_events)
 */
export function applyCumulativeRules(events: ScoreEventDraft[], rules: RuleIndex): ScoreEventDraft[] {
  const cumulative = [...rules.values()].filter((r) => r.counts_event_prefix)
  if (cumulative.length === 0) return []
  // เหตุการณ์ที่กติกาสะสมสร้างขึ้นเอง ห้ามถูกนับซ้ำเป็นฐานของกติกาสะสมอื่น
  const cumulativeCodes = new Set(cumulative.map((r) => r.event_code))

  const extra: ScoreEventDraft[] = []
  for (const rule of cumulative) {
    const prefix = rule.counts_event_prefix as string
    const allowance = rule.threshold_min ?? 0
    const matched = events
      .filter((e) => e.event_code.startsWith(prefix) && !cumulativeCodes.has(e.event_code))
      .sort((a, b) => a.event_date.localeCompare(b.event_date))

    for (let i = allowance; i < matched.length; i++) {
      const source = matched[i]
      extra.push({
        employee_id: source.employee_id,
        event_date: source.event_date,
        event_code: rule.event_code,
        rule_id: rule.id,
        category_id: rule.category_id,
        group_code: rule.group_code,
        label: rule.name,
        points: rule.points,
        ref_table: source.ref_table,
        ref_id: source.ref_id,
        detail: { occurrence: i + 1, allowance, triggered_by: source.event_code },
      })
    }
  }
  return extra
}

/**
 * รวมเหตุการณ์ทั้งเดือนเป็นคะแนนสรุป
 * ลำดับ: เหตุการณ์รายวัน → เติมกติกาสะสม → ใช้เพดานรายกติกา → ชนพื้นของหมวด
 *
 * idempotent: ถ้า input มีเหตุการณ์สะสมติดมาอยู่แล้ว (เช่นส่งผลลัพธ์เดิมกลับเข้ามาพร้อม
 * เหตุการณ์ที่ HR เพิ่มเอง) จะถูกทิ้งแล้วคำนวณใหม่ ไม่หักซ้อนกัน
 */
export function summarizeMonth(
  employeeId: string,
  inputEvents: ScoreEventDraft[],
  category: ScoreCategory,
  rules: RuleIndex,
): ScoreSummary {
  const cumulativeCodes = new Set(
    [...rules.values()].filter((r) => r.counts_event_prefix).map((r) => r.event_code),
  )
  const dailyEvents = inputEvents.filter((e) => !cumulativeCodes.has(e.event_code))
  const events = [...dailyEvents, ...applyCumulativeRules(dailyEvents, rules)]
  const deductionByCode = new Map<string, number>()
  const by_group: Record<string, number> = {}
  let gained = 0

  for (const ev of events) {
    by_group[ev.group_code] = round2((by_group[ev.group_code] ?? 0) + ev.points)
    if (ev.points < 0) {
      deductionByCode.set(ev.event_code, (deductionByCode.get(ev.event_code) ?? 0) + -ev.points)
    } else {
      gained += ev.points
    }
  }

  let deduction = 0
  let capped_amount = 0
  for (const [code, amount] of deductionByCode) {
    const cap = rules.get(code)?.cap_per_month ?? null
    const applied = cap !== null ? Math.min(amount, cap) : amount
    deduction += applied
    capped_amount += amount - applied
  }

  const net = category.base_points + gained - deduction
  return {
    employee_id: employeeId,
    base_points: category.base_points,
    raw_deduction: round2(deduction),
    capped_amount: round2(capped_amount),
    total_points: round2(Math.max(category.min_points, net)),
    by_group,
    events,
  }
}

/** คำนวณคะแนนทั้งเดือนของทุกคนจากข้อเท็จจริงรายวัน */
export function buildMonthlyScores(
  facts: AttendanceFact[],
  category: ScoreCategory,
  rules: ScoreRule[],
): Map<string, ScoreSummary> {
  const index = indexRules(rules.filter((r) => r.category_id === category.id))
  const byEmployee = new Map<string, ScoreEventDraft[]>()
  for (const fact of facts) {
    const list = byEmployee.get(fact.employee_id) ?? []
    list.push(...evaluateDay(fact, index))
    byEmployee.set(fact.employee_id, list)
  }
  const result = new Map<string, ScoreSummary>()
  for (const [employeeId, events] of byEmployee) {
    result.set(employeeId, summarizeMonth(employeeId, events, category, index))
  }
  return result
}

/** 'YYYY-MM' → วันที่ 1 ของเดือน ใช้เป็นคีย์ period */
export const periodStart = (month: string) => `${month}-01`

/** 'YYYY-MM' → วันสุดท้ายของเดือน */
export function monthLastDate(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
}

/**
 * วันสุดท้ายที่ควรคิดคะแนนของเดือนนี้ — null = ยังไม่มีวันที่คิดได้
 *
 * ต้องไม่คิดวันในอนาคต (ยังไม่เกิด จะกลายเป็น "ขาดงาน" ทั้งเดือน) และไม่คิดวันปัจจุบัน
 * ที่ยังไม่จบ (คนที่ยังไม่กดออกงานจะกลายเป็น "ไม่มีเวลาออก") จึงคิดถึงเมื่อวานเป็นอย่างมาก
 */
export function scoringEndDate(month: string, today: string): string | null {
  const first = periodStart(month)
  const yesterday = (() => {
    const d = new Date(`${today}T00:00:00`)
    d.setDate(d.getDate() - 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  const end = yesterday < monthLastDate(month) ? yesterday : monthLastDate(month)
  return end < first ? null : end
}

/** นาทีนับจากเที่ยงคืน → 'HH:MM' (รองรับข้ามเที่ยงคืน เช่น 1470 → '24:30') */
export function minutesToClock(min: number | null | undefined): string {
  if (min === null || min === undefined) return '-'
  const sign = min < 0 ? '-' : ''
  const abs = Math.abs(Math.round(min))
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}
