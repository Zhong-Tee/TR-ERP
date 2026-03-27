/**
 * Plan (แผนผลิต – Production Planner)
 * อ้างอิงจาก Order_MS/plan.html – ใช้กับ TR-ERP ผ่าน Supabase
 */
import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { useAuthContext } from '../contexts/AuthContext'
import { useMenuAccess } from '../contexts/MenuAccessContext'
import { supabase } from '../lib/supabase'
import * as XLSX from 'xlsx'
import Modal from '../components/ui/Modal'
import IssueBoard from '../components/order/IssueBoard'
import WorkOrderSelectionList from '../components/order/WorkOrderSelectionList'
import WorkOrderManageList from '../components/order/WorkOrderManageList'
import { isAdminOrSuperadmin } from '../config/accessPolicy'
import { getProductImageUrl } from '../components/wms/wmsUtils'

// --- Types (จาก plan.html) ---
type ViewKey = 'dash' | 'work-orders' | 'work-orders-manage' | 'dept' | 'jobs' | 'form' | 'set' | 'issue'
type ManageSubView = 'new' | 'all'

interface ProcessStep {
  name: string
  type: 'per_piece' | 'fixed'
  value: number
}

interface PlanSettingsData {
  dayStart: string
  dayEnd: string
  departments: string[]
  processes: Record<string, ProcessStep[]>
  prepPerJob: Record<string, number>
  deptBreaks: Record<string, { start: string; end: string }[]>
  linesPerDept: Record<string, number>
  /** หมวดสินค้าที่ผูกกับแผนก (metadata — ไม่ใช้ใน timeline) */
  departmentProductCategories: Record<string, string[]>
}

interface PlanJob {
  id: string
  date: string
  name: string
  /** UUID ของใบงานจริง (กันชื่อซ้ำ) */
  work_order_id?: string | null
  cut: string | null
  qty: Record<string, number>
  tracks: Record<string, Record<string, { start: string | null; end: string | null }>>
  line_assignments: Record<string, number>
  manual_plan_starts?: Record<string, string>
  locked_plans?: Record<string, { start: number; end: number }>
  order_index: number
  created_at?: string
  /** ใบงานถูกยกเลิกการผลิต (บิลถูกย้ายหมดแต่มี timestamp ในแผนแล้ว) */
  is_production_voided?: boolean
}
type DeptQtyByWorkOrderId = Record<string, Record<string, number>>

/** แผนกที่บันทึกเวลาอัตโนมัติ (ไม่ได้กดเริ่ม/เสร็จจากหน้า Plan) */
const AUTO_TRACK_DEPTS: Record<string, string> = {
  'เบิก': 'บันทึกจาก WMS อัตโนมัติ',
  'QC': 'บันทึกจากหน้า QC อัตโนมัติ',
  'PACK': 'บันทึกจากหน้าแพ็คสินค้าอัตโนมัติ',
}

const defaultSettings: PlanSettingsData = {
  dayStart: '09:30',
  dayEnd: '18:30',
  departments: ['เบิก', 'STAMP', 'STK', 'CTT', 'LASER', 'TUBE', 'QC', 'PACK'],
  processes: {
    เบิก: [{ name: 'ดึงกระดาษ/อุปกรณ์', type: 'per_piece', value: 10 }],
    STAMP: [
      { name: 'ออกแบบ', type: 'per_piece', value: 20 },
      { name: 'ยิงหน้ายาง', type: 'per_piece', value: 25 },
      { name: 'รอประกอบ', type: 'fixed', value: 1800 },
      { name: 'ประกอบ', type: 'per_piece', value: 60 },
    ],
    STK: [
      { name: 'ออกแบบ', type: 'per_piece', value: 10 },
      { name: 'ปริ้น', type: 'per_piece', value: 15 },
      { name: 'จัดเรียง', type: 'per_piece', value: 10 },
    ],
    CTT: [
      { name: 'ออกแบบ', type: 'per_piece', value: 20 },
      { name: 'ปริ้น', type: 'per_piece', value: 180 },
      { name: 'จัดเรียง', type: 'per_piece', value: 10 },
    ],
    LASER: [
      { name: 'ออกแบบ', type: 'per_piece', value: 20 },
      { name: 'ยิง', type: 'per_piece', value: 60 },
      { name: 'จัดเรียง', type: 'per_piece', value: 10 },
    ],
    TUBE: [
      { name: 'ออกแบบ', type: 'per_piece', value: 20 },
      { name: 'ปริ้น', type: 'per_piece', value: 60 },
      { name: 'จัดเรียง', type: 'per_piece', value: 10 },
    ],
    QC: [{ name: 'ตรวจสอบความถูกต้อง', type: 'per_piece', value: 20 }],
    PACK: [
      { name: 'ทำใบปะหน้า', type: 'per_piece', value: 20 },
      { name: 'แพ็ค', type: 'per_piece', value: 60 },
    ],
  },
  prepPerJob: { เบิก: 10, STAMP: 10, STK: 10, CTT: 10, LASER: 10, TUBE: 10, QC: 10, PACK: 10 },
  deptBreaks: {
    เบิก: [{ start: '13:00', end: '14:00' }],
    STAMP: [{ start: '13:00', end: '14:00' }],
    STK: [{ start: '13:00', end: '14:00' }],
    CTT: [{ start: '13:00', end: '14:00' }],
    LASER: [{ start: '13:00', end: '14:00' }],
    TUBE: [{ start: '13:00', end: '14:00' }],
    QC: [{ start: '13:00', end: '14:00' }],
    PACK: [{ start: '13:00', end: '14:00' }],
  },
  linesPerDept: { เบิก: 1, STAMP: 1, STK: 1, CTT: 1, LASER: 1, TUBE: 1, QC: 1, PACK: 1 },
  departmentProductCategories: {},
}

// --- Utils ---
const pad = (n: number) => String(Math.floor(n)).padStart(2, '0')
const fmtTime = (secs: number) => {
  const totalMinutes = Math.round(secs / 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return `${h} ชม ${m} นาที`
}
const parseTimeToMin = (t: string | null | undefined): number => {
  if (!t || typeof t !== 'string') return 0
  const parts = t.split(':')
  if (parts.length < 2) return 0
  const [H, M] = parts.map(Number)
  if (Number.isNaN(H) || Number.isNaN(M)) return 0
  return H * 60 + M
}
const minToHHMM = (m: number) => {
  const totalMinutes = Math.floor(m)
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60
  return `${pad(hours)}:${pad(minutes)}`
}
const secToHHMM = (s: number | null | undefined): string => {
  if (s == null || Number.isNaN(s) || s === -Infinity || s === Infinity) return '--:--'
  return minToHHMM(s / 60)
}
const nowISO = () => new Date().toISOString()
const sameDay = (d1: string, d2: string) => d1 === d2
const uid = () => 'J' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)
const fmtLocalHHMM = (iso: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fmtCutTime = (t: string | null | undefined) => {
  if (!t) return '-'
  const raw = String(t).trim()
  // Handle 12-hour format like "1:05 PM" or "01:05 pm"
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])$/)
  if (match) {
    let h = Number(match[1])
    const m = Number(match[2])
    const isPm = match[3].toLowerCase() === 'pm'
    if (isPm && h < 12) h += 12
    if (!isPm && h === 12) h = 0
    return `${pad(h)}:${pad(m)}`
  }
  // Default: take HH:MM from 24h strings
  return raw.length >= 5 ? raw.substring(0, 5) : raw
}

const toISODateTime = (dateStr: string, timeStr: string): string => {
  const safeTime = timeStr && timeStr.length === 5 ? timeStr : '00:00'
  const d = new Date(`${dateStr}T${safeTime}:00`)
  return d.toISOString()
}

function getBaseQty(job: PlanJob, dept: string): number {
  if (dept === 'เบิก') {
    return (Number(job.qty?.['STAMP']) || 0) + (Number(job.qty?.['LASER']) || 0) + (Number(job.qty?.['ETC']) || 0)
  }
  if (dept === 'QC') return Number(job.qty?.['PACK']) || 0
  return Number(job.qty?.[dept]) || 0
}
function getEffectiveQty(
  job: PlanJob,
  dept: string,
  settings: PlanSettingsData,
  deptQtyByWorkOrderId?: DeptQtyByWorkOrderId
): number {
  if (job.is_production_voided) return 0
  const configuredCategories = settings.departmentProductCategories?.[dept] || []
  const workOrderId = job.work_order_id != null ? String(job.work_order_id) : ''
  if (configuredCategories.length > 0 && workOrderId && deptQtyByWorkOrderId) {
    return Number(deptQtyByWorkOrderId[workOrderId]?.[dept] || 0)
  }
  return getBaseQty(job, dept)
}

function getJobStatusForDept(
  job: PlanJob,
  dept: string,
  settings: PlanSettingsData,
  deptQtyByWorkOrderId?: DeptQtyByWorkOrderId
): { text: string; key: 'pending' | 'progress' | 'done' } {
  if (getEffectiveQty(job, dept, settings, deptQtyByWorkOrderId) <= 0) return { text: 'รอดำเนินการ', key: 'pending' }
  const procs = (settings.processes[dept] || []).map((p) => p.name)
  const tracks = job.tracks?.[dept] || {}
  const trackEntries = Object.entries(tracks).filter(([key, t]) => key !== 'เตรียมไฟล์' && !!(t?.start || t?.end))

  // QC/PACK บันทึกอัตโนมัติใช้ชื่อขั้น เริ่ม… / เสร็จแล้ว (ไม่ตรงกับ settings.processes) — ถ้ามี end ที่ขั้น "เสร็จแล้ว" ถือว่า done
  if ((dept === 'QC' || dept === 'PACK') && tracks['เสร็จแล้ว']?.end) {
    return { text: 'เสร็จแล้ว', key: 'done' }
  }

  if (procs.length === 0 && trackEntries.length === 0) return { text: 'รอดำเนินการ', key: 'pending' }

  // เบิก: WMS เคยบันทึกขั้นสุดท้ายเป็น "เสร็จแล้ว" — ถือว่าครบขั้น "ส่งมอบ" ใน settings
  const procHasEnd = (p: string) =>
    !!tracks[p]?.end || (dept === 'เบิก' && p === 'ส่งมอบ' && !!tracks['เสร็จแล้ว']?.end)

  // เช็ค "เสร็จแล้ว": ลอง match ตาม settings ก่อน, fallback ไปดู track entries จริง
  const completedSettingsSteps = procs.filter(procHasEnd).length
  if (procs.length > 0 && completedSettingsSteps === procs.length) return { text: 'เสร็จแล้ว', key: 'done' }
  // Fallback: ถ้าชื่อ process ไม่ตรงกับ settings แต่ track entries ทุกตัวเสร็จแล้ว
  if (completedSettingsSteps === 0 && trackEntries.length > 0 && trackEntries.every(([, t]) => t?.end)) {
    return { text: 'เสร็จแล้ว', key: 'done' }
  }

  // เช็ค "กำลังทำ": มี start ใน tracks ไหม
  if (Object.values(tracks).some((t) => t?.start)) {
    // ลองหาชื่อ step จาก settings ก่อน
    const currentStep = procs.find((p) => tracks[p]?.start && !procHasEnd(p))
    if (currentStep) return { text: currentStep, key: 'progress' }
    // Fallback: หาจาก track entries จริง (กรณีชื่อ process เปลี่ยน)
    const activeEntry = trackEntries.find(([, t]) => t?.start && !t?.end)
    if (activeEntry) return { text: activeEntry[0], key: 'progress' }
    // Fallback สุดท้าย
    const pendingStep = procs.find((p) => !procHasEnd(p))
    return { text: pendingStep || 'กำลังทำ', key: 'progress' }
  }

  return { text: 'รอดำเนินการ', key: 'pending' }
}

function calcPlanFor(
  dept: string,
  job: PlanJob,
  settings: PlanSettingsData,
  deptQtyByWorkOrderId?: DeptQtyByWorkOrderId
): number {
  const q = getEffectiveQty(job, dept, settings, deptQtyByWorkOrderId)
  if (!q) return 0
  let processTotalSec = 0
  ;(settings.processes[dept] || []).forEach((p) => {
    if (p.type === 'per_piece') processTotalSec += (p.value || 0) * q
    else if (p.type === 'fixed') processTotalSec += p.value || 0
  })
  const minSec = (settings.prepPerJob?.[dept] || 0) * 60
  return Math.max(minSec, processTotalSec)
}

// --- Dashboard timeline helpers (จาก plan.html) ---
function getLatestActualEndSecForDept(job: PlanJob, dept: string): number {
  const tmap = job.tracks?.[dept] || {}
  let maxEnd = ''
  Object.values(tmap).forEach((track) => {
    if (track?.end && track.end > maxEnd) maxEnd = track.end
  })
  if (!maxEnd) return 0
  const d = new Date(maxEnd)
  const dayStart = new Date(d)
  dayStart.setHours(0, 0, 0, 0)
  return (d.getTime() - dayStart.getTime()) / 1000
}

function getEarliestActualStartSecForDept(job: PlanJob, dept: string): number {
  const tracks = job.tracks?.[dept] || {}
  let earliestStart = ''
  Object.values(tracks).forEach((track) => {
    if (track?.start && (earliestStart === '' || track.start < earliestStart))
      earliestStart = track.start
  })
  if (!earliestStart) return 0
  const d = new Date(earliestStart)
  const dayStart = new Date(d)
  dayStart.setHours(0, 0, 0, 0)
  return (d.getTime() - dayStart.getTime()) / 1000
}

function getPlannedEndSecForDept(
  dept: string,
  job: PlanJob,
  precomputed: Record<string, { id: string; start: number; end: number; line: number }[]>
): number {
  const tl = precomputed[dept]
  if (!tl) return 0
  const me = tl.find((x) => x.id === job.id)
  return me ? me.end : 0
}

function getEffectiveFinishSec(
  dept: string,
  job: PlanJob,
  precomputed: Record<string, { id: string; start: number; end: number; line: number }[]>
): number {
  const actualEnd = getLatestActualEndSecForDept(job, dept)
  if (actualEnd > 0) return actualEnd
  return getPlannedEndSecForDept(dept, job, precomputed)
}

function adjustForBreaks(
  startSec: number,
  durationSec: number,
  breakPeriodsSec: { start: number; end: number }[]
): { start: number; end: number } {
  let currentStart = startSec
  let endSec = currentStart + durationSec
  let adjusted = true
  while (adjusted) {
    adjusted = false
    for (const b of breakPeriodsSec) {
      if (currentStart >= b.start && currentStart < b.end) {
        currentStart = b.end
        adjusted = true
      }
    }
  }
  endSec = currentStart + durationSec
  for (const b of breakPeriodsSec) {
    if (currentStart < b.start && endSec > b.start) {
      endSec += b.end - b.start
    }
  }
  return { start: currentStart, end: endSec }
}

interface TimelineItem {
  id: string
  start: number
  end: number
  dur: number
  line: number
}

function computePlanTimeline(
  dept: string,
  date: string,
  settings: PlanSettingsData,
  jobs: PlanJob[],
  _anchor: string = 'cut',
  opts: { precomputed?: Record<string, TimelineItem[]>; deptQtyByWorkOrderId?: DeptQtyByWorkOrderId } = {}
): TimelineItem[] {
  const deptQtyByWorkOrderId = opts.deptQtyByWorkOrderId
  const lines = Math.max(1, settings.linesPerDept?.[dept] || 1)
  const dayStartSec = parseTimeToMin(settings.dayStart) * 60
  const breakPeriodsSec = (settings.deptBreaks[dept] || [])
    .map((b) => ({ start: parseTimeToMin(b.start) * 60, end: parseTimeToMin(b.end) * 60 }))
    .sort((a, b) => a.start - b.start)

  const jobsOnDate = jobs
    .filter((j) => sameDay(j.date, date) && getEffectiveQty(j, dept, settings, deptQtyByWorkOrderId) > 0)
    .sort((a, b) => a.order_index - b.order_index)

  const results: TimelineItem[] = []
  const lineLastEnd = new Array(lines).fill(dayStartSec)
  const precomputed = opts.precomputed || {}

  for (const j of jobsOnDate) {
    const lockedPlan = j.locked_plans?.[dept] ?? null
    if (lockedPlan) {
      results.push({
        id: j.id,
        start: lockedPlan.start,
        end: lockedPlan.end,
        dur: lockedPlan.end - lockedPlan.start,
        line: j.line_assignments?.[dept] ?? 0,
      })
      lineLastEnd[j.line_assignments?.[dept] ?? 0] = lockedPlan.end
      continue
    }

    const li = j.line_assignments?.[dept] ?? 0
    const prevJobsOnLine = results.filter((r) => r.line === li)
    let prevEnd = lineLastEnd[li]

    if (prevJobsOnLine.length > 0) {
      const lastRes = prevJobsOnLine[prevJobsOnLine.length - 1]
      const lastJob = jobs.find((jb) => jb.id === lastRes.id)
      const actualLastEnd = lastJob ? getLatestActualEndSecForDept(lastJob, dept) : 0
      prevEnd = actualLastEnd > 0 ? actualLastEnd : lastRes.end
    }

    let stdDuration = calcPlanFor(dept, j, settings, deptQtyByWorkOrderId)
    const cutSec = j.cut ? parseTimeToMin(j.cut) * 60 : -Infinity
    let base = Math.max(prevEnd, Number.isFinite(cutSec) ? cutSec : 0)
    let finalDur = stdDuration

    const delayDepts = ['เบิก', 'TUBE']
    if (delayDepts.includes(dept) && cutSec !== -Infinity) {
      base = Math.max(base, cutSec + 300)
    }
    if (j.manual_plan_starts?.[dept]) {
      base = parseTimeToMin(j.manual_plan_starts[dept]) * 60
    } else {
      if (['STAMP', 'LASER'].includes(dept)) {
        const berkFinishSec = getEffectiveFinishSec('เบิก', j, precomputed)
        if (berkFinishSec > 0) base = Math.max(base, berkFinishSec + 300)
      }
      if (dept === 'QC') {
        const precedingDepts = ['STK', 'CTT', 'TUBE', 'STAMP', 'LASER']
        const finishTimes: number[] = []
        precedingDepts.forEach((preDept) => {
          if (getEffectiveQty(j, preDept, settings, deptQtyByWorkOrderId) > 0) {
            const finishSec = getEffectiveFinishSec(preDept, j, precomputed)
            if (finishSec > 0) finishTimes.push(finishSec)
          }
        })
        if (finishTimes.length > 0) {
          const firstFinish = Math.min(...finishTimes)
          const lastFinish = Math.max(...finishTimes)
          base = Math.max(base, firstFinish + 300)
          const requiredEndTime = lastFinish + stdDuration
          finalDur = Math.max(stdDuration, requiredEndTime - base)
        }
      }
      if (dept === 'PACK') {
        const qcFinishSec = getEffectiveFinishSec('QC', j, precomputed)
        if (qcFinishSec > 0) {
          base = Math.max(base, qcFinishSec + 300)
        }
      }
    }

    const { start, end } = adjustForBreaks(base, finalDur, breakPeriodsSec)
    results.push({ id: j.id, start, end, dur: finalDur, line: li })
    lineLastEnd[li] = end
  }
  return results
}

function getActualTimesForDept(job: PlanJob, dept: string, _settings: PlanSettingsData): { actualStart: string; actualEnd: string; startDayOffset: number; endDayOffset: number } {
  const tracks = job.tracks?.[dept] || {}
  const allEntries = Object.entries(tracks)
  const processEntries = allEntries.filter(([key, t]) => key !== 'เตรียมไฟล์' && !!(t?.start || t?.end))
  if (allEntries.length === 0) return { actualStart: '-', actualEnd: '-', startDayOffset: 0, endDayOffset: 0 }
  let firstStart: Date | null = null
  let lastEnd: Date | null = null
  const allFinished = processEntries.length > 0 && processEntries.every(([, t]) => !!t?.end)
  for (const [, t] of allEntries) {
    if (t?.start) {
      const d = new Date(t.start)
      if (!firstStart || d < firstStart) firstStart = d
    }
  }
  for (const [, t] of processEntries) {
    if (t?.end) {
      const d = new Date(t.end)
      if (!lastEnd || d > lastEnd) lastEnd = d
    }
  }
  const planDateStart = new Date(`${job.date}T00:00:00`)
  const dayDiffStart = firstStart ? Math.floor((firstStart.getTime() - planDateStart.getTime()) / 86400000) : 0
  const dayDiffEnd = (allFinished && lastEnd) ? Math.floor((lastEnd.getTime() - planDateStart.getTime()) / 86400000) : 0
  const actualStart = firstStart ? `${pad(firstStart.getHours())}:${pad(firstStart.getMinutes())}` : '-'
  const actualEnd = allFinished && lastEnd ? `${pad(lastEnd.getHours())}:${pad(lastEnd.getMinutes())}` : '-'
  return { actualStart, actualEnd, startDayOffset: dayDiffStart, endDayOffset: dayDiffEnd }
}

function getOverallJobStatus(
  job: PlanJob,
  settings: PlanSettingsData,
  deptQtyByWorkOrderId?: DeptQtyByWorkOrderId
): { key: 'pending' | 'progress' | 'done' } {
  const relevantDepts = settings.departments.filter((d) => getEffectiveQty(job, d, settings, deptQtyByWorkOrderId) > 0)
  if (relevantDepts.length === 0) return { key: 'pending' }
  const statuses = relevantDepts.map((d) => getJobStatusForDept(job, d, settings, deptQtyByWorkOrderId).key)
  if (statuses.every((s) => s === 'done')) return { key: 'done' }
  if (statuses.some((s) => s === 'progress')) return { key: 'progress' }
  return { key: 'pending' }
}

const PLAN_MENU_KEY_MAP: Record<string, string> = {
  dash: 'plan-dash',
  'work-orders': 'orders-work-orders',
  'work-orders-manage': 'orders-work-orders-manage',
  dept: 'plan-dept',
  jobs: 'plan-jobs',
  form: 'plan-form',
  set: 'plan-set',
  issue: 'plan-issue',
}

const ALL_PLAN_VIEWS: ViewKey[] = ['dash', 'work-orders', 'work-orders-manage', 'dept', 'jobs', 'form', 'set', 'issue']

// แสดงเฉพาะชื่อใบงานจริง เช่น SPTR-250369-R4 (กัน REQ/WY ที่ไม่ใช่ใบงานเข้า Dashboard)
const isWorkOrderDisplayName = (name?: string | null) => /-R\d+$/i.test(String(name || '').trim())

export default function Plan() {
  const { user } = useAuthContext()
  const { hasAccess, menuAccessLoading } = useMenuAccess()
  const unlocked = isAdminOrSuperadmin(user?.role)
  const isSuperadmin = user?.role === 'superadmin'
  const [settings, setSettings] = useState<PlanSettingsData>(defaultSettings)
  const [jobs, setJobs] = useState<PlanJob[]>([])
  const [loading, setLoading] = useState(true)
  const [_dbStatus, setDbStatus] = useState('กำลังโหลด...')
  const [currentView, setCurrentView] = useState<ViewKey>('dash')
  const [issueOpenCount, setIssueOpenCount] = useState(0)
  const [issueWorkOrders, setIssueWorkOrders] = useState<Array<{ work_order_name: string }>>([])
  const [workOrdersCount, setWorkOrdersCount] = useState(0)
  const [manageNewCount, setManageNewCount] = useState(0)
  const [workOrdersManageCount, setWorkOrdersManageCount] = useState(0)
  const [manageSubView, setManageSubView] = useState<ManageSubView>('new')
  const [cancelledByWO, setCancelledByWO] = useState<Record<string, { id: string; bill_no: string; customer_name: string; wo_name?: string }[]>>({})
  const [cancelledDetailWO, setCancelledDetailWO] = useState<string | null>(null) // work_order_id
  const [selectedCancelledOrderId, setSelectedCancelledOrderId] = useState<string | null>(null)
  const [cancelledWmsLines, setCancelledWmsLines] = useState<any[]>([])
  const [cancelledWmsLoading, setCancelledWmsLoading] = useState(false)
  /** บิลที่ย้ายไปใบสั่งงานจากใบงาน (plan_released_from_work_order = ชื่อ WO) */
  const [releasedByWO, setReleasedByWO] = useState<Record<string, { id: string; bill_no: string; customer_name: string; wo_name?: string }[]>>({})
  const [releasedDetailWO, setReleasedDetailWO] = useState<string | null>(null) // work_order_id
  const [selectedReleasedOrderId, setSelectedReleasedOrderId] = useState<string | null>(null)
  const [releasedOrderLines, setReleasedOrderLines] = useState<any[]>([])
  const [releasedLinesLoading, setReleasedLinesLoading] = useState(false)
  const [stockActionLoading, setStockActionLoading] = useState<string | null>(null)
  const [editingJobId, setEditingJobId] = useState<string | null>(null)
  const [dashEdit, setDashEdit] = useState<{
    jobId: string
    dept: string
    field: 'planStart' | 'actualStart' | 'actualEnd'
    value: string
  } | null>(null)

  useEffect(() => {
    if (menuAccessLoading) return
    if (!hasAccess(PLAN_MENU_KEY_MAP[currentView] || currentView)) {
      const first = ALL_PLAN_VIEWS.find((v) => hasAccess(PLAN_MENU_KEY_MAP[v] || v))
      if (first) setCurrentView(first)
    }
  }, [menuAccessLoading])

  // Form state
  const [fDate, setFDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [fName, setFName] = useState('')
  const [fCut, setFCut] = useState('')
  const [fQty, setFQty] = useState<Record<string, number>>({})

  // Filters
  const [dDate, setDDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [depDate, setDepDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [depFilter, setDepFilter] = useState('ALL')
  const [jSearch, setJSearch] = useState('')
  const [jDateFrom, setJDateFrom] = useState(() => new Date().toISOString().split('T')[0])
  const [jDateTo, setJDateTo] = useState(() => new Date().toISOString().split('T')[0])
  const [jChannelFilter, setJChannelFilter] = useState('')
  const [manageDateFrom, setManageDateFrom] = useState(() => new Date().toISOString().split('T')[0])
  const [manageDateTo, setManageDateTo] = useState(() => new Date().toISOString().split('T')[0])
  const [jStatusFilter, setJStatusFilter] = useState('')
  const [jChannels, setJChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [woStatusByName, setWoStatusByName] = useState<Record<string, string>>({})
  const [woStatusById, setWoStatusById] = useState<Record<string, string>>({})
  const [hideCompleted, setHideCompleted] = useState(true)
  const [hideVoided, setHideVoided] = useState(true)
  const [selectedDeptForSettings, setSelectedDeptForSettings] = useState<string>('')
  /** หมวดสินค้าจาก pr_products — ใช้ใน modal ตั้งค่า Plan */
  const [planProductCategories, setPlanProductCategories] = useState<string[]>([])
  /** จำนวนที่คำนวณจากหมวดสินค้า ต่อ work_order_id และแผนก */
  const [deptQtyByWorkOrderId, setDeptQtyByWorkOrderId] = useState<DeptQtyByWorkOrderId>({})
  const [categoryModalDept, setCategoryModalDept] = useState<string | null>(null)
  const [categoryModalDraft, setCategoryModalDraft] = useState<string[]>([])
  const [dashDraggedId, setDashDraggedId] = useState<string | null>(null)
  const [dashDropTarget, setDashDropTarget] = useState<{ id: string; above: boolean } | null>(null)
  const [expandedDeptJob, setExpandedDeptJob] = useState<string | null>(null) // 'dept_jobId' for ประวัติ
  /** Modal ล้าง: ยืนยันล้างเท่านั้น (รหัสปลดล็อคใส่ด้านบน) */
  const [clearStepModal, setClearStepModal] = useState<{
    open: boolean
    jobId: string | null
    dept: string | null
    procName: string
    step: 'confirm' | 'result'
    resultMessage: string
  }>({ open: false, jobId: null, dept: null, procName: '', step: 'confirm', resultMessage: '' })
  const menuCountsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectableDepts = settings.departments.filter((d) => !['เบิก', 'QC', 'PACK'].includes(d))

  useEffect(() => {
    if (depFilter !== 'ALL' && depFilter && !selectableDepts.includes(depFilter)) {
      setDepFilter('ALL')
    }
  }, [depFilter, selectableDepts])

  const load = useCallback(async () => {
    setDbStatus('กำลังโหลด...')
    try {
      const [settingsRes, jobsRes] = await Promise.all([
        supabase.from('plan_settings').select('data').eq('id', 1).single(),
        supabase.from('plan_jobs').select('*').order('order_index'),
      ])
      if (settingsRes.error && settingsRes.error.code !== 'PGRST116') throw new Error('โหลดตั้งค่าไม่สำเร็จ')
      if (jobsRes.error) throw new Error('โหลดใบงานไม่สำเร็จ')
      const loadedSettings = settingsRes.data?.data
        ? { ...defaultSettings, ...settingsRes.data.data }
        : defaultSettings
      setSettings(loadedSettings)
      setJobs((jobsRes.data || []) as PlanJob[])
      setDbStatus('เชื่อมต่อฐานข้อมูลแล้ว')
    } catch (e: any) {
      console.error('Plan load error:', e)
      setDbStatus('โหลดข้อมูลไม่สำเร็จ')
      alert('ไม่สามารถโหลดข้อมูลจากฐานข้อมูลได้!')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (currentView !== 'set') return
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await supabase
          .from('pr_products')
          .select('product_category')
          .eq('is_active', true)
          .not('product_category', 'is', null)
        if (error) throw error
        const categories = Array.from(
          new Set(
            (data || [])
              .map((r: { product_category: string | null }) => r.product_category)
              .filter((c): c is string => !!c && String(c).trim() !== '')
          )
        ).sort((a, b) => a.localeCompare(b))
        if (!cancelled) setPlanProductCategories(categories)
      } catch (e) {
        console.error('Plan: load product categories', e)
        if (!cancelled) setPlanProductCategories([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentView])

  useEffect(() => {
    let cancelled = false
    const selectedByDept = Object.entries(settings.departmentProductCategories || {}).filter(([, categories]) =>
      Array.isArray(categories) && categories.length > 0
    )
    if (selectedByDept.length === 0) {
      setDeptQtyByWorkOrderId({})
      return
    }
    const workOrderIds = Array.from(
      new Set(
        jobs
          .map((j) => (j.work_order_id != null ? String(j.work_order_id) : ''))
          .filter((id) => id !== '')
      )
    )
    if (workOrderIds.length === 0) {
      setDeptQtyByWorkOrderId({})
      return
    }
    ;(async () => {
      try {
        const { data: orders, error: ordersError } = await supabase
          .from('or_orders')
          .select('work_order_id, or_order_items(product_id, quantity)')
          .in('work_order_id', workOrderIds)
        if (ordersError) throw ordersError
        const productIds = Array.from(
          new Set(
            (orders || [])
              .flatMap((o: any) => (o.or_order_items || []).map((i: any) => String(i.product_id || '')))
              .filter((id) => id !== '')
          )
        )
        const productCategoryById: Record<string, string> = {}
        if (productIds.length > 0) {
          const { data: products, error: productsError } = await supabase
            .from('pr_products')
            .select('id, product_category')
            .in('id', productIds)
          if (productsError) throw productsError
          ;(products || []).forEach((p: any) => {
            const id = String(p.id || '')
            const category = String(p.product_category || '').trim()
            if (id && category) productCategoryById[id] = category
          })
        }
        const categoryQtyByWorkOrder: Record<string, Record<string, number>> = {}
        ;(orders || []).forEach((order: any) => {
          const workOrderId = String(order.work_order_id || '')
          if (!workOrderId) return
          categoryQtyByWorkOrder[workOrderId] = categoryQtyByWorkOrder[workOrderId] || {}
          ;(order.or_order_items || []).forEach((item: any) => {
            const productId = String(item.product_id || '')
            const category = productCategoryById[productId]
            if (!category) return
            const rawQty = Number(item.quantity)
            const qty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1
            categoryQtyByWorkOrder[workOrderId][category] = (categoryQtyByWorkOrder[workOrderId][category] || 0) + qty
          })
        })
        const next: DeptQtyByWorkOrderId = {}
        workOrderIds.forEach((workOrderId) => {
          const categoryMap = categoryQtyByWorkOrder[workOrderId] || {}
          next[workOrderId] = {}
          selectedByDept.forEach(([dept, categories]) => {
            const total = (categories as string[]).reduce((sum, category) => sum + (categoryMap[category] || 0), 0)
            next[workOrderId][dept] = total
          })
        })
        if (!cancelled) setDeptQtyByWorkOrderId(next)
      } catch (error) {
        console.error('Plan: load department qty by categories', error)
        if (!cancelled) setDeptQtyByWorkOrderId({})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [jobs, settings.departmentProductCategories])

  useEffect(() => {
    ;(async () => {
      try {
        const { data, error } = await supabase
          .from('or_work_orders')
          .select('id, work_order_name, status')
          .order('created_at', { ascending: false })
        if (error) throw error
        const list = (data || []) as Array<{ id: string; work_order_name: string; status: string }>
        setIssueWorkOrders(list as any)
        // สร้าง map ชื่อใบงาน → สถานะ
        const statusMap: Record<string, string> = {}
        const statusByIdMap: Record<string, string> = {}
        list.forEach((wo) => {
          if (wo.work_order_name && !(wo.work_order_name in statusMap)) {
            statusMap[wo.work_order_name] = wo.status || ''
          }
          if (wo.id && !(wo.id in statusByIdMap)) {
            statusByIdMap[wo.id] = wo.status || ''
          }
        })
        setWoStatusByName(statusMap)
        setWoStatusById(statusByIdMap)
      } catch (error) {
        console.error('Error loading work orders for issues:', error)
      }
    })()
  }, [])

  // โหลดช่องทางสำหรับตัวกรอง ใบงานทั้งหมด
  useEffect(() => {
    ;(async () => {
      try {
        const { data, error } = await supabase
          .from('channels')
          .select('channel_code, channel_name')
          .order('channel_code', { ascending: true })
        if (error) throw error
        setJChannels(data || [])
      } catch (error) {
        console.error('Error loading channels:', error)
      }
    })()
  }, [])

  const loadMenuCounts = useCallback(async () => {
    try {
      const allWorkOrdersQuery = supabase
        .from('or_work_orders')
        .select('id', { count: 'exact', head: true })
      const allWorkOrdersFilteredByChannel = jChannelFilter
        ? allWorkOrdersQuery.like('work_order_name', `${jChannelFilter}-%`)
        : allWorkOrdersQuery
      const allWorkOrdersFilteredByDateFrom = manageDateFrom
        ? allWorkOrdersFilteredByChannel.gte('created_at', `${manageDateFrom}T00:00:00.000Z`)
        : allWorkOrdersFilteredByChannel
      const allWorkOrdersFiltered = manageDateTo
        ? allWorkOrdersFilteredByDateFrom.lte('created_at', `${manageDateTo}T23:59:59.999Z`)
        : allWorkOrdersFilteredByDateFrom

      const [{ count: pumpCount }, { count: otherCount }, { count: manageNew }, { count: manageAll }] = await Promise.all([
        supabase.from('or_orders').select('id', { count: 'exact', head: true })
          .eq('channel_code', 'PUMP')
          .in('status', ['คอนเฟิร์มแล้ว', 'เสร็จสิ้น', 'ย้ายจากใบงาน'])
          .is('work_order_id', null),
        supabase.from('or_orders').select('id', { count: 'exact', head: true })
          .neq('channel_code', 'PUMP')
          .in('status', ['ใบสั่งงาน', 'ย้ายจากใบงาน'])
          .is('work_order_id', null),
        supabase.from('or_work_orders').select('id', { count: 'exact', head: true })
          .eq('status', 'กำลังผลิต'),
        allWorkOrdersFiltered,
      ])
      setWorkOrdersCount((pumpCount ?? 0) + (otherCount ?? 0))
      setManageNewCount(manageNew ?? 0)
      setWorkOrdersManageCount(manageAll ?? 0)
    } catch (e) {
      console.error('Error loading menu counts:', e)
    }
  }, [jChannelFilter, manageDateFrom, manageDateTo])

  useEffect(() => {
    load()
    loadMenuCounts()
  }, [load, loadMenuCounts])

  useEffect(() => {
    const scheduleRefreshMenuCounts = () => {
      if (menuCountsRefreshTimerRef.current) clearTimeout(menuCountsRefreshTimerRef.current)
      menuCountsRefreshTimerRef.current = setTimeout(() => {
        loadMenuCounts()
      }, 400)
    }

    const channel = supabase
      .channel('plan-menu-counts-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, scheduleRefreshMenuCounts)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_work_orders' }, scheduleRefreshMenuCounts)
      .subscribe()

    return () => {
      if (menuCountsRefreshTimerRef.current) clearTimeout(menuCountsRefreshTimerRef.current)
      supabase.removeChannel(channel)
    }
  }, [loadMenuCounts])

  useEffect(() => {
    const channel = supabase
      .channel('plan_jobs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plan_jobs' }, () => {
        supabase
          .from('plan_jobs')
          .select('*')
          .order('order_index')
          .then(({ data }) => data && setJobs(data as PlanJob[]))
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  // โหลดบิลที่มี WMS cancelled และยังไม่ตัดสินใจ stock_action (pending) แยกตามใบงาน
  const loadCancelledOrders = useCallback(async () => {
    try {
      const { data: pendingCancelledRows } = await supabase
        .from('wms_orders')
        .select('work_order_id, source_order_id')
        .eq('status', 'cancelled')
        .is('stock_action', null)
        .not('work_order_id', 'is', null)

      const rows = pendingCancelledRows || []
      if (rows.length === 0) {
        setCancelledByWO({})
        return
      }

      const woToOrderIds = new Map<string, Set<string>>()
      rows.forEach((r: any) => {
        const woId = String(r.work_order_id || '')
        if (!woId) return
        if (!woToOrderIds.has(woId)) woToOrderIds.set(woId, new Set<string>())
        const oid = String(r.source_order_id || '')
        if (oid) woToOrderIds.get(woId)!.add(oid)
      })

      const allOrderIds = [...new Set(rows.map((r: any) => String(r.source_order_id || '')).filter(Boolean))]
      const orderById = new Map<string, { id: string; bill_no: string; customer_name: string }>()
      if (allOrderIds.length > 0) {
        const { data: orders } = await supabase
          .from('or_orders')
          .select('id, bill_no, customer_name')
          .in('id', allOrderIds)
        ;(orders || []).forEach((o: any) => {
          orderById.set(String(o.id), {
            id: String(o.id),
            bill_no: o.bill_no || '-',
            customer_name: o.customer_name || '-',
          })
        })
      }

      const map: Record<string, { id: string; bill_no: string; customer_name: string; wo_name?: string }[]> = {}
      woToOrderIds.forEach((idSet, woId) => {
        const list = [...idSet]
          .map((oid) => orderById.get(oid))
          .filter(Boolean) as { id: string; bill_no: string; customer_name: string }[]
        map[woId] =
          list.length > 0
            ? list
            : [{ id: `__wo__${woId}`, bill_no: 'WMS pending', customer_name: '-' }]
      })
      setCancelledByWO(map)
    } catch (e) {
      console.error('Error loading cancelled orders:', e)
    }
  }, [])

  useEffect(() => { loadCancelledOrders() }, [loadCancelledOrders])

  // Realtime: โหลดใหม่เมื่อ or_orders เปลี่ยน
  useEffect(() => {
    const ch = supabase
      .channel('plan_cancelled_orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => {
        loadCancelledOrders()
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [loadCancelledOrders])

  const loadReleasedOrders = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('or_orders')
        .select('id, bill_no, customer_name, plan_released_from_work_order, plan_released_from_work_order_id')
        .in('status', ['ใบสั่งงาน', 'ย้ายจากใบงาน'])
        .not('plan_released_from_work_order_id', 'is', null)
      if (data) {
        const map: Record<string, { id: string; bill_no: string; customer_name: string; wo_name?: string }[]> = {}
        ;(data as any[]).forEach((o: any) => {
          const woId = String(o.plan_released_from_work_order_id || '')
          if (!woId) return
          if (!map[woId]) map[woId] = []
          map[woId].push({ id: o.id, bill_no: o.bill_no || '-', customer_name: o.customer_name || '-', wo_name: o.plan_released_from_work_order || undefined })
        })
        setReleasedByWO(map)
      }
    } catch (e) {
      console.error('Error loading released orders:', e)
    }
  }, [])

  useEffect(() => {
    loadReleasedOrders()
  }, [loadReleasedOrders])

  useEffect(() => {
    const ch = supabase
      .channel('plan_released_orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => {
        loadReleasedOrders()
      })
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [loadReleasedOrders])

  const loadReleasedOrderLines = useCallback(async (orderId: string) => {
    setReleasedLinesLoading(true)
    setSelectedReleasedOrderId(orderId)
    try {
      const { data } = await supabase
        .from('or_order_items')
        .select('id, product_id, product_name, quantity, unit_price')
        .eq('order_id', orderId)
      const lines = (data || []) as any[]
      const productIds = [...new Set(lines.map((line) => line.product_id).filter(Boolean))]
      let productCodeById: Record<string, string> = {}

      if (productIds.length > 0) {
        const { data: products } = await supabase
          .from('pr_products')
          .select('id, product_code')
          .in('id', productIds)
        productCodeById = (products || []).reduce((acc: Record<string, string>, p: any) => {
          acc[String(p.id)] = String(p.product_code || '')
          return acc
        }, {})
      }

      setReleasedOrderLines(
        lines.map((line) => ({
          ...line,
          product_code: productCodeById[String(line.product_id)] || '',
        }))
      )
    } catch (e) {
      console.error(e)
      setReleasedOrderLines([])
    } finally {
      setReleasedLinesLoading(false)
    }
  }, [])

  const openReleasedBillsModal = useCallback(
    (workOrderId: string) => {
      setReleasedDetailWO(workOrderId)
      const firstId = releasedByWO[workOrderId]?.[0]?.id
      if (firstId) void loadReleasedOrderLines(firstId)
      else {
        setSelectedReleasedOrderId(null)
        setReleasedOrderLines([])
      }
    },
    [releasedByWO, loadReleasedOrderLines]
  )

  const getCancelledOrderProductCodes = useCallback(async (orderId: string): Promise<string[]> => {
    const { data: items } = await supabase
      .from('or_order_items')
      .select('product_id')
      .eq('order_id', orderId)

    const productIds = [...new Set((items || []).map((i: any) => i.product_id).filter(Boolean))]
    if (productIds.length === 0) return []

    const { data: products } = await supabase
      .from('pr_products')
      .select('id, product_code')
      .in('id', productIds)

    return [...new Set((products || []).map((p: any) => String(p.product_code || '').trim()).filter(Boolean))]
  }, [])

  // โหลด WMS lines ที่ถูก cancel และยัง pending การตัดสินใจ stock_action
  const loadCancelledWmsLines = useCallback(async (workOrderId: string, orderId?: string) => {
    setCancelledWmsLoading(true)
    setCancelledDetailWO(workOrderId)
    try {
      const fallbackOrderId = cancelledByWO[workOrderId]?.[0]?.id || null
      const targetOrderId = orderId || fallbackOrderId
      setSelectedCancelledOrderId(targetOrderId)

      if (!targetOrderId) {
        setCancelledWmsLines([])
        return
      }

      const { data: exactData } = await supabase
        .from('wms_orders')
        .select('id, order_id, product_code, product_name, qty, status, stock_action, assigned_to, source_order_id')
        .eq('work_order_id', workOrderId)
        .eq('status', 'cancelled')
        .is('stock_action', null)
      const rows = exactData || []

      const filteredRows =
        targetOrderId && !String(targetOrderId).startsWith('__wo__')
          ? rows.filter((r: any) => String(r.source_order_id || '') === String(targetOrderId))
          : rows
      setCancelledWmsLines(filteredRows)
    } catch (e) {
      console.error('Error loading cancelled WMS lines:', e)
      setCancelledWmsLines([])
    } finally {
      setCancelledWmsLoading(false)
    }
  }, [cancelledByWO])

  const openCancelledBillsModal = useCallback(
    (workOrderId: string) => {
      const firstId = cancelledByWO[workOrderId]?.[0]?.id
      void loadCancelledWmsLines(workOrderId, firstId)
    },
    [cancelledByWO, loadCancelledWmsLines]
  )

  const handleStockAction = useCallback(async (wmsOrderId: string, action: 'recall' | 'waste') => {
    setStockActionLoading(wmsOrderId)
    try {
      if (action === 'recall') {
        const { error } = await supabase.rpc('fn_reverse_wms_stock', { p_wms_order_id: wmsOrderId })
        if (error) throw error
      } else {
        const { error } = await supabase.rpc('rpc_record_cancellation_waste', {
          p_wms_order_id: wmsOrderId,
          p_user_id: user?.id,
        })
        if (error) throw error
      }
      if (cancelledDetailWO && selectedCancelledOrderId) loadCancelledWmsLines(cancelledDetailWO, selectedCancelledOrderId)
      loadCancelledOrders()
    } catch (e: any) {
      alert('ดำเนินการไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setStockActionLoading(null)
    }
  }, [cancelledDetailWO, selectedCancelledOrderId, loadCancelledWmsLines, loadCancelledOrders, user?.id])

  // ฟัง event จาก TopBar เพื่อเปลี่ยนไป view Issue
  useEffect(() => {
    const onNavigateToIssue = () => {
      setCurrentView('issue')
    }
    window.addEventListener('navigate-to-issue', onNavigateToIssue)
    return () => window.removeEventListener('navigate-to-issue', onNavigateToIssue)
  }, [])

  const saveSettings = useCallback(
    async (data: PlanSettingsData) => {
      setDbStatus('กำลังบันทึกตั้งค่า...')
      const { error } = await supabase.from('plan_settings').upsert({ id: 1, data }, { onConflict: 'id' })
      if (error) {
        setDbStatus('บันทึกตั้งค่าล้มเหลว')
        alert('เกิดข้อผิดพลาดในการบันทึกการตั้งค่า!')
      } else {
        setSettings(data)
        setDbStatus('เชื่อมต่อฐานข้อมูลแล้ว')
      }
    },
    []
  )

  const ensureDeptBaseline = useCallback((nextSettings: PlanSettingsData) => {
    const s = {
      ...nextSettings,
      processes: { ...nextSettings.processes },
      prepPerJob: { ...nextSettings.prepPerJob },
      deptBreaks: { ...nextSettings.deptBreaks },
      linesPerDept: { ...nextSettings.linesPerDept },
      departmentProductCategories: { ...(nextSettings.departmentProductCategories || {}) },
    }
    s.departments.forEach((d) => {
      s.processes[d] = s.processes[d] || []
      if (s.prepPerJob[d] == null) s.prepPerJob[d] = 10
      s.deptBreaks[d] = s.deptBreaks[d] || []
      if (s.linesPerDept[d] == null) s.linesPerDept[d] = 1
      if (s.departmentProductCategories[d] == null) s.departmentProductCategories[d] = []
    })
    return s
  }, [])

  const createJobObject = useCallback(
    (data: { date: string; name: string; cut: string | null; qty: Record<string, number> }): PlanJob => {
      const job: PlanJob = {
        id: uid(),
        date: data.date,
        name: data.name.trim(),
        cut: data.cut && String(data.cut).trim() ? String(data.cut).trim() : null,
        qty: data.qty,
        tracks: {},
        line_assignments: {},
        manual_plan_starts: {},
        locked_plans: {},
        order_index: 0,
      }
      settings.departments.forEach((d) => {
        if (getEffectiveQty(job, d, settings) > 0) {
          job.tracks[d] = { 'เตรียมไฟล์': { start: null, end: null } }
          ;(settings.processes[d] || []).forEach((p) => {
            job.tracks[d][p.name] = { start: null, end: null }
          })
          job.line_assignments[d] = 0
        }
      })
      return job
    },
    [settings]
  )

  const addJob = useCallback(async () => {
    if (!fDate || !fName.trim()) {
      alert('กรอก วันที่ และ ชื่อใบงาน')
      return
    }
    const isDuplicate = jobs.some((j) => j.name === fName.trim() && j.date === fDate && j.id !== editingJobId)
    if (isDuplicate) {
      alert(`ตรวจพบบิลซ้ำ: ใบงาน "${fName}" ในวันที่ ${fDate} มีอยู่ในระบบแล้ว`)
      return
    }
    const qty: Record<string, number> = {}
    settings.departments.forEach((d) => {
      qty[d] = Number(fQty[d] ?? 0)
    })
    // Preserve ETC qty for เบิก calculation (ETC is not a visible department)
    if (fQty['ETC']) qty['ETC'] = Number(fQty['ETC'])
    if (editingJobId) {
      const job = jobs.find((j) => j.id === editingJobId)
      if (!job) return
      const updated = { ...job, date: fDate, name: fName.trim(), cut: fCut || null, qty }
      settings.departments.forEach((d) => {
        if (getEffectiveQty(updated, d, settings) > 0) {
          updated.tracks[d] = updated.tracks[d] || { 'เตรียมไฟล์': { start: null, end: null } }
          ;(settings.processes[d] || []).forEach((p) => {
            if (!updated.tracks[d][p.name]) updated.tracks[d][p.name] = { start: null, end: null }
          })
          updated.line_assignments[d] = updated.line_assignments[d] ?? 0
        } else {
          delete updated.tracks[d]
          delete updated.line_assignments[d]
        }
      })
      setDbStatus('กำลังบันทึกการแก้ไข...')
      const { error } = await supabase.from('plan_jobs').update(updated).eq('id', editingJobId).select()
      if (error) {
        alert('เกิดข้อผิดพลาดในการแก้ไขใบงาน')
        setDbStatus('ข้อผิดพลาด')
        return
      }
      setJobs((prev) => prev.map((j) => (j.id === editingJobId ? updated : j)))
      setDbStatus('เชื่อมต่อฐานข้อมูลแล้ว')
      setEditingJobId(null)
      setFName('')
      setFCut('')
      setFQty({})
      setCurrentView('jobs')
      return
    }
    const maxOrderIndex = jobs.length > 0 ? Math.max(...jobs.map((j) => j.order_index)) : -1
    const newJob = createJobObject({ date: fDate, name: fName.trim(), cut: fCut || null, qty })
    newJob.order_index = maxOrderIndex + 1
    setDbStatus('กำลังเพิ่มใบงาน...')
    // สร้าง row ให้ครบทุกคอลัมน์ใน plan_jobs ก่อน insert
    const row = {
      id: newJob.id,
      date: newJob.date,
      name: newJob.name,
      cut: newJob.cut,
      qty: newJob.qty ?? {},
      tracks: newJob.tracks ?? {},
      line_assignments: newJob.line_assignments ?? {},
      manual_plan_starts: newJob.manual_plan_starts ?? {},
      locked_plans: newJob.locked_plans ?? {},
      order_index: newJob.order_index,
    }
    const { error } = await supabase.from('plan_jobs').insert([row])
    if (error) {
      alert('เกิดข้อผิดพลาดในการเพิ่มใบงาน')
      setDbStatus('ข้อผิดพลาด')
      return
    }
    setJobs((prev) => [...prev, newJob])
    setDbStatus('เชื่อมต่อฐานข้อมูลแล้ว')
    setFName('')
    setFCut('')
    setFQty({})
    setCurrentView('jobs')
  }, [fDate, fName, fCut, fQty, jobs, settings, createJobObject, editingJobId])

  const updateJobField = useCallback(async (jobId: string, updates: Partial<PlanJob>) => {
    setDbStatus('กำลังอัปเดต...')
    const { error } = await supabase.from('plan_jobs').update(updates).eq('id', jobId).select()
    if (error) {
      setDbStatus('อัปเดตล้มเหลว')
      alert('บันทึกข้อมูลไม่สำเร็จ! ' + error.message)
    } else {
      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, ...updates } : j))
      )
      setDbStatus('เชื่อมต่อฐานข้อมูลแล้ว')
    }
  }, [])

  const startDashEdit = useCallback(
    (jobId: string, dept: string, field: 'planStart' | 'actualStart' | 'actualEnd', value: string) => {
      if (!unlocked) return
      const cleaned = value === '-' || value === '--:--' ? '' : value
      setDashEdit({ jobId, dept, field, value: cleaned })
    },
    [unlocked]
  )

  const saveDashEdit = useCallback(
    async (job: PlanJob, dept: string, field: 'planStart' | 'actualStart' | 'actualEnd') => {
      if (!dashEdit) return
      const raw = dashEdit.value.trim()
      setDashEdit(null)
      if (raw && !/^\d{2}:\d{2}$/.test(raw)) {
        alert('รูปแบบเวลาไม่ถูกต้อง (HH:MM)')
        return
      }
      if (field === 'planStart') {
        const manual = { ...(job.manual_plan_starts || {}) }
        if (raw) manual[dept] = raw
        else delete manual[dept]
        const locked = { ...(job.locked_plans || {}) }
        delete locked[dept]
        await updateJobField(job.id, { manual_plan_starts: manual, locked_plans: locked })
        return
      }

      const procs = (settings.processes[dept] || []).map((p) => p.name)
      const iso = raw ? toISODateTime(job.date, raw) : null
      const patch: Record<string, Record<string, string | null>> = {}
      procs.forEach((p) => {
        if (field === 'actualStart') {
          patch[p] = { start: iso }
        } else {
          patch[p] = iso ? { start_if_null: iso, end: iso } : { end: null }
        }
      })
      setDbStatus('กำลังอัปเดต...')
      const { data: newTracks, error } = await supabase.rpc('merge_plan_tracks', {
        p_job_id: job.id,
        p_dept: dept,
        p_patch: patch,
      })
      if (error) {
        setDbStatus('อัปเดตล้มเหลว')
        alert('บันทึกข้อมูลไม่สำเร็จ! ' + error.message)
        return
      }
      if (field === 'actualStart' && !iso && job.locked_plans?.[dept]) {
        const newLocked = { ...(job.locked_plans || {}) }
        delete newLocked[dept]
        await supabase.from('plan_jobs').update({ locked_plans: newLocked }).eq('id', job.id)
        setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, tracks: newTracks, locked_plans: newLocked } : j)))
      } else {
        setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, tracks: newTracks } : j)))
      }
      setDbStatus('เชื่อมต่อฐานข้อมูลแล้ว')
    },
    [dashEdit, settings.processes, updateJobField]
  )

  const markStart = useCallback(
    async (jobId: string, dept: string, proc: string) => {
      const job = jobs.find((j) => j.id === jobId)
      if (!job) return
      const t = job.tracks?.[dept]?.[proc]
      if (t?.start && !window.confirm('มีเวลาเริ่มอยู่แล้ว ต้องการแทนที่?')) return
      const now = nowISO()
      const firstProc = (settings.processes[dept] || [])[0]?.name
      const patch: Record<string, Record<string, string>> = {
        [proc]: { start: now },
      }
      // เมื่อเริ่มหัวข้อแรก ให้ stamp "เตรียมไฟล์" ทันทีด้วย (ถ้ายังไม่มีเวลา)
      if (firstProc && proc === firstProc) {
        patch['เตรียมไฟล์'] = { start_if_null: now }
      }
      setDbStatus('กำลังอัปเดต...')
      const { data: newTracks, error } = await supabase.rpc('merge_plan_tracks', {
        p_job_id: jobId,
        p_dept: dept,
        p_patch: patch,
      })
      if (error) {
        setDbStatus('อัปเดตล้มเหลว')
        alert('บันทึกข้อมูลไม่สำเร็จ! ' + error.message)
        return
      }
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, tracks: newTracks } : j)))
      setDbStatus('เชื่อมต่อฐานข้อมูลแล้ว')
    },
    [jobs, settings.processes]
  )

  const markEnd = useCallback(
    async (jobId: string, dept: string, proc: string) => {
      const job = jobs.find((j) => j.id === jobId)
      if (!job) return
      const t = job.tracks?.[dept]?.[proc]
      if (!t?.start && !window.confirm('ยังไม่กดเริ่ม จะบันทึกเสร็จเลยหรือไม่?')) return
      const now = nowISO()
      setDbStatus('กำลังอัปเดต...')
      const { data: newTracks, error } = await supabase.rpc('merge_plan_tracks', {
        p_job_id: jobId,
        p_dept: dept,
        p_patch: { [proc]: { start_if_null: now, end: now } },
      })
      if (error) {
        setDbStatus('อัปเดตล้มเหลว')
        alert('บันทึกข้อมูลไม่สำเร็จ! ' + error.message)
        return
      }
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, tracks: newTracks } : j)))
      setDbStatus('เชื่อมต่อฐานข้อมูลแล้ว')
    },
    [jobs]
  )

  const backStep = useCallback(
    async (jobId: string, dept: string, opts?: { skipConfirm?: boolean }) => {
      const job = jobs.find((j) => j.id === jobId)
      if (!job) return
      const skipConfirm = opts?.skipConfirm === true
      const procs = (settings.processes[dept] || []).map((p) => p.name)
      const tracks = job.tracks?.[dept] || {}
      let currentIndex = procs.findIndex((p) => !tracks[p]?.end)

      let patch: Record<string, Record<string, string | null>> | null = null

      if (currentIndex === -1 && procs.length > 0) {
        const lastProc = procs[procs.length - 1]
        if (!skipConfirm && !window.confirm(`ยกเลิกการเสร็จสิ้นของขั้นตอน "${lastProc}"?`)) return
        patch = { [lastProc]: { end: null } }
      } else if (currentIndex >= 0) {
        const currentProc = procs[currentIndex]
        const t = tracks[currentProc] || { start: null, end: null }
        if (t.start) {
          if (!skipConfirm && !window.confirm(`ล้างเวลาเริ่มของขั้นตอน "${currentProc}"?`)) return
          patch = { [currentProc]: { start: null, end: null } }
        } else if (currentIndex > 0) {
          const prevProc = procs[currentIndex - 1]
          if (!skipConfirm && !window.confirm(`ย้อนกลับไปแก้ไขขั้นตอนก่อนหน้า "${prevProc}"?`)) return
          patch = { [prevProc]: { end: null } }
        }
      }

      if (!patch) return
      setDbStatus('กำลังอัปเดต...')
      const { data: newTracks, error } = await supabase.rpc('merge_plan_tracks', {
        p_job_id: jobId,
        p_dept: dept,
        p_patch: patch,
      })
      if (error) {
        setDbStatus('อัปเดตล้มเหลว')
        alert('บันทึกข้อมูลไม่สำเร็จ! ' + error.message)
        return
      }
      const deptTracks = newTracks?.[dept] || {}
      const stillHasStart = Object.entries(deptTracks)
        .filter(([key]) => key !== 'เตรียมไฟล์')
        .some(([, t]: [string, any]) => t?.start)

      if (!stillHasStart && job.locked_plans?.[dept]) {
        const newLocked = { ...(job.locked_plans || {}) }
        delete newLocked[dept]
        await supabase.from('plan_jobs').update({ locked_plans: newLocked }).eq('id', jobId)
        setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, tracks: newTracks, locked_plans: newLocked } : j)))
      } else {
        setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, tracks: newTracks } : j)))
      }
      setDbStatus('เชื่อมต่อฐานข้อมูลแล้ว')
    },
    [jobs, settings]
  )

  const deleteJob = useCallback(async (job: PlanJob) => {
    if (!window.confirm(`ลบใบงาน "${job.name}"?`)) return
    setDbStatus('กำลังลบ...')
    const { error } = await supabase.from('plan_jobs').delete().eq('id', job.id)
    if (error) {
      alert('เกิดข้อผิดพลาดในการลบ')
      setDbStatus('ลบไม่สำเร็จ')
      return
    }
    setJobs((prev) => prev.filter((j) => j.id !== job.id))
    setDbStatus('เชื่อมต่อฐานข้อมูลแล้ว')
  }, [])


  const scopedJobs = jobs
    .filter((j) => !!j.work_order_id)
    .filter((j) => isWorkOrderDisplayName(j.name))
    .filter((j) => {
      if (!hideVoided) return true
      const wid = String(j.work_order_id || '')
      if (j.is_production_voided) return false
      if (wid && woStatusById[wid] === 'ยกเลิก') return false
      return true
    })

  const dayJobs = scopedJobs
    .filter((j) => sameDay(j.date, dDate))
    .sort((a, b) => a.order_index - b.order_index)

  const dashTimelines = (() => {
    const computationOrder = ['เบิก', 'STK', 'CTT', 'TUBE', 'STAMP', 'LASER', 'QC', 'PACK']
    const allDepts = settings.departments
    const orderedDepts = [...new Set([...computationOrder, ...allDepts])]
    const timelines: Record<string, TimelineItem[]> = {}
    orderedDepts.forEach((d) => {
      if (allDepts.includes(d)) {
        timelines[d] = computePlanTimeline(d, dDate, settings, scopedJobs, 'cut', {
          precomputed: timelines,
          deptQtyByWorkOrderId,
        })
      }
    })
    return timelines
  })()

  const autoLockInFlight = useRef(false)
  useEffect(() => {
    if (autoLockInFlight.current) return

    const dj = scopedJobs
      .filter((j) => sameDay(j.date, dDate))
      .sort((a, b) => a.order_index - b.order_index)

    const computationOrder = ['เบิก', 'STK', 'CTT', 'TUBE', 'STAMP', 'LASER', 'QC', 'PACK']
    const allDepts = settings.departments
    const orderedDepts = [...new Set([...computationOrder, ...allDepts])]
    const tl: Record<string, TimelineItem[]> = {}
    orderedDepts.forEach((d) => {
      if (allDepts.includes(d)) {
        tl[d] = computePlanTimeline(d, dDate, settings, scopedJobs, 'cut', {
          precomputed: tl,
          deptQtyByWorkOrderId,
        })
      }
    })

    const updates: { jobId: string; locked: Record<string, { start: number; end: number }> }[] = []

    for (const j of dj) {
      const newLocked = { ...(j.locked_plans || {}) }
      let changed = false

      for (const d of allDepts) {
        if (newLocked[d]) continue
        const tracks = j.tracks?.[d] || {}
        const hasStart = Object.entries(tracks)
          .filter(([key]) => key !== 'เตรียมไฟล์')
          .some(([, t]) => t?.start)
        if (!hasStart) continue

        const me = tl[d]?.find((x) => x.id === j.id)
        if (!me) continue

        newLocked[d] = { start: me.start, end: me.end }
        changed = true
      }

      if (changed) updates.push({ jobId: j.id, locked: newLocked })
    }

    if (updates.length === 0) return

    autoLockInFlight.current = true
    Promise.all(
      updates.map(({ jobId, locked }) =>
        supabase.from('plan_jobs').update({ locked_plans: locked }).eq('id', jobId)
      )
    )
      .then(() => {
        setJobs((prev) =>
          prev.map((job) => {
            const upd = updates.find((u) => u.jobId === job.id)
            return upd ? { ...job, locked_plans: upd.locked } : job
          })
        )
      })
      .finally(() => {
        autoLockInFlight.current = false
      })
  }, [scopedJobs, dDate, settings, deptQtyByWorkOrderId])

  const filteredJobs = scopedJobs
    .filter((j) => !jSearch.trim() || j.name.toLowerCase().includes(jSearch.toLowerCase()))
    .filter((j) => !jDateFrom || j.date >= jDateFrom)
    .filter((j) => !jDateTo || j.date <= jDateTo)
    .filter((j) => (hideVoided ? !j.is_production_voided : true))
    .filter((j) => {
      if (!jChannelFilter) return true
      const prefixMap: Record<string, string> = { OFFICE: 'OF' }
      const prefix = prefixMap[jChannelFilter.toUpperCase()] || jChannelFilter
      return j.name.toUpperCase().startsWith(prefix.toUpperCase() + '-')
    })
    .filter((j) => {
      if (!jStatusFilter) return true
      const woStatus = woStatusByName[j.name] || ''
      return woStatus === jStatusFilter
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.order_index - b.order_index)

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    )
  }

  return (
    <div className="w-full flex flex-col min-h-0 h-full flex-1">
      {/* เมนูย่อย — fixed ชิด TopBar เต็มซ้ายขวา (ไม่มี transition เพื่อแสดงทันที) */}
      <div
        className="fixed top-16 right-0 z-30 bg-white border-b border-surface-200 shadow-soft"
        style={{ left: 'var(--content-offset-left, 16rem)' }}
      >
        <div className="w-full px-4 sm:px-6 lg:px-8 overflow-x-auto scrollbar-thin">
          <div className="flex items-center justify-between gap-4">
            <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3" aria-label="Tabs">
              {(
                [
                  ['dash', 'Dashboard (Master Plan)'],
                  ['work-orders', `ใบสั่งงาน (${workOrdersCount})`],
                  ['work-orders-manage', `จัดการใบงาน (${workOrdersManageCount})`],
                  ['dept', 'หน้าแผนก (คิวงาน)'],
                  ['jobs', 'ใบงานทั้งหมด'],
                  ['form', 'สร้าง/แก้ไขใบงาน'],
                  ['set', 'ตั้งค่า'],
                  ['issue', `Issue (${issueOpenCount})`],
                ] as [ViewKey, string][]
              ).filter(([key]) => hasAccess(PLAN_MENU_KEY_MAP[key] || key)).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCurrentView(key)}
                  className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap flex-shrink-0 transition-colors ${
                    currentView === key
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-blue-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span
                className={`rounded-full px-3 py-2 text-sm font-semibold ${
                  unlocked ? 'bg-green-100 text-green-800 border border-green-300' : 'bg-red-100 text-red-800 border border-red-300'
                }`}
              >
                {unlocked ? '🔓 แก้ไขได้' : '🔒 ดูอย่างเดียว'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="pt-16 space-y-4">
      {/* View: Form สร้าง/แก้ไขใบงาน */}
      {currentView === 'form' && (
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <h2 className="border-b border-gray-200 px-4 py-3 text-lg font-semibold">สร้าง/แก้ไข ใบงาน</h2>
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm text-gray-500 mb-1">วันที่</label>
                <input
                  type="date"
                  value={fDate}
                  onChange={(e) => setFDate(e.target.value)}
                  disabled={!unlocked}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-500 mb-1">ชื่อใบงาน</label>
                <input
                  type="text"
                  value={fName}
                  onChange={(e) => setFName(e.target.value)}
                  placeholder="เช่น SPTR 24-09 R1"
                  disabled={!unlocked}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-500 mb-1">เวลาตัดใบงาน</label>
                <input
                  type="time"
                  value={fCut}
                  onChange={(e) => setFCut(e.target.value)}
                  disabled={!unlocked}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {settings.departments.map((d) => (
                <div key={d}>
                  <label className="block text-sm text-gray-500 mb-1">{d} (ชิ้น)</label>
                  <input
                    type="number"
                    min={0}
                    value={fQty[d] ?? 0}
                    onChange={(e) => setFQty((prev) => ({ ...prev, [d]: Number(e.target.value) || 0 }))}
                    disabled={!unlocked}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2"
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={addJob}
                disabled={!unlocked}
                className="rounded-lg bg-blue-600 px-4 py-2 text-white font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {editingJobId ? 'บันทึกการแก้ไข' : 'เพิ่มใบงาน'}
              </button>
              {editingJobId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingJobId(null)
                    setFName('')
                    setFCut('')
                    setFQty({})
                    setCurrentView('jobs')
                  }}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 hover:bg-gray-50"
                >
                  ยกเลิก
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setFName('')
                  setFCut('')
                  setFQty({})
                  setEditingJobId(null)
                }}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 hover:bg-gray-50"
              >
                ล้างแบบฟอร์ม
              </button>
            </div>
            <p className="text-xs text-gray-500">
              * ปริมาณ 0 หมายถึงไม่ลงคิวในแผนกนั้น (ยกเว้นแผนก "เบิก" จะดึงจาก STAMP+LASER)
            </p>
          </div>
        </section>
      )}

      {/* View: ใบงานทั้งหมด */}
      {currentView === 'jobs' && (
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <h2 className="border-b border-gray-200 px-4 py-3 text-lg font-semibold">ใบงานทั้งหมด (ค้นหา/แก้ไข/ลบ)</h2>
          <div className="p-4 space-y-4">
            <div className="bg-gray-50 p-4 rounded-2xl shadow-sm border border-gray-200">
              <div className="flex flex-wrap gap-3 items-end">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">ช่องทาง</label>
                  <select
                    value={jChannelFilter}
                    onChange={(e) => setJChannelFilter(e.target.value)}
                    className="px-3 py-2.5 border border-gray-300 rounded-xl bg-white text-base"
                  >
                    <option value="">ทั้งหมด</option>
                    {jChannels.map((ch) => (
                      <option key={ch.channel_code} value={ch.channel_code}>
                        {ch.channel_name || ch.channel_code}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">สถานะ</label>
                  <select
                    value={jStatusFilter}
                    onChange={(e) => setJStatusFilter(e.target.value)}
                    className="px-3 py-2.5 border border-gray-300 rounded-xl bg-white text-base"
                  >
                    <option value="">ทั้งหมด</option>
                    <option value="กำลังผลิต">กำลังผลิต</option>
                    <option value="จัดส่งแล้ว">จัดส่งแล้ว</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">จากวันที่</label>
                  <input
                    type="date"
                    value={jDateFrom}
                    onChange={(e) => setJDateFrom(e.target.value)}
                    className="px-3 py-2.5 border border-gray-300 rounded-xl bg-white text-base"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">ถึงวันที่</label>
                  <input
                    type="date"
                    value={jDateTo}
                    onChange={(e) => setJDateTo(e.target.value)}
                    className="px-3 py-2.5 border border-gray-300 rounded-xl bg-white text-base"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">ค้นหาชื่อ</label>
                  <input
                    type="text"
                    value={jSearch}
                    onChange={(e) => setJSearch(e.target.value)}
                    placeholder="พิมพ์บางส่วนของชื่อ"
                    className="w-48 px-3 py-2.5 border border-gray-300 rounded-xl bg-white text-base"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setJSearch('')
                    setJDateFrom(new Date().toISOString().split('T')[0])
                    setJDateTo(new Date().toISOString().split('T')[0])
                    setJChannelFilter('')
                    setJStatusFilter('')
                  }}
                  className="rounded-xl border border-gray-300 bg-gray-100 px-4 py-2.5 font-medium hover:bg-gray-200 text-base"
                >
                  ล้างตัวกรอง
                </button>
              </div>
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="min-w-full text-base table-fixed">
                <colgroup>
                  <col className="w-[15%]" />
                  <col className="w-[10%]" />
                  <col className="w-[7%]" />
                  <col className="w-[40%]" />
                  <col className="w-[12%]" />
                  <col className="w-[16%]" />
                </colgroup>
                <thead className="bg-blue-600 text-white sticky top-0">
                  <tr>
                    <th className="p-4 text-left font-semibold">ชื่อใบงาน</th>
                    <th className="p-4 text-left font-semibold">วันที่</th>
                    <th className="p-4 text-left font-semibold">เวลาตัด</th>
                    <th className="p-4 text-left font-semibold">จำนวนต่อแผนก</th>
                    <th className="p-4 text-left font-semibold">สถานะ</th>
                    <th className="p-4 text-left font-semibold">จัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs.map((j, idx) => {
                    const deptColorMap: Record<string, string> = {
                      PACK: 'bg-blue-100 text-blue-700 border-blue-300',
                      STAMP: 'bg-purple-100 text-purple-700 border-purple-300',
                      SEW: 'bg-pink-100 text-pink-700 border-pink-300',
                      CUT: 'bg-orange-100 text-orange-700 border-orange-300',
                      PRINT: 'bg-green-100 text-green-700 border-green-300',
                      HEAT: 'bg-red-100 text-red-700 border-red-300',
                      EMB: 'bg-yellow-100 text-yellow-700 border-yellow-300',
                      FOLD: 'bg-teal-100 text-teal-700 border-teal-300',
                    }
                    const woStatus = woStatusByName[j.name] || ''
                    return (
                    <tr key={j.id} className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      <td className="p-4 font-semibold text-gray-900 whitespace-nowrap">
                        {j.name}
                        {j.is_production_voided && (
                          <span
                            className="ml-2 px-2 py-0.5 text-xs font-bold rounded-full bg-orange-100 text-orange-800 border border-orange-300"
                            title="บิลถูกย้ายออกจากใบงานหมดแล้ว แต่แผนเคยเริ่ม — ปริมาณในแผนถือเป็น 0"
                          >
                            ยกเลิกใบงาน
                          </span>
                        )}
                        {(releasedByWO[String(j.work_order_id || '')]?.length ?? 0) > 0 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (j.work_order_id) openReleasedBillsModal(String(j.work_order_id))
                            }}
                            className="ml-2 px-2 py-0.5 text-xs font-bold rounded-full bg-blue-100 text-blue-800 border border-blue-300 hover:bg-blue-200 transition"
                          >
                            แก้ไข {releasedByWO[String(j.work_order_id || '')].length}
                          </button>
                        )}
                        {(cancelledByWO[String(j.work_order_id || '')]?.length ?? 0) > 0 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (j.work_order_id) openCancelledBillsModal(String(j.work_order_id))
                            }}
                            className="ml-2 px-2 py-0.5 text-xs font-bold rounded-full bg-red-100 text-red-700 border border-red-300 hover:bg-red-200 transition"
                          >
                            ยกเลิก {cancelledByWO[String(j.work_order_id || '')].length}
                          </button>
                        )}
                      </td>
                      <td className="p-4 text-gray-700 whitespace-nowrap">{j.date}</td>
                      <td className="p-4 text-gray-700 whitespace-nowrap">{fmtCutTime(j.cut)}</td>
                      <td className="p-4">
                        <div className="flex flex-wrap gap-1.5">
                          {settings.departments.map((d) => {
                            const q = j.qty?.[d] || 0
                            const colorClass = deptColorMap[d.toUpperCase()] || 'bg-gray-100 text-gray-700 border-gray-300'
                            return q > 0 ? (
                              <span key={d} className={`rounded-full border px-2.5 py-1 text-xs font-bold ${colorClass}`}>
                                {d}: {q}
                              </span>
                            ) : null
                          })}
                        </div>
                      </td>
                      <td className="p-4">
                        {woStatus ? (
                          <span
                            className={`inline-flex px-3 py-1.5 rounded-full text-xs font-bold ${
                              woStatus === 'กำลังผลิต'
                                ? 'bg-amber-500 text-white'
                                : woStatus === 'จัดส่งแล้ว'
                                ? 'bg-green-500 text-white'
                                : 'bg-gray-200 text-gray-700'
                            }`}
                          >
                            {woStatus}
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="p-4">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingJobId(j.id)
                            setFDate(j.date)
                            setFName(j.name)
                            setFCut(j.cut || '')
                            setFQty(j.qty || {})
                            setCurrentView('form')
                          }}
                          disabled={!unlocked}
                          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 mr-1.5"
                        >
                          แก้ไข
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteJob(j)}
                          disabled={!unlocked}
                          className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          ลบ
                        </button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {filteredJobs.length === 0 && (
              <p className="text-center text-gray-500 py-8">ไม่มีใบงานตามตัวกรอง</p>
            )}
          </div>
        </section>
      )}

      {currentView === 'issue' && (
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="p-4">
            <IssueBoard scope="plan" workOrders={issueWorkOrders} onOpenCountChange={setIssueOpenCount} />
          </div>
        </section>
      )}

      {currentView === 'work-orders' && (
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="p-4">
            <WorkOrderSelectionList
              channelFilter={jChannelFilter}
              onCountChange={setWorkOrdersCount}
            />
          </div>
        </section>
      )}

      {currentView === 'work-orders-manage' && (
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="p-4 space-y-4">
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-3">
              <button
                type="button"
                onClick={() => setManageSubView('new')}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
                  manageSubView === 'new'
                    ? 'bg-blue-600 text-white shadow'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                ใบงานใหม่ ({manageNewCount})
              </button>
              <button
                type="button"
                onClick={() => setManageSubView('all')}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
                  manageSubView === 'all'
                    ? 'bg-blue-600 text-white shadow'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                ใบงานทั้งหมด ({workOrdersManageCount})
              </button>
            </div>

            {manageSubView === 'all' && (
              <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                <div className="flex flex-wrap gap-3 items-end">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1">ช่องทาง</label>
                    <select
                      value={jChannelFilter}
                      onChange={(e) => setJChannelFilter(e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                    >
                      <option value="">ทั้งหมด</option>
                      {jChannels.map((ch) => (
                        <option key={ch.channel_code} value={ch.channel_code}>
                          {ch.channel_name || ch.channel_code}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1">จากวันที่</label>
                    <input
                      type="date"
                      value={manageDateFrom}
                      onChange={(e) => setManageDateFrom(e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1">ถึงวันที่</label>
                    <input
                      type="date"
                      value={manageDateTo}
                      onChange={(e) => setManageDateTo(e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setJChannelFilter('')
                      setManageDateFrom(new Date().toISOString().split('T')[0])
                      setManageDateTo(new Date().toISOString().split('T')[0])
                    }}
                    className="px-4 py-2 rounded-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-100"
                  >
                    ล้างตัวกรอง
                  </button>
                </div>
              </div>
            )}

            {manageSubView === 'new' ? (
              <WorkOrderManageList
                mode="active"
                onCountChange={setManageNewCount}
                onRefresh={loadMenuCounts}
              />
            ) : (
              <WorkOrderManageList
                mode="all"
                channelFilter={jChannelFilter}
                dateFrom={manageDateFrom}
                dateTo={manageDateTo}
                onCountChange={setWorkOrdersManageCount}
                onRefresh={loadMenuCounts}
              />
            )}
          </div>
        </section>
      )}

      {/* View: หน้าแผนก (คิวงาน) - logic ตาม plan.html */}
      {currentView === 'dept' && (
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <h2 className="border-b border-gray-200 px-4 py-3 text-lg font-semibold">หน้าแผนก (คิวงานตาม Master Plan)</h2>
          <div className="p-4 space-y-4">
            <div className="flex flex-wrap gap-4 items-end">
              <div>
                <label className="block text-sm text-gray-500 mb-1">เลือกวัน</label>
                <input
                  type="date"
                  value={depDate}
                  onChange={(e) => setDepDate(e.target.value)}
                  disabled={!unlocked}
                  className="rounded-lg border border-gray-300 px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-500 mb-1">เลือกแผนก</label>
                <select
                  value={depFilter}
                  onChange={(e) => setDepFilter(e.target.value)}
                  className="w-52 rounded-lg border border-gray-300 px-3 py-2"
                >
                  <option value="ALL">-- เลือกแผนก --</option>
                  {selectableDepts.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-3 cursor-pointer">
                <span className="text-sm text-gray-600">ซ่อนงานที่เสร็จแล้ว</span>
                <input
                  type="checkbox"
                  checked={hideCompleted}
                  onChange={(e) => setHideCompleted(e.target.checked)}
                  className="peer sr-only"
                />
                <span className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border border-gray-200 bg-gray-200 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:ring-4 peer-focus:ring-blue-300" />
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <span className="text-sm text-gray-600">ซ่อนใบงานยกเลิก</span>
                <input
                  type="checkbox"
                  checked={hideVoided}
                  onChange={(e) => setHideVoided(e.target.checked)}
                  className="peer sr-only"
                />
                <span className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border border-gray-200 bg-gray-200 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:ring-4 peer-focus:ring-blue-300" />
              </label>
            </div>
            {(!depFilter || depFilter === 'ALL') ? (
              <p className="text-center text-gray-500 py-8">--- กรุณาเลือกแผนกเพื่อเริ่มงาน ---</p>
            ) : (() => {
              const dept = depFilter
              const jobsOnDate = jobs
                .filter((j) => sameDay(j.date, depDate) && getEffectiveQty(j, dept, settings, deptQtyByWorkOrderId) > 0)
                .sort((a, b) => a.order_index - b.order_index)
              const timeline = computePlanTimeline(dept, depDate, settings, jobs, 'cut', { deptQtyByWorkOrderId })
              const linesCount = Math.max(1, settings.linesPerDept?.[dept] ?? 1)
              const processNames = (settings.processes[dept] || []).map((p) => p.name)
              const workflowLabel = processNames.length ? processNames.join(' → ') : '-'
              const lineJobs: PlanJob[][] = Array.from({ length: linesCount }, () => [])
              jobsOnDate.forEach((j) => {
                if (hideVoided && j.is_production_voided) return
                const wid = String(j.work_order_id || '')
                if (hideVoided && wid && woStatusById[wid] === 'ยกเลิก') return
                if (hideCompleted && getJobStatusForDept(j, dept, settings, deptQtyByWorkOrderId).key === 'done') return
                const lineIdx = j.line_assignments?.[dept] ?? 0
                const idx = Math.min(lineIdx, lineJobs.length - 1)
                lineJobs[idx].push(j)
              })
              return (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                    <span className="font-semibold">แผนก: {dept}</span>
                    <span className="rounded-full border border-gray-300 bg-white px-3 py-1 text-sm text-gray-700">
                      ลำดับงาน: {workflowLabel}
                    </span>
                  </div>
                  <div
                    className="grid gap-4"
                    style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}
                  >
                    {Array.from({ length: linesCount }, (_, lineIdx) => (
                      <div key={lineIdx} className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
                        <h3 className="mb-3 border-b border-gray-200 pb-2 font-semibold text-gray-800">
                          Line {lineIdx + 1}
                        </h3>
                        <div className="flex flex-col gap-3">
                          {lineJobs[lineIdx].map((j) => {
                            const jtl = timeline.find((x) => x.id === j.id)
                            const tracks = j.tracks?.[dept] || {}
                            const currentProc = processNames.find((p) => !tracks[p]?.end)
                            const isAllDone = processNames.length > 0 && !currentProc
                            const firstProcName = processNames[0]
                            const hasStartedFirstStep = !!(tracks[firstProcName]?.start)
                            const t = currentProc ? tracks[currentProc] : null
                            const startTime = t?.start ? fmtLocalHHMM(t.start) : '--:--'
                            const isStarted = !!t?.start
                            const expKey = `${dept}_${j.id}`
                            const isExpanded = expandedDeptJob === expKey
                            return (
                              <div
                                key={j.id}
                                data-id={j.id}
                                className={`rounded-xl border p-3 ${
                                  isAllDone
                                    ? 'bg-orange-50 border-orange-200'
                                    : isStarted
                                    ? 'bg-blue-50 border-blue-200'
                                    : 'bg-white border-gray-200'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <div className="font-semibold text-lg flex flex-wrap items-center gap-1.5">
                                      <span>{j.name}</span>
                                      {j.is_production_voided && (
                                        <span className="px-1.5 py-0.5 text-xs font-bold rounded-full bg-orange-100 text-orange-800 border border-orange-300">
                                          ยกเลิกใบงาน
                                        </span>
                                      )}
                                      {(releasedByWO[String(j.work_order_id || '')]?.length ?? 0) > 0 && (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            if (j.work_order_id) openReleasedBillsModal(String(j.work_order_id))
                                          }}
                                          className="px-1.5 py-0.5 text-xs font-bold rounded-full bg-blue-100 text-blue-800 border border-blue-300 hover:bg-blue-200"
                                        >
                                          แก้ไข {releasedByWO[String(j.work_order_id || '')].length}
                                        </button>
                                      )}
                                      {(cancelledByWO[String(j.work_order_id || '')]?.length ?? 0) > 0 && (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            if (j.work_order_id) openCancelledBillsModal(String(j.work_order_id))
                                          }}
                                          className="px-1.5 py-0.5 text-xs font-bold rounded-full bg-red-100 text-red-700 border border-red-300 hover:bg-red-200"
                                        >
                                          ยกเลิก {cancelledByWO[String(j.work_order_id || '')].length}
                                        </button>
                                      )}
                                    </div>
                                    <div className="text-sm text-gray-500">
                                      ตัด: {fmtCutTime(j.cut)} | Qty: <b>{getEffectiveQty(j, dept, settings, deptQtyByWorkOrderId)}</b>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setExpandedDeptJob(isExpanded ? null : expKey)}
                                    className="shrink-0 rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                                  >
                                    ประวัติ
                                  </button>
                                </div>
                                <div className="mt-2 text-xs text-gray-500">
                                  แผน: {jtl ? secToHHMM(jtl.start) : '--:--'} - {jtl ? secToHHMM(jtl.end) : '--:--'}
                                </div>
                                {isAllDone ? (
                                  <div className="mt-3">
                                    <div className="rounded-xl border border-orange-200 bg-orange-100 py-2 text-center text-sm font-bold text-orange-900">
                                      ✓ เสร็จสมบูรณ์
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => backStep(j.id, dept)}
                                      className="mt-2 w-full rounded-lg border border-red-500 bg-red-500 py-2 text-sm font-medium text-white hover:bg-red-600"
                                    >
                                      ↺ แก้ไข/ย้อนขั้นตอน
                                    </button>
                                  </div>
                                ) : currentProc ? (
                                  <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-3">
                                    <div className="grid grid-cols-[1fr_auto] gap-2">
                                      {!isStarted ? (
                                        <button
                                          type="button"
                                          onClick={() => markStart(j.id, dept, currentProc)}
                                          className="rounded-lg bg-blue-600 py-2.5 text-base font-bold text-white hover:bg-blue-700"
                                        >
                                          เริ่ม: {currentProc}
                                        </button>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => markEnd(j.id, dept, currentProc)}
                                          className="rounded-lg bg-green-600 py-2.5 text-base font-bold text-white hover:bg-green-700"
                                        >
                                          เสร็จ: {currentProc}
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setClearStepModal({
                                            open: true,
                                            jobId: j.id,
                                            dept,
                                            procName: currentProc,
                                            step: 'confirm',
                                            resultMessage: '',
                                          })
                                        }}
                                        disabled={!hasStartedFirstStep || !unlocked}
                                        className="rounded-lg border border-red-500 bg-red-500 py-2.5 px-4 text-base font-medium text-white hover:bg-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                                      >
                                        ล้าง
                                      </button>
                                    </div>
                                    <div className="mt-2 flex justify-between border-t border-dashed border-gray-300 pt-2 text-[11px] text-gray-600">
                                      <span>
                                        เวลาเริ่ม: <b className="text-blue-600">{startTime}</b>
                                      </span>
                                      <span>
                                        สถานะ: <b>{isStarted ? 'กำลังทำ...' : 'รอเริ่ม'}</b>
                                      </span>
                                    </div>
                                  </div>
                                ) : null}
                                <div className="mt-3 flex items-center gap-2 text-xs">
                                  <span>Line:</span>
                                  <select
                                    value={j.line_assignments?.[dept] ?? 0}
                                    disabled={!unlocked}
                                    onChange={async (e) => {
                                      const newLine = parseInt(e.target.value, 10)
                                      const next = { ...j, line_assignments: { ...j.line_assignments, [dept]: newLine } }
                                      await updateJobField(j.id, { line_assignments: next.line_assignments })
                                    }}
                                    className="w-14 rounded border border-gray-300 bg-white py-1 text-xs"
                                  >
                                    {Array.from({ length: linesCount }, (_, i) => (
                                      <option key={i} value={i}>
                                        {i + 1}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                {isExpanded && (
                                  <div className="mt-3 space-y-1 border-t border-gray-200 pt-3">
                                    {processNames.map((pName) => {
                                      const tr = tracks[pName] || {}
                                      const icon = tr.end ? '✅' : tr.start ? '⏳' : '⚪'
                                      return (
                                        <div
                                          key={pName}
                                          className="flex items-center justify-between gap-2 rounded border border-gray-100 bg-white px-2 py-1.5 text-[11px]"
                                        >
                                          <span className="flex items-center gap-1">
                                            <b>{pName}</b>
                                            <span>{icon}</span>
                                          </span>
                                          <span className="text-gray-500 shrink-0">
                                            เริ่ม: {tr.start ? fmtLocalHHMM(tr.start) : '-'} | เสร็จ:{' '}
                                            {tr.end ? fmtLocalHHMM(tr.end) : '-'}
                                          </span>
                                        </div>
                                      )
                                    })}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}
          </div>
        </section>
      )}

      {/* View: Dashboard (Master Plan) - logic ตาม plan.html */}
      {currentView === 'dash' && (() => {
        const visibleDayJobs = dayJobs.filter((j) => {
          if (hideVoided && j.is_production_voided) return false
          if (!hideCompleted) return true
          return getOverallJobStatus(j, settings, deptQtyByWorkOrderId).key !== 'done'
        })
        return (
          <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
            <h2 className="border-b border-gray-200 px-4 py-3 text-lg font-semibold">Dashboard & Master Plan</h2>
            <div className="p-4 space-y-4">
              <div className="flex flex-wrap gap-4 items-center justify-between">
                <div className="flex flex-wrap gap-4 items-center">
                  <div>
                    <label className="block text-sm text-gray-500 mb-1">เลือกวัน</label>
                    <input
                      type="date"
                      value={dDate}
                      onChange={(e) => setDDate(e.target.value)}
                      disabled={!unlocked}
                      className="rounded-lg border border-gray-300 px-3 py-2"
                    />
                  </div>
                  <label className="flex items-center gap-3 mt-6 cursor-pointer">
                    <span className="text-sm text-gray-600">ซ่อนงานที่เสร็จแล้ว</span>
                    <input
                      type="checkbox"
                      checked={hideCompleted}
                      onChange={(e) => setHideCompleted(e.target.checked)}
                      className="peer sr-only"
                    />
                    <span className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border border-gray-200 bg-gray-200 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:ring-4 peer-focus:ring-blue-300" />
                  </label>
                  <label className="flex items-center gap-3 mt-6 cursor-pointer">
                    <span className="text-sm text-gray-600">ซ่อนใบงานยกเลิก</span>
                    <input
                      type="checkbox"
                      checked={hideVoided}
                      onChange={(e) => setHideVoided(e.target.checked)}
                      className="peer sr-only"
                    />
                    <span className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border border-gray-200 bg-gray-200 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:ring-4 peer-focus:ring-blue-300" />
                  </label>
                </div>
                {unlocked && (
                  <button
                    type="button"
                    onClick={() => {
                      const wb = XLSX.utils.book_new()
                      const tls = dashTimelines
                      settings.departments.forEach((dept) => {
                        const data: (string | number)[][] = [
                          ['ลำดับ', 'ชื่อใบงาน', 'เวลาตัด', 'จำนวน', 'ไลน์', 'สถานะ', 'แผนเริ่ม', 'แผนเสร็จ', 'เริ่มจริง', 'เสร็จจริง'],
                        ]
                        visibleDayJobs
                          .filter((j) => getEffectiveQty(j, dept, settings, deptQtyByWorkOrderId) > 0)
                          .forEach((j, i) => {
                            const status = getJobStatusForDept(j, dept, settings, deptQtyByWorkOrderId)
                            const me = tls[dept]?.find((x) => x.id === j.id)
                            const acts = getActualTimesForDept(j, dept, settings)
                            data.push([
                              i + 1,
                              j.name,
                              fmtCutTime(j.cut) || '-',
                              getEffectiveQty(j, dept, settings, deptQtyByWorkOrderId),
                              `L${(j.line_assignments?.[dept] ?? 0) + 1}`,
                              status.text,
                              me ? secToHHMM(me.start) : '-',
                              me ? secToHHMM(me.end) : '-',
                              acts.startDayOffset > 0 ? `+${acts.startDayOffset} ${acts.actualStart}` : acts.actualStart,
                              acts.endDayOffset > 0 ? `+${acts.endDayOffset} ${acts.actualEnd}` : acts.actualEnd,
                            ])
                          })
                        const ws = XLSX.utils.aoa_to_sheet(data)
                        XLSX.utils.book_append_sheet(wb, ws, dept.slice(0, 31))
                      })
                      XLSX.writeFile(wb, `Plan_${dDate}.xlsx`)
                    }}
                    className="rounded-lg border border-gray-400 bg-gray-100 px-3 py-2 text-sm font-medium"
                  >
                    Download Excel (แยกแผนก)
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500">
                * เวลาแผนจะอัปเดตตาม "เวลาเสร็จจริง" ของงานก่อนหน้า และข้าม "เวลาพัก" ของแต่ละแผนกโดยอัตโนมัติ
              </p>
              <p className="text-xs text-gray-500">
                * <span className="text-teal-600 font-semibold">เวลาสีเขียว⚡</span> = บันทึกอัตโนมัติ (เบิก→WMS, QC→หน้าตรวจ, PACK→หน้าแพ็ค) &nbsp;|&nbsp;
                <span className="text-blue-600 font-semibold">เวลาสีน้ำเงิน</span> = บันทึกจากหน้าแผนก &nbsp;|&nbsp;
                <span className="text-red-600 font-semibold">เวลาสีแดง</span> = ช้ากว่าแผน
              </p>
              {/* KPI Bar - สรุปไลน์ต่อแผนก (จาก plan.html) */}
              <div className="flex flex-wrap gap-3">
                {settings.departments.map((d) => {
                  const tl = dashTimelines[d]
                  if (!tl || tl.length === 0) return null
                  const activeLines = [...new Set(tl.map((x) => x.line))].sort((a, b) => a - b)
                  const lineSummaries = activeLines.map((lineIdx) => {
                    const lineJobs = tl.filter((x) => x.line === lineIdx)
                    const lastRes = lineJobs[lineJobs.length - 1]
                    const lastJb = jobs.find((j) => j.id === lastRes.id)
                    const lastStatus = lastJb ? getJobStatusForDept(lastJb, d, settings, deptQtyByWorkOrderId) : { key: 'pending' as const }
                    const lastActEnd = lastJb ? getLatestActualEndSecForDept(lastJb, d) : 0
                    const displayEnd = lastStatus.key === 'done' && lastActEnd > 0 ? lastActEnd : lastRes.end
                    const totalDurSeconds = lineJobs.reduce((sum, item) => {
                      const jb = jobs.find((j) => j.id === item.id)
                      if (!jb) return sum + item.dur
                      const st = getJobStatusForDept(jb, d, settings, deptQtyByWorkOrderId)
                      if (st.key === 'done') {
                        const tracks = jb.tracks?.[d] || {}
                        const procs = (settings.processes[d] || []).map((p) => p.name)
                        let firstStart = Infinity,
                          lastEnd = -Infinity
                        procs.forEach((pName) => {
                          if (tracks[pName]?.start)
                            firstStart = Math.min(firstStart, new Date(tracks[pName].start!).getTime())
                          if (tracks[pName]?.end) lastEnd = Math.max(lastEnd, new Date(tracks[pName].end!).getTime())
                        })
                        if (firstStart !== Infinity && lastEnd !== -Infinity)
                          return sum + (lastEnd - firstStart) / 1000
                      }
                      return sum + item.dur
                    }, 0)
                    return `L${lineIdx + 1}: ${secToHHMM(displayEnd)} (${fmtTime(totalDurSeconds)})`
                  })
                  return (
                    <span key={d} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium">
                      <b>{d}</b> · {lineSummaries.join(' | ')}
                    </span>
                  )
                })}
              </div>
              <div className="overflow-x-auto max-h-[60vh] rounded-xl border border-gray-200">
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-gray-100 sticky top-0 z-10">
                    <tr>
                      <th className="p-2 text-left font-medium w-8 border-b border-gray-200"></th>
                      <th className="p-2 text-left font-medium min-w-[120px] border-b border-gray-200">ใบงาน</th>
                      <th className="p-2 text-center font-medium border-l-2 border-gray-200 border-b border-gray-200">เวลาตัด</th>
                      {settings.departments.map((dept) => (
                        <th key={dept} colSpan={3} className="p-2 text-center font-medium border-l-2 border-gray-200 border-b border-gray-200">
                          {dept}
                        </th>
                      ))}
                    </tr>
                    <tr>
                      <th className="p-2 border-b border-gray-200" />
                      <th className="p-2 border-b border-gray-200" />
                      <th className="p-2 border-l-2 border-gray-200 border-b border-gray-200" />
                      {settings.departments.map((dept) => (
                        <Fragment key={dept}>
                          <th className="p-2 text-center border-l border-gray-200 border-b border-gray-200">สถานะ</th>
                          <th className="p-2 text-center border-l border-gray-200 border-b border-gray-200">เริ่ม</th>
                          <th className="p-2 text-center border-l border-gray-200 border-b border-gray-200">เสร็จ</th>
                        </Fragment>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleDayJobs.map((j) => {
                      const statusByDept = settings.departments.map((d) => getJobStatusForDept(j, d, settings, deptQtyByWorkOrderId))
                      return (
                        <tr
                          key={j.id}
                          data-id={j.id}
                          draggable={unlocked}
                          className={`border-t border-gray-100 hover:bg-gray-50 ${dashDraggedId === j.id ? 'opacity-50' : ''}`}
                          onDragStart={() => unlocked && setDashDraggedId(j.id)}
                          onDragEnd={() => { setDashDraggedId(null); setDashDropTarget(null) }}
                          onDragLeave={() => setDashDropTarget(null)}
                          onDragOver={(e) => {
                            if (!unlocked || !dashDraggedId) return
                            e.preventDefault()
                            const tr = (e.target as HTMLElement).closest('tr')
                            if (tr && tr.dataset.id && tr.dataset.id !== dashDraggedId) {
                              const rect = tr.getBoundingClientRect()
                              setDashDropTarget(rect.top + rect.height / 2 > e.clientY ? { id: tr.dataset.id, above: true } : { id: tr.dataset.id, above: false })
                            }
                          }}
                          onDrop={(e) => {
                            e.preventDefault()
                            if (!dashDraggedId || !dashDropTarget) return
                            const ids = visibleDayJobs.map((x) => x.id)
                            const fromIdx = ids.indexOf(dashDraggedId)
                            const toIdx = ids.indexOf(dashDropTarget.id)
                            if (fromIdx === -1 || toIdx === -1) return
                            const newIds = ids.filter((id) => id !== dashDraggedId)
                            const insertIdx = dashDropTarget.above ? toIdx : toIdx + 1
                            newIds.splice(insertIdx > fromIdx ? insertIdx - 1 : insertIdx, 0, dashDraggedId)
                            const allDay = dayJobs.map((x) => x.id)
                            const hiddenIds = allDay.filter((id) => !ids.includes(id))
                            const fullOrder = [...newIds, ...hiddenIds]
                            setDbStatus('กำลังบันทึกลำดับ...')
                            Promise.all(
                              fullOrder.map((id, i) => {
                                const job = jobs.find((x) => x.id === id)
                                if (!job || job.order_index === i) return Promise.resolve()
                                return supabase.from('plan_jobs').update({ order_index: i }).eq('id', id)
                              })
                            ).then((results) => {
                              const err = results.find((r) => r?.error)
                              if (err) {
                                setDbStatus('บันทึกลำดับไม่สำเร็จ')
                                alert('บันทึกลำดับไม่สำเร็จ')
                              } else {
                                setJobs((prev) =>
                                  prev.map((job) => {
                                    const i = fullOrder.indexOf(job.id)
                                    return i >= 0 ? { ...job, order_index: i } : job
                                  })
                                )
                                setDbStatus('เชื่อมต่อฐานข้อมูลแล้ว')
                              }
                              setDashDraggedId(null)
                              setDashDropTarget(null)
                            })
                          }}
                        >
                          <td className="p-2 text-gray-400 cursor-grab">{unlocked ? '☰' : ''}</td>
                          <td className="p-2 font-medium">
                            {j.name}
                            {j.is_production_voided && (
                              <span
                                className="ml-2 px-2 py-0.5 text-xs font-bold rounded-full bg-orange-100 text-orange-800 border border-orange-300"
                                title="บิลถูกย้ายออกจากใบงานหมดแล้ว แต่แผนเคยเริ่ม"
                              >
                                ยกเลิกใบงาน
                              </span>
                            )}
                            {(releasedByWO[String(j.work_order_id || '')]?.length ?? 0) > 0 && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (j.work_order_id) openReleasedBillsModal(String(j.work_order_id))
                                }}
                                className="ml-2 px-2 py-0.5 text-xs font-bold rounded-full bg-blue-100 text-blue-800 border border-blue-300 hover:bg-blue-200 transition"
                              >
                                แก้ไข {releasedByWO[String(j.work_order_id || '')].length}
                              </button>
                            )}
                            {(cancelledByWO[String(j.work_order_id || '')]?.length ?? 0) > 0 && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (j.work_order_id) openCancelledBillsModal(String(j.work_order_id))
                                }}
                                className="ml-2 px-2 py-0.5 text-xs font-bold rounded-full bg-red-100 text-red-700 border border-red-300 hover:bg-red-200 transition"
                              >
                                ยกเลิก {cancelledByWO[String(j.work_order_id || '')].length}
                              </button>
                            )}
                          </td>
                          <td className="p-2 text-center border-l-2 border-gray-200">
                            {(() => {
                              const ct = fmtCutTime(j.cut)
                              const isOvernight = j.cut && parseTimeToMin(ct) < parseTimeToMin(settings.dayStart)
                              return isOvernight
                                ? <span className="text-orange-600" title="ตัดใบงานก่อนเวลาเริ่มงาน (อาจเป็นข้ามวัน)">{ct} 🌙</span>
                                : ct
                            })()}
                          </td>
                          {settings.departments.map((d, di) => {
                            const q = getEffectiveQty(j, d, settings, deptQtyByWorkOrderId)
                            const status = statusByDept[di]
                            const me = dashTimelines[d]?.find((x) => x.id === j.id)
                            const acts = getActualTimesForDept(j, d, settings)
                            const totalLines = Math.max(1, settings.linesPerDept?.[d] ?? 1)
                            const currentLine = j.line_assignments?.[d] ?? 0
                            if (q === 0) {
                              return (
                                <td key={d} colSpan={3} className="p-2 text-center border-l border-gray-200 bg-gray-50">
                                  -
                                </td>
                              )
                            }
                            return (
                              <Fragment key={d}>
                                <td
                                  className={`p-2 text-center border-l border-gray-200 ${
                                    status.key === 'done' ? 'bg-orange-100 border border-orange-200' : status.key === 'progress' ? 'bg-green-50' : 'bg-yellow-50'
                                  }`}
                                >
                                  <div className="flex flex-col items-center gap-0.5">
                                    <span className="font-semibold text-xs whitespace-nowrap">{status.text}</span>
                                    <select
                                      value={currentLine}
                                      disabled={!unlocked}
                                      onChange={async (e) => {
                                        const newLine = parseInt(e.target.value, 10)
                                        const next = { ...j, line_assignments: { ...j.line_assignments, [d]: newLine } }
                                        await updateJobField(j.id, { line_assignments: next.line_assignments })
                                      }}
                                      className="w-12 py-0.5 text-xs border border-gray-300 rounded bg-white"
                                    >
                                      {Array.from({ length: totalLines }, (_, i) => (
                                        <option key={i} value={i}>
                                          L{i + 1}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </td>
                                <td
                                  className={`p-2 text-center border-l border-gray-200 align-top ${
                                    status.key === 'done' ? 'bg-orange-100 border border-orange-200' : status.key === 'progress' ? 'bg-green-50' : 'bg-yellow-50'
                                  }`}
                                >
                                  <div className="flex flex-col items-center gap-0 text-[11px]">
                                    {dashEdit?.jobId === j.id && dashEdit?.dept === d && dashEdit?.field === 'planStart' ? (
                                      <input
                                        type="time"
                                        value={dashEdit.value}
                                        onChange={(e) => setDashEdit((prev) => prev ? { ...prev, value: e.target.value } : prev)}
                                        onBlur={() => saveDashEdit(j, d, 'planStart')}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') saveDashEdit(j, d, 'planStart')
                                          if (e.key === 'Escape') setDashEdit(null)
                                        }}
                                        autoFocus
                                        className="w-[84px] border border-gray-300 rounded px-1 py-0.5 text-[11px] text-center"
                                      />
                                    ) : (
                                      <span
                                        onDoubleClick={() => startDashEdit(j.id, d, 'planStart', me ? secToHHMM(me.start) : '')}
                                        className={`text-gray-500 ${unlocked ? 'cursor-pointer' : ''}`}
                                        title={unlocked ? 'ดับเบิ้ลคลิกเพื่อแก้ไขเวลาเริ่ม (แผน)' : undefined}
                                      >
                                        {me ? secToHHMM(me.start) : '-'}
                                      </span>
                                    )}
                                    {dashEdit?.jobId === j.id && dashEdit?.dept === d && dashEdit?.field === 'actualStart' ? (
                                      <input
                                        type="time"
                                        value={dashEdit.value}
                                        onChange={(e) => setDashEdit((prev) => prev ? { ...prev, value: e.target.value } : prev)}
                                        onBlur={() => saveDashEdit(j, d, 'actualStart')}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') saveDashEdit(j, d, 'actualStart')
                                          if (e.key === 'Escape') setDashEdit(null)
                                        }}
                                        autoFocus
                                        className="w-[84px] border border-gray-300 rounded px-1 py-0.5 text-[11px] text-center"
                                      />
                                    ) : (
                                      <span
                                        onDoubleClick={() => startDashEdit(j.id, d, 'actualStart', acts.actualStart !== '-' ? acts.actualStart : '')}
                                        className={
                                          (acts.startDayOffset > 0
                                            ? 'text-red-600 font-semibold'
                                            : me && acts.actualStart !== '-' && getEarliestActualStartSecForDept(j, d) > me.start
                                              ? 'text-red-600 font-semibold'
                                              : d in AUTO_TRACK_DEPTS && acts.actualStart !== '-'
                                                ? 'text-teal-600 font-semibold'
                                                : 'text-blue-600 font-semibold') + (unlocked ? ' cursor-pointer' : '')
                                        }
                                        title={
                                          d in AUTO_TRACK_DEPTS && acts.actualStart !== '-'
                                            ? AUTO_TRACK_DEPTS[d] + (unlocked ? ' · ดับเบิ้ลคลิกเพื่อแก้ไข' : '')
                                            : unlocked ? 'ดับเบิ้ลคลิกเพื่อแก้ไขเวลาเริ่มจริง' : undefined
                                        }
                                      >
                                        {acts.actualStart !== '-' ? (
                                          <>{acts.startDayOffset > 0 && <span className="text-red-600">+{acts.startDayOffset} </span>}{acts.actualStart}{d in AUTO_TRACK_DEPTS && <span className="text-[9px] opacity-50 ml-0.5">⚡</span>}</>
                                        ) : '\u00A0'}
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td
                                  className={`p-2 text-center border-l border-gray-200 align-top ${
                                    status.key === 'done' ? 'bg-orange-100 border border-orange-200' : status.key === 'progress' ? 'bg-green-50' : 'bg-yellow-50'
                                  }`}
                                >
                                  <div className="flex flex-col items-center gap-0 text-[11px]">
                                    <span className="text-gray-500">{me ? secToHHMM(me.end) : '-'}</span>
                                    {dashEdit?.jobId === j.id && dashEdit?.dept === d && dashEdit?.field === 'actualEnd' ? (
                                      <input
                                        type="time"
                                        value={dashEdit.value}
                                        onChange={(e) => setDashEdit((prev) => prev ? { ...prev, value: e.target.value } : prev)}
                                        onBlur={() => saveDashEdit(j, d, 'actualEnd')}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') saveDashEdit(j, d, 'actualEnd')
                                          if (e.key === 'Escape') setDashEdit(null)
                                        }}
                                        autoFocus
                                        className="w-[84px] border border-gray-300 rounded px-1 py-0.5 text-[11px] text-center"
                                      />
                                    ) : (
                                      <span
                                        onDoubleClick={() => startDashEdit(j.id, d, 'actualEnd', acts.actualEnd !== '-' ? acts.actualEnd : '')}
                                        className={
                                          (acts.endDayOffset > 0
                                            ? 'text-red-600 font-semibold'
                                            : me && acts.actualEnd !== '-' && getLatestActualEndSecForDept(j, d) > me.end
                                              ? 'text-red-600 font-semibold'
                                              : d in AUTO_TRACK_DEPTS && acts.actualEnd !== '-'
                                                ? 'text-teal-600 font-semibold'
                                                : 'text-blue-600 font-semibold') + (unlocked ? ' cursor-pointer' : '')
                                        }
                                        title={
                                          d in AUTO_TRACK_DEPTS && acts.actualEnd !== '-'
                                            ? AUTO_TRACK_DEPTS[d] + (unlocked ? ' · ดับเบิ้ลคลิกเพื่อแก้ไข' : '')
                                            : unlocked ? 'ดับเบิ้ลคลิกเพื่อแก้ไขเวลาเสร็จจริง' : undefined
                                        }
                                      >
                                        {acts.actualEnd !== '-' ? (
                                          <>{acts.endDayOffset > 0 && <span className="text-red-600">+{acts.endDayOffset} </span>}{acts.actualEnd}{d in AUTO_TRACK_DEPTS && <span className="text-[9px] opacity-50 ml-0.5">⚡</span>}</>
                                        ) : '\u00A0'}
                                      </span>
                                    )}
                                  </div>
                                </td>
                              </Fragment>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {dayJobs.length === 0 && (
                <p className="text-center text-gray-500 py-8">ไม่มีใบงานในวันนี้</p>
              )}
            </div>
          </section>
        )
      })()}

      {/* View: ตั้งค่า */}
      {currentView === 'set' && (() => {
        const currentDept = settings.departments.includes(selectedDeptForSettings)
          ? selectedDeptForSettings
          : (settings.departments[0] || '')
        const procList = (settings.processes[currentDept] || []).slice()
        const breaksList = (settings.deptBreaks[currentDept] || []).slice()
        return (
          <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
            <h2 className="border-b border-gray-200 px-4 py-3 text-lg font-semibold">
              ตั้งค่า (แผนก • กระบวนการ • เวลามาตรฐาน)
            </h2>
            {!unlocked && (
              <div className="mx-4 mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
                เฉพาะ role superadmin และ admin เท่านั้นที่สามารถแก้ไขตั้งค่าได้
              </div>
            )}
            <div className="p-4 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-lg border border-dashed border-gray-300 p-4">
                  <h3 className="font-medium mb-2">แผนก (เพิ่ม/ลบ/เปลี่ยนชื่อ/จัดลำดับ)</h3>
                  <div className="space-y-2">
                    {settings.departments.map((d, i) => (
                      <div key={d} className="flex gap-2 items-center">
                        <input
                          type="text"
                          value={d}
                          disabled={!unlocked}
                          onChange={(e) => {
                            const newName = e.target.value.trim() || d
                            if (newName === d) return
                            const next = { ...settings }
                            const idx = next.departments.indexOf(d)
                            if (idx > -1) next.departments[idx] = newName
                            ;['processes', 'prepPerJob', 'deptBreaks', 'linesPerDept', 'departmentProductCategories'].forEach((k) => {
                              const key = k as keyof PlanSettingsData
                              const obj = next[key] as Record<string, unknown>
                              if (obj[d] != null) {
                                ;(obj as Record<string, unknown>)[newName] = obj[d]
                                delete (obj as Record<string, unknown>)[d]
                              }
                            })
                            if (selectedDeptForSettings === d) setSelectedDeptForSettings(newName)
                            setSettings(next)
                            saveSettings(next)
                          }}
                          className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                        />
                        <button
                          type="button"
                          disabled={!unlocked}
                          onClick={() => {
                            const next = { ...settings }
                            const arr = [...next.departments]
                            if (i > 0) {
                              ;[arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]
                              next.departments = arr
                              setSettings(next)
                              saveSettings(next)
                            }
                          }}
                          className="rounded-lg border border-gray-300 px-2 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={!unlocked}
                          onClick={() => {
                            const next = { ...settings }
                            const arr = [...next.departments]
                            if (i < arr.length - 1) {
                              ;[arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]
                              next.departments = arr
                              setSettings(next)
                              saveSettings(next)
                            }
                          }}
                          className="rounded-lg border border-gray-300 px-2 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          disabled={!unlocked}
                          onClick={() => {
                            if (!window.confirm(`ลบแผนก ${d}?`)) return
                            const next = { ...settings }
                            next.departments = next.departments.filter((x) => x !== d)
                            ;['processes', 'prepPerJob', 'deptBreaks', 'linesPerDept', 'departmentProductCategories'].forEach((k) => {
                              const obj = next[k as keyof PlanSettingsData] as Record<string, unknown>
                              delete obj[d]
                            })
                            if (selectedDeptForSettings === d) setSelectedDeptForSettings(settings.departments[0] || '')
                            setSettings(next)
                            saveSettings(next)
                          }}
                          className="rounded-lg bg-red-600 px-2 py-1 text-sm text-white hover:bg-red-700 font-semibold disabled:opacity-50"
                        >
                          ลบ
                        </button>
                        <button
                          type="button"
                          disabled={!unlocked}
                          onClick={() => {
                            setCategoryModalDept(d)
                            setCategoryModalDraft([...(settings.departmentProductCategories?.[d] || [])])
                          }}
                          className="rounded-lg border border-gray-300 px-2 py-1 text-sm hover:bg-gray-100 disabled:opacity-50 whitespace-nowrap"
                        >
                          หมวดหมู่
                          {(settings.departmentProductCategories?.[d]?.length ?? 0) > 0 && (
                            <span className="ml-0.5 text-gray-500">
                              ({settings.departmentProductCategories?.[d]?.length})
                            </span>
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={!unlocked}
                    onClick={() => {
                      const name = window.prompt('ชื่อแผนกใหม่')
                      if (!name) return
                      const next = { ...settings }
                      next.departments.push(name.trim())
                      const withBaseline = ensureDeptBaseline(next)
                      setSettings(withBaseline)
                      saveSettings(withBaseline)
                    }}
                    className="mt-2 rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
                  >
                    + เพิ่มแผนก
                  </button>
                </div>
                <div className="rounded-lg border border-dashed border-gray-300 p-4">
                  <h3 className="font-medium mb-2">เวลาเริ่ม-เลิกงาน Default</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-gray-500 mb-1">เวลาเริ่มงาน</label>
                      <input
                        type="time"
                        value={settings.dayStart}
                        onChange={(e) => {
                          const next = { ...settings, dayStart: e.target.value }
                          setSettings(next)
                          saveSettings(next)
                        }}
                        disabled={!unlocked}
                        className="w-full rounded border border-gray-300 px-2 py-1"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-500 mb-1">เวลาเลิกงาน</label>
                      <input
                        type="time"
                        value={settings.dayEnd}
                        onChange={(e) => {
                          const next = { ...settings, dayEnd: e.target.value }
                          setSettings(next)
                          saveSettings(next)
                        }}
                        disabled={!unlocked}
                        className="w-full rounded border border-gray-300 px-2 py-1"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* ตั้งค่ารายละเอียดแผนก */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-base">ตั้งค่ารายละเอียดแผนก:</span>
                <select
                  value={currentDept}
                  onChange={(e) => setSelectedDeptForSettings(e.target.value)}
                  className="rounded border border-gray-300 px-3 py-1.5 text-sm w-[220px]"
                >
                  {settings.departments.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>

              <div className="rounded-lg border border-gray-200 p-4 space-y-4">
                <h4 className="font-medium">ขั้นตอนของแผนก</h4>
                <div className="space-y-2">
                  {procList.map((p, i) => (
                    <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_140px_140px_auto] gap-2 items-center">
                      <input
                        type="text"
                        value={p.name}
                        placeholder="ชื่อขั้นตอน"
                        disabled={!unlocked}
                        onChange={(e) => {
                          const next = { ...settings, processes: { ...settings.processes } }
                          const arr = [...(next.processes[currentDept] || [])]
                          if (arr[i]) {
                            arr[i] = { ...arr[i], name: e.target.value.trim() || arr[i].name }
                            next.processes[currentDept] = arr
                            setSettings(next)
                            saveSettings(next)
                          }
                        }}
                        className="rounded border border-gray-300 px-2 py-1 text-sm"
                      />
                      <select
                        value={p.type}
                        disabled={!unlocked}
                        onChange={(e) => {
                          const typ = e.target.value as 'per_piece' | 'fixed'
                          const next = { ...settings, processes: { ...settings.processes } }
                          const arr = [...(next.processes[currentDept] || [])]
                          if (arr[i]) {
                            arr[i] = { ...arr[i], type: typ, value: typ === 'fixed' ? 0 : arr[i].value }
                            next.processes[currentDept] = arr
                            setSettings(next)
                            saveSettings(next)
                          }
                        }}
                        className="rounded border border-gray-300 px-2 py-1 text-sm"
                      >
                        <option value="per_piece">ต่อชิ้น</option>
                        <option value="fixed">คงที่</option>
                      </select>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={p.type === 'fixed' ? Math.round(p.value / 60) : p.value}
                          disabled={!unlocked}
                          onChange={(e) => {
                            const num = p.type === 'fixed' ? (parseFloat(e.target.value) || 0) * 60 : (parseInt(e.target.value, 10) || 0)
                            const next = { ...settings, processes: { ...settings.processes } }
                            const arr = [...(next.processes[currentDept] || [])]
                            if (arr[i]) {
                              arr[i] = { ...arr[i], value: num }
                              next.processes[currentDept] = arr
                              setSettings(next)
                              saveSettings(next)
                            }
                          }}
                          className="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
                        />
                        <span className="text-xs text-gray-500">{p.type === 'fixed' ? 'นาที (คงที่)' : 'วินาที/ชิ้น'}</span>
                      </div>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          disabled={!unlocked || i === 0}
                          onClick={() => {
                            if (i <= 0) return
                            const next = { ...settings, processes: { ...settings.processes } }
                            const arr = [...(next.processes[currentDept] || [])]
                            ;[arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]
                            next.processes[currentDept] = arr
                            setSettings(next)
                            saveSettings(next)
                          }}
                          className="rounded-lg border border-gray-300 px-2 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
                        >↑</button>
                        <button
                          type="button"
                          disabled={!unlocked || i === procList.length - 1}
                          onClick={() => {
                            if (i >= procList.length - 1) return
                            const next = { ...settings, processes: { ...settings.processes } }
                            const arr = [...(next.processes[currentDept] || [])]
                            ;[arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]
                            next.processes[currentDept] = arr
                            setSettings(next)
                            saveSettings(next)
                          }}
                          className="rounded-lg border border-gray-300 px-2 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
                        >↓</button>
                        <button
                          type="button"
                          disabled={!unlocked}
                          onClick={() => {
                            if (!window.confirm(`ลบขั้นตอน ${p.name}?`)) return
                            const next = { ...settings, processes: { ...settings.processes } }
                            const arr = (next.processes[currentDept] || []).filter((_, j) => j !== i)
                            next.processes[currentDept] = arr
                            setSettings(next)
                            saveSettings(next)
                          }}
                          className="rounded-lg bg-red-600 px-2 py-1 text-sm text-white hover:bg-red-700 font-semibold disabled:opacity-50"
                        >ลบ</button>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={!unlocked}
                  onClick={() => {
                    const name = window.prompt('ชื่อขั้นตอนใหม่')
                    if (!name) return
                    const next = { ...settings, processes: { ...settings.processes } }
                    const arr = [...(next.processes[currentDept] || [])]
                    arr.push({ name: name.trim(), type: 'per_piece', value: 0 })
                    next.processes[currentDept] = arr
                    setSettings(next)
                    saveSettings(next)
                  }}
                  className="rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
                >
                  + เพิ่มขั้นตอน
                </button>

                <hr className="border-gray-200 border-dashed" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <h4 className="font-medium mb-1">เวลาผลิตขั้นต่ำต่อบิล (นาที)</h4>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={settings.prepPerJob?.[currentDept] ?? 10}
                      disabled={!unlocked}
                      onChange={(e) => {
                        const next = { ...settings, prepPerJob: { ...settings.prepPerJob } }
                        next.prepPerJob[currentDept] = parseFloat(e.target.value) || 10
                        setSettings(next)
                        saveSettings(next)
                      }}
                      className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                  </div>
                  <div>
                    <h4 className="font-medium mb-1">จำนวนไลน์การผลิต</h4>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={settings.linesPerDept?.[currentDept] ?? 1}
                      disabled={!unlocked}
                      onChange={(e) => {
                        const next = { ...settings, linesPerDept: { ...settings.linesPerDept } }
                        next.linesPerDept[currentDept] = parseInt(e.target.value, 10) || 1
                        setSettings(next)
                        saveSettings(next)
                      }}
                      className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                  </div>
                </div>

                <hr className="border-gray-200 border-dashed" />
                <div>
                  <h4 className="font-medium mb-2">ช่วงเวลาพัก (เพิ่มได้หลายช่วง)</h4>
                  <div className="space-y-2">
                    {breaksList.map((br, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <input
                          type="time"
                          value={br.start}
                          disabled={!unlocked}
                          onChange={(e) => {
                            const next = { ...settings, deptBreaks: { ...settings.deptBreaks } }
                            const arr = [...(next.deptBreaks[currentDept] || [])]
                            if (arr[i]) {
                              arr[i] = { ...arr[i], start: e.target.value }
                              next.deptBreaks[currentDept] = arr
                              setSettings(next)
                              saveSettings(next)
                            }
                          }}
                          className="rounded border border-gray-300 px-2 py-1 text-sm"
                        />
                        <input
                          type="time"
                          value={br.end}
                          disabled={!unlocked}
                          onChange={(e) => {
                            const next = { ...settings, deptBreaks: { ...settings.deptBreaks } }
                            const arr = [...(next.deptBreaks[currentDept] || [])]
                            if (arr[i]) {
                              arr[i] = { ...arr[i], end: e.target.value }
                              next.deptBreaks[currentDept] = arr
                              setSettings(next)
                              saveSettings(next)
                            }
                          }}
                          className="rounded border border-gray-300 px-2 py-1 text-sm"
                        />
                        <button
                          type="button"
                          disabled={!unlocked}
                          onClick={() => {
                            const next = { ...settings, deptBreaks: { ...settings.deptBreaks } }
                            const arr = (next.deptBreaks[currentDept] || []).filter((_, j) => j !== i)
                            next.deptBreaks[currentDept] = arr
                            setSettings(next)
                            saveSettings(next)
                          }}
                          className="rounded-lg bg-red-600 px-2 py-1 text-sm text-white hover:bg-red-700 font-semibold disabled:opacity-50"
                        >ลบ</button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={!unlocked}
                    onClick={() => {
                      const next = { ...settings, deptBreaks: { ...settings.deptBreaks } }
                      const arr = [...(next.deptBreaks[currentDept] || [])]
                      arr.push({ start: '12:00', end: '13:00' })
                      next.deptBreaks[currentDept] = arr
                      setSettings(next)
                      saveSettings(next)
                    }}
                    className="mt-2 rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
                  >
                    + เพิ่มเวลาพัก
                  </button>
                </div>

                <div className="flex flex-wrap gap-2 pt-2">
                  <button
                    type="button"
                    disabled={!unlocked}
                    onClick={() => {
                      if (!unlocked) return alert('ปลดล็อกก่อน')
                      const wb = XLSX.utils.book_new()
                      const meta = [
                        ['dayStart', settings.dayStart],
                        ['dayEnd', settings.dayEnd],
                        ['departments', ...settings.departments],
                      ]
                      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(meta), 'meta')
                      settings.departments.forEach((d) => {
                        const rows: (string | number)[][] = [
                          ['prepPerJob', settings.prepPerJob?.[d] ?? 10],
                          ['linesPerDept', settings.linesPerDept?.[d] ?? 1],
                          ['step_name', 'step_type', 'step_value'],
                          ...(settings.processes[d] || []).map((p) => [p.name, p.type, p.type === 'fixed' ? p.value / 60 : p.value]),
                          ['break_start', 'break_end'],
                          ...(settings.deptBreaks[d] || []).map((b) => [b.start, b.end]),
                        ]
                        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), d.slice(0, 31))
                      })
                      XLSX.writeFile(wb, 'Plan_Settings.xlsx')
                    }}
                    className="rounded-xl bg-green-600 text-white px-3 py-1.5 text-sm font-semibold hover:bg-green-700 disabled:opacity-50"
                  >
                    Export Settings (.xlsx)
                  </button>
                  <label className="rounded-xl bg-purple-600 text-white px-3 py-1.5 text-sm font-semibold cursor-pointer hover:bg-purple-700 disabled:opacity-50 inline-block">
                    Import Settings (.xlsx)
                    <input
                      type="file"
                      accept=".xlsx, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      className="hidden"
                      disabled={!unlocked}
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        e.target.value = ''
                        if (!file || !unlocked) return
                        const reader = new FileReader()
                        reader.onload = async (ev) => {
                          try {
                            const wb = XLSX.read(new Uint8Array(ev.target?.result as ArrayBuffer), { type: 'array' })
                            const metaSheet = wb.Sheets['meta']
                            if (!metaSheet) throw new Error('ไม่มีชีต meta')
                            const metaRows = XLSX.utils.sheet_to_json<string[]>(metaSheet, { header: 1, defval: '' })
                            const next = { ...defaultSettings, ...settings }
                            let dayStart = next.dayStart
                            let dayEnd = next.dayEnd
                            let departments = next.departments
                            for (const row of metaRows) {
                              if (row[0] === 'dayStart' && row[1]) dayStart = String(row[1])
                              if (row[0] === 'dayEnd' && row[1]) dayEnd = String(row[1])
                              if (row[0] === 'departments' && row.length > 1) departments = row.slice(1).filter(Boolean) as string[]
                            }
                            next.dayStart = dayStart
                            next.dayEnd = dayEnd
                            next.departments = departments
                            next.processes = { ...next.processes }
                            next.prepPerJob = { ...next.prepPerJob }
                            next.linesPerDept = { ...next.linesPerDept }
                            next.deptBreaks = { ...next.deptBreaks }
                            departments.forEach((d) => {
                              const sh = wb.Sheets[d.slice(0, 31)]
                              if (!sh) return
                              const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sh, { header: 1, defval: '' })
                              let prep = 10
                              let lines = 1
                              const steps: ProcessStep[] = []
                              const br: { start: string; end: string }[] = []
                              let i = 0
                              for (; i < rows.length; i++) {
                                const r = rows[i]
                                if (r[0] === 'prepPerJob' && r[1] != null) prep = Number(r[1]) || 10
                                if (r[0] === 'linesPerDept' && r[1] != null) lines = Number(r[1]) || 1
                                if (r[0] === 'step_name') break
                              }
                              i++
                              for (; i < rows.length; i++) {
                                const r = rows[i]
                                if (r[0] === 'break_start') break
                                const name = String(r[0] || '').trim()
                                if (!name) continue
                                const type = (r[1] === 'fixed' ? 'fixed' : 'per_piece') as 'per_piece' | 'fixed'
                                const val = Number(r[2]) || 0
                                steps.push({ name, type, value: type === 'fixed' ? val * 60 : val })
                              }
                              i++
                              for (; i < rows.length; i++) {
                                const r = rows[i]
                                const start = String(r[0] || '').trim()
                                const end = String(r[1] || '').trim()
                                if (start && end) br.push({ start, end })
                              }
                              next.processes[d] = steps.length ? steps : (next.processes[d] || [])
                              next.prepPerJob[d] = prep
                              next.linesPerDept[d] = lines
                              next.deptBreaks[d] = br.length ? br : (next.deptBreaks[d] || [])
                            })
                            const withBaseline = ensureDeptBaseline(next)
                            setSettings(withBaseline)
                            await saveSettings(withBaseline)
                            alert('นำเข้าตั้งค่าสำเร็จ')
                          } catch (err: any) {
                            alert('นำเข้าตั้งค่าล้มเหลว: ' + (err?.message || err))
                          }
                        }
                        reader.readAsArrayBuffer(file)
                      }}
                    />
                  </label>
                </div>
              </div>
            </div>
          </section>
        )
      })()}

      <Modal
        open={!!categoryModalDept}
        onClose={() => setCategoryModalDept(null)}
        contentClassName="max-w-lg w-full"
        closeOnBackdropClick={false}
      >
        {categoryModalDept && (
          <div className="p-6">
            <h3 className="text-lg font-bold text-gray-800 mb-1">หมวดหมู่สินค้า</h3>
            <p className="text-sm text-gray-600 mb-4">
              แผนก <span className="font-semibold text-gray-800">{categoryModalDept}</span> — เลือกหมวดจากสินค้า (active)
            </p>
            {(() => {
              const catOptions = Array.from(new Set([...planProductCategories, ...categoryModalDraft])).sort((a, b) =>
                a.localeCompare(b)
              )
              return catOptions.length === 0 ? (
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
                  ยังไม่มีหมวดหมู่ในสินค้า (หรือไม่มีสินค้า active ที่ระบุหมวด)
                </p>
              ) : (
                <div className="max-h-72 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100 mb-4">
                  {catOptions.map((cat) => (
                    <label
                      key={cat}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={categoryModalDraft.includes(cat)}
                        onChange={() => {
                          setCategoryModalDraft((prev) =>
                            prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
                          )
                        }}
                        className="rounded border-gray-300"
                      />
                      <span className="text-gray-800">{cat}</span>
                    </label>
                  ))}
                </div>
              )
            })()}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCategoryModalDept(null)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => {
                  const dept = categoryModalDept
                  const sorted = [...categoryModalDraft].sort((a, b) => a.localeCompare(b))
                  const next: PlanSettingsData = {
                    ...settings,
                    departmentProductCategories: {
                      ...(settings.departmentProductCategories || {}),
                      [dept]: sorted,
                    },
                  }
                  setSettings(next)
                  saveSettings(next)
                  setCategoryModalDept(null)
                }}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                บันทึก
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal ล้าง: แสดงเฉพาะยืนยันล้าง (รหัสปลดล็อคใส่ด้านบน) */}
      <Modal
        open={clearStepModal.open}
        onClose={() => {
          setClearStepModal((prev) => ({ ...prev, open: false, jobId: null, dept: null, procName: '', step: 'confirm', resultMessage: '' }))
        }}
        contentClassName="max-w-md"
        closeOnBackdropClick={false}
      >
        <div className="p-6">
          {clearStepModal.step === 'confirm' ? (
            <>
              <h3 className="text-lg font-bold text-gray-800 mb-2">ล้างเวลาเริ่ม</h3>
              <p className="text-sm text-gray-600 mb-4">
                ยืนยันล้างเวลาเริ่มของขั้นตอน &quot;{clearStepModal.procName}&quot;?
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setClearStepModal((prev) => ({ ...prev, open: false }))}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  ยกเลิก
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (!clearStepModal.jobId || !clearStepModal.dept) return
                    try {
                      await backStep(clearStepModal.jobId, clearStepModal.dept, { skipConfirm: true })
                      setClearStepModal((prev) => ({ ...prev, step: 'result', resultMessage: 'ล้างเรียบร้อย' }))
                    } catch (e: any) {
                      setClearStepModal((prev) => ({ ...prev, step: 'result', resultMessage: 'เกิดข้อผิดพลาด: ' + (e?.message || e) }))
                    }
                  }}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
                >
                  ยืนยัน
                </button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-lg font-bold text-gray-800 mb-2">ผลการดำเนินการ</h3>
              <p className="text-sm text-gray-600 mb-4">{clearStepModal.resultMessage}</p>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setClearStepModal((prev) => ({ ...prev, open: false, jobId: null, dept: null, procName: '', step: 'confirm', resultMessage: '' }))}
                  className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900"
                >
                  ปิด
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>
      {/* Cancelled Bills Detail Modal */}
      <Modal open={!!cancelledDetailWO} onClose={() => { setCancelledDetailWO(null); setSelectedCancelledOrderId(null); setCancelledWmsLines([]) }} contentClassName="max-w-6xl w-full max-h-[85vh] overflow-y-auto">
        {cancelledDetailWO && (
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-gray-200 pb-3">
              <h3 className="text-lg font-bold text-gray-800">
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-red-100 text-red-600 mr-2">
                  <i className="fas fa-ban text-sm"></i>
                </span>
                บิลที่ยกเลิกในใบงาน {jobs.find((j) => String(j.work_order_id || '') === cancelledDetailWO)?.name || cancelledDetailWO}
              </h3>
            </div>

            {/* รายชื่อบิลที่ยกเลิก */}
            {(cancelledByWO[cancelledDetailWO] || []).length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm font-semibold text-red-800 mb-2">บิลที่ยกเลิก:</p>
                <div className="flex flex-wrap gap-2">
                  {cancelledByWO[cancelledDetailWO].map((o) => (
                    <button
                      key={o.id}
                      onClick={() => loadCancelledWmsLines(cancelledDetailWO, o.id)}
                      className={`px-2 py-1 border rounded-lg text-sm transition ${
                        selectedCancelledOrderId === o.id
                          ? 'bg-red-100 border-red-300'
                          : 'bg-white border-red-200 hover:bg-red-50'
                      }`}
                    >
                      <span className="font-mono font-bold text-red-700">{o.bill_no}</span>
                      <span className="text-gray-500 ml-1">({o.customer_name})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* WMS Lines ที่ต้องดำเนินการ */}
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">รายการ WMS ที่ถูกยกเลิก</h4>
              {cancelledWmsLoading ? (
                <div className="flex justify-center py-8">
                  <span className="animate-spin rounded-full h-8 w-8 border-2 border-red-500 border-t-transparent" />
                </div>
              ) : cancelledWmsLines.length === 0 ? (
                <div className="text-center py-6 text-gray-400">
                  <i className="fas fa-check-circle text-green-500 text-2xl mb-2 block"></i>
                  <p>ไม่มีรายการ WMS ที่รอดำเนินการ</p>
                  <p className="text-xs text-gray-400 mt-2">
                    หากหน้าแจ้งเตือนมีรายการ แต่หน้าต่างนี้ว่าง ให้รีเฟรชหน้าแล้วลองเปิดใหม่อีกครั้ง
                  </p>
                </div>
              ) : (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-left text-gray-600">
                        <th className="px-3 py-2 font-semibold">รูป</th>
                        <th className="px-3 py-2 font-semibold">รหัสสินค้า</th>
                        <th className="px-3 py-2 font-semibold">ชื่อสินค้า</th>
                        <th className="px-3 py-2 font-semibold">จำนวน</th>
                        <th className="px-3 py-2 font-semibold">สถานะสต๊อก</th>
                        <th className="px-3 py-2 font-semibold text-center">ดำเนินการ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {cancelledWmsLines.map((line: any) => (
                        <tr key={line.id}>
                          <td className="px-3 py-2">
                            <img
                              src={getProductImageUrl(line.product_code)}
                              alt={line.product_name || line.product_code || 'product'}
                              className="w-9 h-9 object-cover rounded border border-gray-200 bg-white"
                              onError={(e) => {
                                const target = e.target as HTMLImageElement
                                target.src = 'https://placehold.co/80x80?text=NO+IMG'
                              }}
                            />
                          </td>
                          <td className="px-3 py-2 font-mono">{line.product_code}</td>
                          <td className="px-3 py-2">{line.product_name || '-'}</td>
                          <td className="px-3 py-2">{line.qty}</td>
                          <td className="px-3 py-2">
                            {line.stock_action === 'recalled' ? (
                              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">เรียกคืนแล้ว</span>
                            ) : line.stock_action === 'waste' ? (
                              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">ของเสีย</span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">รอดำเนินการ</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {!line.stock_action && unlocked ? (
                              <div className="flex gap-2 justify-center">
                                <button
                                  onClick={() => handleStockAction(line.id, 'recall')}
                                  disabled={stockActionLoading === line.id}
                                  className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-bold hover:bg-green-700 disabled:opacity-50 transition"
                                >
                                  {stockActionLoading === line.id ? '...' : 'คืนสต๊อค'}
                                </button>
                                <button
                                  onClick={() => handleStockAction(line.id, 'waste')}
                                  disabled={stockActionLoading === line.id}
                                  className="px-3 py-1.5 bg-orange-600 text-white rounded-lg text-xs font-bold hover:bg-orange-700 disabled:opacity-50 transition"
                                >
                                  {stockActionLoading === line.id ? '...' : 'ตีเป็นของเสีย'}
                                </button>
                              </div>
                            ) : !line.stock_action ? (
                              <span className="text-gray-400 text-xs">รอผู้มีสิทธิ์ดำเนินการ</span>
                            ) : (
                              <span className="text-gray-400 text-xs">ดำเนินการแล้ว</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => { setCancelledDetailWO(null); setSelectedCancelledOrderId(null); setCancelledWmsLines([]) }}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50 transition"
              >
                ปิด
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Bills released back to work-queue (ย้ายไปใบสั่งงาน) */}
      <Modal
        open={!!releasedDetailWO}
        onClose={() => {
          setReleasedDetailWO(null)
          setSelectedReleasedOrderId(null)
          setReleasedOrderLines([])
        }}
        contentClassName="max-w-4xl w-full max-h-[85vh] overflow-y-auto"
      >
        {releasedDetailWO && (
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-gray-200 pb-3">
              <h3 className="text-lg font-bold text-gray-800">
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-700 mr-2">
                  <i className="fas fa-share-square text-sm"></i>
                </span>
                บิลที่ย้ายไปใบสั่งงานจากใบงาน {jobs.find((j) => String(j.work_order_id || '') === releasedDetailWO)?.name || releasedByWO[releasedDetailWO]?.[0]?.wo_name || releasedDetailWO}
              </h3>
            </div>
            <p className="text-sm text-gray-600">
              รายการด้านล่างเป็นบิลที่ถูกนำกลับไปอยู่ในคิว &quot;ใบสั่งงาน&quot; จากใบงานนี้ (ดูรายการสินค้าในแต่ละบิล)
            </p>
            {(releasedByWO[releasedDetailWO] || []).length > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-sm font-semibold text-blue-900 mb-2">เลือกบิล:</p>
                <div className="flex flex-wrap gap-2">
                  {releasedByWO[releasedDetailWO].map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => loadReleasedOrderLines(o.id)}
                      className={`px-2 py-1 border rounded-lg text-sm transition ${
                        selectedReleasedOrderId === o.id
                          ? 'bg-blue-100 border-blue-400'
                          : 'bg-white border-blue-200 hover:bg-blue-50/80'
                      }`}
                    >
                      <span className="font-mono font-bold text-blue-800">{o.bill_no}</span>
                      <span className="text-gray-600 ml-1">({o.customer_name})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">รายการสินค้าในบิลที่เลือก</h4>
              {releasedLinesLoading ? (
                <div className="flex justify-center py-8">
                  <span className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" />
                </div>
              ) : !selectedReleasedOrderId ? (
                <p className="text-center py-6 text-gray-400 text-sm">เลือกบิลด้านบนเพื่อดูรายการสินค้า</p>
              ) : releasedOrderLines.length === 0 ? (
                <p className="text-center py-6 text-gray-400 text-sm">ไม่มีรายการสินค้าในบิลนี้</p>
              ) : (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-left text-gray-600">
                        <th className="px-3 py-2 font-semibold">รูป</th>
                        <th className="px-3 py-2 font-semibold">ชื่อสินค้า</th>
                        <th className="px-3 py-2 font-semibold">จำนวน</th>
                        {isSuperadmin && <th className="px-3 py-2 font-semibold">ราคา/หน่วย</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {releasedOrderLines.map((line: any) => (
                        <tr key={line.id}>
                          <td className="px-3 py-2">
                            <img
                              src={getProductImageUrl(line.product_code)}
                              alt={line.product_name || line.product_code || 'product'}
                              className="w-9 h-9 object-cover rounded border border-gray-200 bg-white"
                              onError={(e) => {
                                const target = e.target as HTMLImageElement
                                target.src = 'https://placehold.co/80x80?text=NO+IMG'
                              }}
                            />
                          </td>
                          <td className="px-3 py-2">{line.product_name || '-'}</td>
                          <td className="px-3 py-2">{line.quantity ?? '-'}</td>
                          {isSuperadmin && (
                            <td className="px-3 py-2 tabular-nums">
                              {line.unit_price != null ? Number(line.unit_price).toLocaleString('th-TH', { minimumFractionDigits: 2 }) : '-'}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => {
                  setReleasedDetailWO(null)
                  setSelectedReleasedOrderId(null)
                  setReleasedOrderLines([])
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50 transition"
              >
                ปิด
              </button>
            </div>
          </div>
        )}
      </Modal>

      </div>
    </div>
  )
}
