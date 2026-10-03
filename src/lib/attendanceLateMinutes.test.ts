import { describe, expect, it } from 'vitest'
import type { HRTimeEntry, HRLeaveRequest, HRWFHRequest } from '../types'
import { attendanceLateMinutes } from './attendanceLateMinutes'

const schedule = { work_start: '08:30', late_grace_min: 5 }
const entry = (hour: number, minute: number, employeeId = 'emp1') => ({
  employee_id: employeeId, work_date: '2026-09-30', entry_type: 'clock_in',
  entry_time: new Date(2026, 8, 30, hour, minute, 29).toISOString(),
} as HRTimeEntry)
const wfh = [{ employee_id: 'emp1', start_date: '2026-09-29', end_date: '2026-09-30', start_time: '14:00' } as HRWFHRequest]
const leave = (mode: string, start?: string, end?: string) => ({
  employee_id: 'emp1', start_date: '2026-09-30', end_date: '2026-09-30',
  leave_mode: mode, start_time: start, end_time: end,
} as HRLeaveRequest)

describe('shared attendance late calculation', () => {
  it('uses approved WFH start time for the screenshot scenario', () => {
    expect(attendanceLateMinutes(entry(14, 0), schedule, [], wfh)).toBe(0)
    expect(attendanceLateMinutes(entry(14, 15), schedule, [], wfh)).toBe(15)
    expect(attendanceLateMinutes(entry(14, 0, 'emp2'), schedule, [], wfh)).toBe(330)
  })
  it('applies grace and ignores seconds', () => {
    expect(attendanceLateMinutes(entry(8, 35), schedule, [], [])).toBe(0)
    expect(attendanceLateMinutes(entry(8, 45), schedule, [], [])).toBe(15)
  })
  it('excludes full day leave and clock-ins within hourly leave', () => {
    expect(attendanceLateMinutes(entry(14, 0), schedule, [leave('full_day')], [])).toBe(0)
    expect(attendanceLateMinutes(entry(9, 0), schedule, [leave('hourly', '08:30', '10:00')], [])).toBe(0)
  })
  it('moves the expected start past consecutive approved hourly leave', () => {
    const leaves = [leave('hourly', '09:30', '10:00'), leave('hourly', '08:30', '09:30')]
    expect(attendanceLateMinutes(entry(10, 15), schedule, leaves, [])).toBe(15)
  })
  it('counts only late days and sums their duration for a month', () => {
    const entries = [entry(8, 45), entry(8, 55), entry(14, 0)]
    const minutes = entries.map(e => attendanceLateMinutes(e, schedule, [], e === entries[2] ? wfh : []))
    expect(minutes.filter(m => m > 0)).toHaveLength(2)
    expect(minutes.reduce((sum, m) => sum + m, 0)).toBe(40)
  })
})
