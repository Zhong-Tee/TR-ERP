import { describe, expect, it } from 'vitest'
import { addWorkingHours, type WorkingTimeData } from './hrTaskMetrics'
import type { HRCompanyHoliday, HREmployee, HREmployeeWorkCalendar, HRLeaveRequest, HRWorkSchedule } from '../types'

// จันทร์-ศุกร์ 09:00-18:00
const schedule = { id: 's1', name: 'ปกติ', work_start: '09:00', work_end: '18:00', late_grace_min: 0, work_days: '1,2,3,4,5', is_default: true, is_active: true } as HRWorkSchedule
const employee = { id: 'e1', work_schedule_id: 's1' } as HREmployee
const base = (over: Partial<WorkingTimeData> = {}): WorkingTimeData => ({ schedules: [schedule], calendar: [], holidays: [], leaves: [], ...over })

// อ้างอิง: จันทร์ 3 ส.ค. 2026
const mon10 = new Date(2026, 7, 3, 10, 0)

describe('addWorkingHours', () => {
  it('บวกภายในวันเดียวกันเมื่อเวลาพอ', () => {
    expect(addWorkingHours(mon10, 4, employee, base())).toEqual(new Date(2026, 7, 3, 14, 0))
  })

  it('ล้นไปเช้าวันถัดไปเมื่อเกินเวลาเลิกงาน', () => {
    // จันทร์ 10:00 + 10 ชม. → เหลือวันนี้ 8 ชม. (ถึง 18:00) + อีก 2 ชม. เช้าวันอังคาร = อังคาร 11:00
    expect(addWorkingHours(mon10, 10, employee, base())).toEqual(new Date(2026, 7, 4, 11, 0))
  })

  it('ข้ามเสาร์-อาทิตย์', () => {
    // ศุกร์ 7 ส.ค. 16:00 + 4 ชม. → ศุกร์เหลือ 2 ชม. + จันทร์ 10 ส.ค. อีก 2 ชม. = จันทร์ 11:00
    expect(addWorkingHours(new Date(2026, 7, 7, 16, 0), 4, employee, base())).toEqual(new Date(2026, 7, 10, 11, 0))
  })

  it('ข้ามวันหยุดบริษัทฯ', () => {
    const holidays = [{ holiday_date: '2026-08-04' } as HRCompanyHoliday]
    // จันทร์ 10:00 + 10 ชม. → อังคารเป็นวันหยุด → พุธ 11:00
    expect(addWorkingHours(mon10, 10, employee, base({ holidays }))).toEqual(new Date(2026, 7, 5, 11, 0))
  })

  it('ข้ามวันลาเต็มวันที่อนุมัติแล้ว', () => {
    const leaves = [{ status: 'approved', start_date: '2026-08-04', end_date: '2026-08-05', leave_mode: 'full_day' } as HRLeaveRequest]
    expect(addWorkingHours(mon10, 10, employee, base({ leaves }))).toEqual(new Date(2026, 7, 6, 11, 0))
  })

  it('หักช่วงลาเป็นชั่วโมง', () => {
    const leaves = [{ status: 'approved', start_date: '2026-08-03', end_date: '2026-08-03', leave_mode: 'hourly', start_time: '13:00', end_time: '15:00' } as HRLeaveRequest]
    // จันทร์ 10:00 + 4 ชม. → ทำ 10:00-13:00 (3 ชม.) ข้ามลา 13:00-15:00 แล้วทำต่ออีก 1 ชม. = 16:00
    expect(addWorkingHours(mon10, 4, employee, base({ leaves }))).toEqual(new Date(2026, 7, 3, 16, 0))
  })

  it('override รายวัน: หยุดพิเศษวันจันทร์ และทำงานวันเสาร์', () => {
    const calendar = [
      { employee_id: 'e1', work_date: '2026-08-03', day_type: 'weekly_off' } as HREmployeeWorkCalendar,
      { employee_id: 'e1', work_date: '2026-08-01', day_type: 'work' } as HREmployeeWorkCalendar,
    ]
    // เสาร์ 1 ส.ค. 10:00 (ปกติหยุด แต่ override เป็นทำงาน) + 10 ชม. → เสาร์ 8 ชม. ข้ามอาทิตย์+จันทร์(override หยุด) → อังคาร 11:00
    expect(addWorkingHours(new Date(2026, 7, 1, 10, 0), 10, employee, base({ calendar }))).toEqual(new Date(2026, 7, 4, 11, 0))
  })

  it('เริ่มก่อนเวลางาน → เริ่มนับที่ 09:00', () => {
    expect(addWorkingHours(new Date(2026, 7, 3, 6, 0), 2, employee, base())).toEqual(new Date(2026, 7, 3, 11, 0))
  })

  it('ไม่มีตารางเวลา → บวกตรง ๆ', () => {
    expect(addWorkingHours(mon10, 4, employee, base({ schedules: [] }))).toEqual(new Date(2026, 7, 3, 14, 0))
  })
})
