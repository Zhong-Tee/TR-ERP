import { lateDurationMinutes } from './lateDuration'
import type { HRTimeEntry, HRWorkSchedule, HRLeaveRequest, HRWFHRequest } from '../types'

function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + (minutes || 0)
}

/** Shared late calculation for live attendance and monthly summaries. */
export function attendanceLateMinutes(
  entry: HRTimeEntry,
  sched: Pick<HRWorkSchedule, 'work_start' | 'late_grace_min'>,
  leaves: HRLeaveRequest[],
  wfhRequests: HRWFHRequest[],
): number {
  if (entry.entry_type !== 'clock_in') return 0
  const actual = new Date(entry.entry_time)
  const actualMin = actual.getHours() * 60 + actual.getMinutes()
  const wfh = wfhRequests.find((r) =>
    r.employee_id === entry.employee_id && r.start_date <= entry.work_date && r.end_date >= entry.work_date,
  )
  let expectedMin = wfh?.start_time
    ? parseTimeToMinutes(wfh.start_time.slice(0, 5))
    : parseTimeToMinutes(sched.work_start.slice(0, 5))

  const dayLeaves = leaves.filter((r) =>
    r.employee_id === entry.employee_id && r.start_date <= entry.work_date && r.end_date >= entry.work_date,
  )
  // ลาเต็มวัน หรือบันทึกเข้าในช่วงลาที่อนุมัติแล้ว: ไม่แสดงว่าสาย
  if (dayLeaves.some((r) => r.leave_mode !== 'hourly')) return 0
  const ranges = dayLeaves
    .filter((r) => r.leave_mode === 'hourly' && r.start_time && r.end_time)
    .map((r) => [parseTimeToMinutes(r.start_time!.slice(0, 5)), parseTimeToMinutes(r.end_time!.slice(0, 5))] as const)
    .sort((a, b) => a[0] - b[0])
  if (ranges.some(([start, end]) => actualMin >= start && actualMin <= end)) return 0
  // ถ้าลาต่อเนื่องจากเวลาเริ่มงาน ให้เลื่อนเวลาเริ่มที่คาดหวังไปหลังสิ้นสุดการลา
  for (const [start, end] of ranges) {
    if (start <= expectedMin && end > expectedMin) expectedMin = end
  }

  return lateDurationMinutes(actualMin, expectedMin, sched.late_grace_min ?? 0)
}
