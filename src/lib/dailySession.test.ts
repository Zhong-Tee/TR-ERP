import { describe, it, expect } from 'vitest'
import { isSessionExpired, sessionDayKey } from './dailySession'

const at = (y: number, mo: number, d: number, h: number, m = 0) => new Date(y, mo - 1, d, h, m, 0)

describe('sessionDayKey', () => {
  it('ระหว่างวัน → วันที่ของวันนั้น', () => {
    expect(sessionDayKey(at(2026, 8, 6, 9))).toBe('2026-08-06')
    expect(sessionDayKey(at(2026, 8, 6, 23, 30))).toBe('2026-08-06')
  })
  it('หลังเที่ยงคืนแต่ก่อน 04:00 → ยังนับเป็นวันก่อนหน้า', () => {
    expect(sessionDayKey(at(2026, 8, 7, 1, 15))).toBe('2026-08-06')
    expect(sessionDayKey(at(2026, 8, 7, 3, 59))).toBe('2026-08-06')
  })
  it('ตั้งแต่ 04:00 → วันใหม่', () => {
    expect(sessionDayKey(at(2026, 8, 7, 4, 0))).toBe('2026-08-07')
  })
})

describe('isSessionExpired', () => {
  it('login เมื่อวาน แล้วเปิดเช้าวันนี้ → หมดอายุ', () => {
    expect(isSessionExpired('2026-08-06', at(2026, 8, 7, 7, 30))).toBe(true)
  })
  it('login เมื่อวานตอนเย็น แล้วใช้ต่อถึงตี 2 → ยังไม่หมดอายุ', () => {
    expect(isSessionExpired('2026-08-06', at(2026, 8, 7, 2, 0))).toBe(false)
  })
  it('วันเดียวกัน → ยังไม่หมดอายุ', () => {
    expect(isSessionExpired('2026-08-06', at(2026, 8, 6, 17, 0))).toBe(false)
  })
  it('ไม่เคยบันทึกวัน → ไม่ถือว่าหมดอายุ', () => {
    expect(isSessionExpired(null, at(2026, 8, 7, 9, 0))).toBe(false)
  })
})
