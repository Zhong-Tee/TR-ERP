import type { HREmployee, HRTask, HRTaskEvaluation, HRTaskStatus } from '../types'

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
