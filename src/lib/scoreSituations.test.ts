import { describe, it, expect } from 'vitest'
import { EVENT } from './workScore'
import type { ScoreRule } from './workScore'
import {
  SITUATIONS,
  COUNT_SOURCES,
  LATE_KEY,
  CUMULATIVE_KEY,
  situationOfRule,
  situationByKey,
  lateCode,
  cumulativeCode,
} from './scoreSituations'

const rule = (over: Partial<ScoreRule>): ScoreRule => ({
  id: 'r1',
  category_id: 'cat-1',
  group_code: 'attendance',
  event_code: 'late_1_15',
  name: 'test',
  points: -1,
  threshold_min: null,
  threshold_max: null,
  cap_per_month: null,
  applies_to: 'all',
  counts_event_prefix: null,
  points_step: 0,
  is_active: true,
  sort_order: 0,
  ...over,
})

const fixedCodes = SITUATIONS.filter((s) => s.kind === 'fixed').map((s) => s.code as string)

describe('แคตตาล็อกสถานการณ์ต้อง sync กับ engine', () => {
  it('ทุก event_code ที่ engine รู้จัก มีสถานการณ์ให้เลือกในหน้าตั้งค่า', () => {
    // ถ้าเทสนี้ตก = engine รู้จักเหตุการณ์ที่ตั้งค่าจาก UI ไม่ได้ (ตั้งไม่ได้เลย)
    expect([...fixedCodes].sort()).toEqual([...Object.values(EVENT)].sort())
  })

  it('ไม่มีสถานการณ์ที่ชี้ไปยังรหัสที่ engine ไม่รู้จัก', () => {
    // ถ้าเทสนี้ตก = ตั้งกติกาได้แต่จะไม่ถูกคิดคะแนนเลยแบบเงียบ ๆ
    const known = new Set<string>(Object.values(EVENT))
    expect(fixedCodes.filter((c) => !known.has(c))).toEqual([])
  })

  it('key ของสถานการณ์ไม่ซ้ำกัน', () => {
    const keys = SITUATIONS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('ทุกสถานการณ์อยู่ในหัวข้อย่อยที่ engine ใช้จริง', () => {
    const groups = new Set(['attendance', 'time_entry', 'leave', 'ot', 'attendance_cumulative'])
    expect(SITUATIONS.filter((s) => !groups.has(s.group))).toEqual([])
  })

  it('"นับจาก" ของกติกาสะสมทุกตัวเลือก match เหตุการณ์จริงได้อย่างน้อยหนึ่งอย่าง', () => {
    const codes = [...Object.values(EVENT) as string[], 'late_1_15', 'late_16_30']
    for (const src of COUNT_SOURCES) {
      expect(codes.some((c) => c.startsWith(src.prefix)), `prefix ${src.prefix} ไม่ match อะไรเลย`).toBe(true)
    }
  })
})

describe('situationOfRule', () => {
  it('ขั้นความสายทุกช่วง → สถานการณ์ "มาสาย"', () => {
    expect(situationOfRule(rule({ event_code: 'late_16_30' }))?.key).toBe(LATE_KEY)
    expect(situationOfRule(rule({ event_code: 'late_31_up' }))?.key).toBe(LATE_KEY)
  })

  it('กติกาสะสม → สถานการณ์ "ทำผิดซ้ำ"', () => {
    const r = rule({ event_code: 'late_repeat', group_code: 'attendance_cumulative', counts_event_prefix: 'late_' })
    expect(situationOfRule(r)?.key).toBe(CUMULATIVE_KEY)
  })

  it('รหัสตายตัว → สถานการณ์ที่ตรงกัน', () => {
    expect(situationOfRule(rule({ event_code: EVENT.absent, group_code: 'leave' }))?.key).toBe(EVENT.absent)
  })

  it('รหัสที่ engine ไม่รู้จัก → null (หน้าตั้งค่าจะเตือนว่าไม่ถูกคิดคะแนน)', () => {
    expect(situationOfRule(rule({ event_code: 'มาสายบ่อย', group_code: 'leave' }))).toBeNull()
    // late_ ที่อยู่ผิดหัวข้อย่อย engine ก็ข้าม (pickLateRule เช็ค group_code)
    expect(situationOfRule(rule({ event_code: 'late_1_15', group_code: 'leave' }))).toBeNull()
  })
})

describe('การสร้างรหัสอัตโนมัติ', () => {
  it('ขั้นความสาย — ช่วงปิดและช่วงเปิด', () => {
    expect(lateCode('16', '30')).toBe('late_16_30')
    expect(lateCode('31', '')).toBe('late_31_up')
    expect(lateCode('31', '  ')).toBe('late_31_up')
  })

  it('รหัสขั้นความสายที่สร้างขึ้น engine ต้องจับได้ (ขึ้นต้น late_)', () => {
    expect(lateCode('1', '15').startsWith('late_')).toBe(true)
    expect(situationOfRule(rule({ event_code: lateCode('45', '') }))?.key).toBe(LATE_KEY)
  })

  it('กติกาสะสม — เติมเลขท้ายเมื่อรหัสซ้ำ จึงตั้งหลายขั้นจากฐานเดียวกันได้', () => {
    expect(cumulativeCode('late_', new Set())).toBe('late_repeat')
    expect(cumulativeCode('late_', new Set(['late_repeat']))).toBe('late_repeat_2')
    expect(cumulativeCode('late_', new Set(['late_repeat', 'late_repeat_2']))).toBe('late_repeat_3')
  })

  it('รหัสสะสมที่สร้างขึ้นไม่ทับรหัสตายตัวของ engine', () => {
    const known = new Set<string>(Object.values(EVENT))
    for (const src of COUNT_SOURCES) {
      expect(known.has(cumulativeCode(src.prefix, new Set()))).toBe(false)
    }
  })

  it('situationByKey คืนค่า fallback ที่ปลอดภัยเมื่อ key ไม่รู้จัก', () => {
    expect(situationByKey('ไม่มีจริง')).toBe(SITUATIONS[0])
  })
})
