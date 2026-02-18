/**
 * Shared Plan utility functions and types
 * Used by Plan.tsx (desktop) and ProductionWorkQueue.tsx (mobile)
 */

// --- Types ---
export interface ProcessStep {
  name: string
  type: 'per_piece' | 'fixed'
  value: number
}

export interface PlanSettingsData {
  dayStart: string
  dayEnd: string
  departments: string[]
  processes: Record<string, ProcessStep[]>
  prepPerJob: Record<string, number>
  deptBreaks: Record<string, { start: string; end: string }[]>
  linesPerDept: Record<string, number>
}

export interface PlanJob {
  id: string
  date: string
  name: string
  cut: string | null
  qty: Record<string, number>
  tracks: Record<string, Record<string, { start: string | null; end: string | null }>>
  line_assignments: Record<string, number>
  manual_plan_starts?: Record<string, string>
  locked_plans?: Record<string, { start: number; end: number }>
  order_index: number
  created_at?: string
}

export interface TimelineItem {
  id: string
  start: number
  end: number
  dur: number
  line: number
}

export const defaultSettings: PlanSettingsData = {
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
}

/** แผนกที่บันทึกเวลาอัตโนมัติ (ไม่ได้กดเริ่ม/เสร็จจากหน้า Plan) */
export const AUTO_TRACK_DEPTS: Record<string, string> = {
  'เบิก': 'บันทึกจาก WMS อัตโนมัติ',
  'QC': 'บันทึกจากหน้า QC อัตโนมัติ',
  'PACK': 'บันทึกจากหน้าแพ็คสินค้าอัตโนมัติ',
}

// --- Utility functions ---
export const pad = (n: number) => String(Math.floor(n)).padStart(2, '0')

export const parseTimeToMin = (t: string | null | undefined): number => {
  if (!t || typeof t !== 'string') return 0
  const parts = t.split(':')
  if (parts.length < 2) return 0
  const [H, M] = parts.map(Number)
  if (Number.isNaN(H) || Number.isNaN(M)) return 0
  return H * 60 + M
}

export const minToHHMM = (m: number) => {
  const totalMinutes = Math.floor(m)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${pad(hours)}:${pad(minutes)}`
}

export const secToHHMM = (s: number | null | undefined): string => {
  if (s == null || Number.isNaN(s) || s === -Infinity || s === Infinity) return '--:--'
  return minToHHMM(s / 60)
}

export const nowISO = () => new Date().toISOString()

export const sameDay = (d1: string, d2: string) => d1 === d2

export const fmtLocalHHMM = (iso: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const fmtCutTime = (t: string | null | undefined) => {
  if (!t) return '-'
  const raw = String(t).trim()
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])$/)
  if (match) {
    let h = Number(match[1])
    const m = Number(match[2])
    const isPm = match[3].toLowerCase() === 'pm'
    if (isPm && h < 12) h += 12
    if (!isPm && h === 12) h = 0
    return `${pad(h)}:${pad(m)}`
  }
  return raw.length >= 5 ? raw.substring(0, 5) : raw
}

// --- Job status & qty helpers ---
export function getEffectiveQty(job: PlanJob, dept: string, _settings: PlanSettingsData): number {
  if (dept === 'เบิก') {
    return (Number(job.qty?.['STAMP']) || 0) + (Number(job.qty?.['LASER']) || 0) + (Number(job.qty?.['ETC']) || 0)
  }
  if (dept === 'QC') return Number(job.qty?.['PACK']) || 0
  return Number(job.qty?.[dept]) || 0
}

export function getJobStatusForDept(
  job: PlanJob,
  dept: string,
  settings: PlanSettingsData
): { text: string; key: 'pending' | 'progress' | 'done' } {
  const procs = (settings.processes[dept] || []).map((p) => p.name)
  const tracks = job.tracks?.[dept] || {}
  const trackEntries = Object.entries(tracks).filter(([key]) => key !== 'เตรียมไฟล์')

  if (procs.length === 0 && trackEntries.length === 0) return { text: 'รอดำเนินการ', key: 'pending' }

  const completedSettingsSteps = procs.filter((p) => tracks[p]?.end).length
  if (procs.length > 0 && completedSettingsSteps === procs.length) return { text: 'เสร็จแล้ว', key: 'done' }
  if (completedSettingsSteps === 0 && trackEntries.length > 0 && trackEntries.every(([, t]) => t?.end)) {
    return { text: 'เสร็จแล้ว', key: 'done' }
  }

  if (Object.values(tracks).some((t) => t?.start)) {
    const currentStep = procs.find((p) => tracks[p]?.start && !tracks[p]?.end)
    if (currentStep) return { text: currentStep, key: 'progress' }
    const activeEntry = trackEntries.find(([, t]) => t?.start && !t?.end)
    if (activeEntry) return { text: activeEntry[0], key: 'progress' }
    const pendingStep = procs.find((p) => !tracks[p]?.end)
    return { text: pendingStep || 'กำลังทำ', key: 'progress' }
  }

  return { text: 'รอดำเนินการ', key: 'pending' }
}

// --- Timeline computation helpers ---
function calcPlanFor(dept: string, job: PlanJob, settings: PlanSettingsData): number {
  const q = getEffectiveQty(job, dept, settings)
  if (!q) return 0
  let processTotalSec = 0
  ;(settings.processes[dept] || []).forEach((p) => {
    if (p.type === 'per_piece') processTotalSec += (p.value || 0) * q
    else if (p.type === 'fixed') processTotalSec += p.value || 0
  })
  const minSec = (settings.prepPerJob?.[dept] || 0) * 60
  return Math.max(minSec, processTotalSec)
}

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

function getPlannedStartSecForDept(
  dept: string,
  job: PlanJob,
  precomputed: Record<string, TimelineItem[]>
): number {
  const tl = precomputed[dept]
  if (!tl) return 0
  const me = tl.find((x) => x.id === job.id)
  return me ? me.start : 0
}

function getPlannedEndSecForDept(
  dept: string,
  job: PlanJob,
  precomputed: Record<string, TimelineItem[]>
): number {
  const tl = precomputed[dept]
  if (!tl) return 0
  const me = tl.find((x) => x.id === job.id)
  return me ? me.end : 0
}

function getEffectiveFinishSec(
  dept: string,
  job: PlanJob,
  precomputed: Record<string, TimelineItem[]>
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

export function computePlanTimeline(
  dept: string,
  date: string,
  settings: PlanSettingsData,
  jobs: PlanJob[],
  _anchor: string = 'cut',
  opts: { precomputed?: Record<string, TimelineItem[]> } = {}
): TimelineItem[] {
  const lines = Math.max(1, settings.linesPerDept?.[dept] || 1)
  const dayStartSec = parseTimeToMin(settings.dayStart) * 60
  const breakPeriodsSec = (settings.deptBreaks[dept] || [])
    .map((b) => ({ start: parseTimeToMin(b.start) * 60, end: parseTimeToMin(b.end) * 60 }))
    .sort((a, b) => a.start - b.start)

  const jobsOnDate = jobs
    .filter((j) => sameDay(j.date, date) && getEffectiveQty(j, dept, settings) > 0)
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
    const jHasActual = Object.values(j.tracks?.[dept] || {}).some((t) => t?.start || t?.end)

    if (prevJobsOnLine.length > 0) {
      const lastRes = prevJobsOnLine[prevJobsOnLine.length - 1]
      const lastJob = jobs.find((jb) => jb.id === lastRes.id)
      const actualLastEnd = lastJob ? getLatestActualEndSecForDept(lastJob, dept) : 0
      const flowDepts = ['QC', 'STAMP', 'LASER']
      if (flowDepts.includes(dept)) {
        prevEnd = actualLastEnd > 0 ? actualLastEnd : lastRes.end
      } else if (jHasActual) {
        prevEnd = lastRes.end
      } else {
        prevEnd = actualLastEnd > 0 ? actualLastEnd : lastRes.end
      }
    }

    let stdDuration = calcPlanFor(dept, j, settings)
    const cutSec = j.cut ? parseTimeToMin(j.cut) * 60 : -Infinity
    let base = Math.max(prevEnd, Number.isFinite(cutSec) ? cutSec : 0)
    let finalDur = stdDuration

    const delayDepts = ['เบิก', 'STK', 'CTT', 'TUBE']
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
          if (getEffectiveQty(j, preDept, settings) > 0) {
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
        const qcActStart = getEarliestActualStartSecForDept(j, 'QC')
        const qcPlanStart = getPlannedStartSecForDept('QC', j, precomputed)
        const qcStartSec = qcActStart > 0 ? qcActStart : qcPlanStart
        const qcFinishSec = getEffectiveFinishSec('QC', j, precomputed)
        if (qcStartSec > 0 && qcFinishSec > 0) {
          base = Math.max(base, qcStartSec + 300)
          const targetEnd = qcFinishSec + 300
          finalDur = Math.max(stdDuration, targetEnd - base)
        }
      }
    }

    const { start, end } = adjustForBreaks(base, finalDur, breakPeriodsSec)
    results.push({ id: j.id, start, end, dur: finalDur, line: li })
    lineLastEnd[li] = end
  }
  return results
}
