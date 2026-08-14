import { describe, it, expect } from 'vitest'
import {
  coversDate,
  formatLateDuration,
  minutesPastWorkStart,
  parseTimeToMinutes,
  shouldWarnMissedClockIn,
} from './missedClockIn'

const at = (h: number, m: number) => new Date(2026, 7, 6, h, m, 0)

describe('parseTimeToMinutes', () => {
  it('รับได้ทั้ง HH:MM และ HH:MM:SS', () => {
    expect(parseTimeToMinutes('08:00')).toBe(480)
    expect(parseTimeToMinutes('08:30:00')).toBe(510)
  })
  it('ค่าว่าง/รูปแบบผิด → null', () => {
    expect(parseTimeToMinutes('')).toBeNull()
    expect(parseTimeToMinutes(undefined)).toBeNull()
    expect(parseTimeToMinutes('abc')).toBeNull()
  })
})

describe('minutesPastWorkStart', () => {
  it('ยังไม่ถึงเวลาเข้างาน → 0', () => {
    expect(minutesPastWorkStart(at(7, 45), '08:00')).toBe(0)
    expect(minutesPastWorkStart(at(8, 0), '08:00:00')).toBe(0)
  })
  it('เลยเวลาแล้ว → นาทีที่เลยมา', () => {
    expect(minutesPastWorkStart(at(8, 20), '08:00')).toBe(20)
    expect(minutesPastWorkStart(at(10, 5), '08:00')).toBe(125)
  })
})

describe('shouldWarnMissedClockIn', () => {
  const base = {
    now: at(9, 0),
    dayType: 'work' as const,
    workStart: '08:00:00',
    hasClockIn: false,
    onApprovedLeave: false,
    requiresClockIn: true,
  }

  it('วันทำงาน เลยเวลา ยังไม่บันทึก → เตือน', () => {
    expect(shouldWarnMissedClockIn(base)).toBe(true)
  })
  it('บันทึกเข้างานแล้ว → ไม่เตือน', () => {
    expect(shouldWarnMissedClockIn({ ...base, hasClockIn: true })).toBe(false)
  })
  it('ยังไม่ถึงเวลาเข้างาน → ไม่เตือน', () => {
    expect(shouldWarnMissedClockIn({ ...base, now: at(7, 30) })).toBe(false)
  })
  it('วันหยุดประจำสัปดาห์/วันหยุดบริษัท → ไม่เตือน', () => {
    expect(shouldWarnMissedClockIn({ ...base, dayType: 'weekly_off' })).toBe(false)
    expect(shouldWarnMissedClockIn({ ...base, dayType: 'company_holiday' })).toBe(false)
  })
  it('ลาที่อนุมัติแล้ว → ไม่เตือน', () => {
    expect(shouldWarnMissedClockIn({ ...base, onApprovedLeave: true })).toBe(false)
  })
  it('รูปแบบการทำงานไม่ต้องบันทึกเวลา → ไม่เตือน', () => {
    expect(shouldWarnMissedClockIn({ ...base, requiresClockIn: false })).toBe(false)
  })
})

describe('formatLateDuration', () => {
  it('แสดงชั่วโมง/นาทีตามที่มี', () => {
    expect(formatLateDuration(20)).toBe('20 นาที')
    expect(formatLateDuration(60)).toBe('1 ชม.')
    expect(formatLateDuration(80)).toBe('1 ชม. 20 นาที')
  })
})

describe('coversDate', () => {
  const reqs = [
    { start_date: '2026-08-05', end_date: '2026-08-07', status: 'approved' },
    { start_date: '2026-08-10', end_date: '2026-08-10', status: 'pending' },
  ]
  it('ใบลาอนุมัติที่ครอบคลุมวันนั้น → true', () => {
    expect(coversDate(reqs, '2026-08-06')).toBe(true)
    expect(coversDate(reqs, '2026-08-05')).toBe(true)
    expect(coversDate(reqs, '2026-08-07')).toBe(true)
  })
  it('นอกช่วง หรือยังไม่อนุมัติ → false', () => {
    expect(coversDate(reqs, '2026-08-08')).toBe(false)
    expect(coversDate(reqs, '2026-08-10')).toBe(false)
  })
})
