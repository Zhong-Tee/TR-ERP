import type { HRCompanyHoliday, HREmployee, HREmployeeWorkCalendar, HRLeaveRequest, HRTask, HRTaskEvaluation, HRTaskStatus, HRWorkSchedule } from '../types'

export const TASK_ACTIVE_STATUSES: HRTaskStatus[] = ['new', 'acknowledged', 'in_progress', 'review', 'revision']
export const DIMENSIONS = [['speed', 'ความเร็ว'], ['quality', 'คุณภาพ'], ['responsibility', 'ความรับผิดชอบ'], ['communication', 'การสื่อสาร'], ['problem_solving', 'การแก้ปัญหา'], ['teamwork', 'ทำงานเป็นทีม']] as const
export type DimensionKey = (typeof DIMENSIONS)[number][0]

/** คะแนนรวมของผลประเมิน 1 ครั้ง — เฉลี่ยเฉพาะด้านที่มีข้อมูล (ผลประเมินเก่ามีแค่ 4 ด้าน) */
export const evalScore = (ev: HRTaskEvaluation) => {
  const values = DIMENSIONS.map(([key]) => ev[key]).filter((v): v is number => typeof v === 'number')
  return values.reduce((a, b) => a + b, 0) / values.length
}

export const isTaskOverdue = (t: HRTask) => !!t.due_at && TASK_ACTIVE_STATUSES.includes(t.status) && new Date(t.due_at) < new Date()

const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length

/** วันที่แบบ YYYY-MM-DD ตามเวลาท้องถิ่น */
export const localDateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const timeToMin = (t?: string | null): number | null => {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null
}

export interface WorkingTimeData {
  schedules: HRWorkSchedule[]
  /** ตารางวันทำงาน/วันหยุดรายวันของผู้รับผิดชอบ (override) */
  calendar: HREmployeeWorkCalendar[]
  holidays: HRCompanyHoliday[]
  /** วันลาที่อนุมัติแล้วของผู้รับผิดชอบ */
  leaves: HRLeaveRequest[]
}

/**
 * บวกชั่วโมงทำงานจริงจากเวลาเริ่ม โดยนับเฉพาะช่วงเวลางานของพนักงานคนนั้น
 * ข้าม: นอกเวลางาน · วันที่ไม่ใช่วันทำงานตามตาราง · วันหยุดบริษัทฯ · วันลาที่อนุมัติแล้ว
 * ลำดับความสำคัญรายวัน: override ในปฏิทินรายคน > วันหยุดบริษัทฯ > วันทำงานประจำสัปดาห์ของตารางเวลา
 * ไม่มีตารางเวลาเลย หรือหาเวลาว่างไม่ได้ภายใน 1 ปี → ถอยกลับเป็นบวกชั่วโมงตรง ๆ
 */
export function addWorkingHours(from: Date, hours: number, employee: HREmployee | undefined, data: WorkingTimeData): Date {
  const baseSchedule = (employee?.work_schedule_id && data.schedules.find((s) => s.id === employee.work_schedule_id))
    || data.schedules.find((s) => s.is_default) || data.schedules[0]
  if (!baseSchedule || !(hours > 0)) return new Date(from.getTime() + hours * 3600000)
  const overrideByDate = new Map(data.calendar.map((c) => [c.work_date, c]))
  const holidaySet = new Set(data.holidays.map((h) => h.holiday_date))
  const workDaySet = new Set(baseSchedule.work_days.split(',').map(Number))
  let remaining = Math.round(hours * 60)
  const cursor = new Date(from)
  for (let i = 0; i < 370; i++) {
    const key = localDateKey(cursor)
    const override = overrideByDate.get(key)
    const isoDay = cursor.getDay() === 0 ? 7 : cursor.getDay()
    const dayLeaves = data.leaves.filter((l) => l.status === 'approved' && l.start_date <= key && key <= l.end_date)
    let working = override ? override.day_type === 'work' : !holidaySet.has(key) && workDaySet.has(isoDay)
    if (dayLeaves.some((l) => (l.leave_mode ?? 'full_day') === 'full_day')) working = false
    if (working) {
      const daySchedule = (override?.work_schedule_id && data.schedules.find((s) => s.id === override.work_schedule_id)) || baseSchedule
      const startMin = timeToMin(override?.work_start) ?? timeToMin(daySchedule.work_start) ?? 0
      let endMin = timeToMin(override?.work_end) ?? timeToMin(daySchedule.work_end) ?? 24 * 60
      if (endMin <= startMin) endMin = 24 * 60
      let intervals: Array<[number, number]> = [[startMin, endMin]]
      for (const l of dayLeaves) {
        if ((l.leave_mode ?? 'full_day') !== 'hourly') continue
        const blockStart = timeToMin(l.start_time), blockEnd = timeToMin(l.end_time)
        if (blockStart === null || blockEnd === null) continue
        intervals = intervals.flatMap(([a, b]) => ([[a, Math.min(b, blockStart)], [Math.max(a, blockEnd), b]] as Array<[number, number]>).filter(([x, y]) => y > x))
      }
      const dayStartMs = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()).getTime()
      const cursorMin = i === 0 ? from.getHours() * 60 + from.getMinutes() : 0
      for (const [a, b] of intervals) {
        const begin = Math.max(a, cursorMin)
        if (begin >= b) continue
        const available = b - begin
        if (available >= remaining) return new Date(dayStartMs + (begin + remaining) * 60000)
        remaining -= available
      }
    }
    cursor.setHours(0, 0, 0, 0)
    cursor.setDate(cursor.getDate() + 1)
  }
  return new Date(from.getTime() + hours * 3600000)
}

export interface AssigneeReason { text: string; tone: 'good' | 'warn' | 'bad' | 'muted' }
export interface AssigneeSuggestion {
  employee: HREmployee
  /** คะแนนความเหมาะสม 0-100 */
  score: number
  reasons: AssigneeReason[]
  hasHistory: boolean
}

/**
 * จัดอันดับผู้รับผิดชอบที่เหมาะกับงานใหม่ จากประวัติงานที่ผู้ใช้มองเห็น
 * น้ำหนัก: ความถนัดประเภทงาน 40 · คะแนนรวม 15 · ส่งตรงเวลา 20 · ภาระงานปัจจุบัน 25
 * งานเร่งด่วน (กำหนดส่ง < 48 ชม.) จะแบ่งน้ำหนักความถนัด 10 ไปให้ด้านความเร็วแทน
 * ไม่มีข้อมูลด้านไหน ใช้ค่ากลาง (คะแนน 2.5/5, ตรงเวลา 70%) เพื่อไม่ตัดคนใหม่ทิ้ง
 */
export function recommendAssignees({ employees, tasks, evaluations, categoryId, dueAt }: {
  employees: HREmployee[]
  tasks: HRTask[]
  evaluations: HRTaskEvaluation[]
  categoryId?: string
  dueAt?: string
}): AssigneeSuggestion[] {
  const history = tasks.filter((t) => !['draft', 'cancelled'].includes(t.status))
  const taskById = new Map(history.map((t) => [t.id, t]))
  const urgent = !!dueAt && new Date(dueAt).getTime() - Date.now() < 48 * 3600000
  const now = new Date()
  return employees.map((employee): AssigneeSuggestion => {
    const mine = history.filter((t) => t.participants?.some((p) => p.role === 'assignee' && p.employee_id === employee.id))
    const myTaskIds = new Set(mine.map((t) => t.id))
    const myEvals = evaluations.filter((ev) => ev.employee_id === employee.id && myTaskIds.has(ev.task_id))
    const catEvals = categoryId ? myEvals.filter((ev) => taskById.get(ev.task_id)?.category_id === categoryId) : []
    const catTaskCount = categoryId ? mine.filter((t) => t.category_id === categoryId).length : 0
    const overall = myEvals.length ? avg(myEvals.map(evalScore)) : null
    const catAvg = catEvals.length ? avg(catEvals.map(evalScore)) : null
    const active = mine.filter((t) => TASK_ACTIVE_STATUSES.includes(t.status))
    const overdueCount = active.filter((t) => t.due_at && new Date(t.due_at) < now).length
    const finished = mine.filter((t) => t.status === 'completed' && t.due_at && t.completed_at)
    const onTimeRate = finished.length ? Math.round((finished.filter((t) => new Date(t.completed_at!) <= new Date(t.due_at!)).length / finished.length) * 100) : null
    const speeds = myEvals.map((ev) => ev.speed).filter((v): v is number => typeof v === 'number')
    const speedAvg = speeds.length ? avg(speeds) : null

    const fit = catAvg ?? overall
    const raw = (urgent ? 30 : 40) * ((fit ?? 2.5) / 5)
      + 15 * ((overall ?? 2.5) / 5)
      + 20 * ((onTimeRate ?? 70) / 100)
      + 25 * (1 - Math.min(active.length, 4) / 4)
      + (urgent ? 10 * ((speedAvg ?? 2.5) / 5) : 0)
      - Math.min(overdueCount, 2) * 10
    const score = Math.max(0, Math.min(100, Math.round(raw)))

    const reasons: AssigneeReason[] = []
    if (catAvg !== null) reasons.push({ text: `ถนัดประเภทนี้ ${catAvg.toFixed(1)}★`, tone: 'good' })
    else if (categoryId && !catTaskCount) reasons.push({ text: 'ยังไม่เคยทำประเภทนี้', tone: 'muted' })
    if (overall !== null) reasons.push({ text: `คะแนนรวม ${overall.toFixed(1)}★`, tone: overall >= 4 ? 'good' : 'muted' })
    if (onTimeRate !== null) reasons.push({ text: `ส่งตรงเวลา ${onTimeRate}%`, tone: onTimeRate >= 80 ? 'good' : 'warn' })
    reasons.push(active.length === 0 ? { text: 'ว่างรับงานได้', tone: 'good' } : { text: `กำลังทำ ${active.length} งาน`, tone: active.length >= 3 ? 'warn' : 'muted' })
    if (overdueCount) reasons.push({ text: `เลยกำหนด ${overdueCount} งาน`, tone: 'bad' })
    if (urgent && speedAvg !== null && speedAvg >= 4) reasons.push({ text: `ทำงานไว ${speedAvg.toFixed(1)}★`, tone: 'good' })
    if (!mine.length) reasons.push({ text: 'ยังไม่มีประวัติงานในระบบ', tone: 'muted' })
    return { employee, score, reasons, hasHistory: mine.length > 0 }
  }).sort((a, b) => (b.score - a.score) || (Number(b.hasHistory) - Number(a.hasHistory)))
}
