import { describe, it, expect } from 'vitest'
import {
  normalizePhoneString,
  toE164,
  e164ToLocal,
  extractPhoneCandidates,
  extractPhonesFromText,
} from './thaiPhone'

describe('normalizePhoneString', () => {
  it('removes spaces, hyphens, dots, parentheses', () => {
    expect(normalizePhoneString('081-234-5678')).toBe('0812345678')
    expect(normalizePhoneString('+66 81 234 5678')).toBe('+66812345678')
    expect(normalizePhoneString('(081) 234.5678')).toBe('0812345678')
  })
})

describe('toE164', () => {
  it('0xxxxxxxxx → +66xxxxxxxxx', () => {
    expect(toE164('0812345678')).toBe('+66812345678')
    expect(toE164('0912345678')).toBe('+66912345678')
    expect(toE164('0612345678')).toBe('+66612345678')
  })
  it('+66... → +66... (9 digits)', () => {
    expect(toE164('+66812345678')).toBe('+66812345678')
    expect(toE164('+66 81 234 5678')).toBe('+66812345678')
  })
  it('66... → +66...', () => {
    expect(toE164('66812345678')).toBe('+66812345678')
    expect(toE164('66 812345678')).toBe('+66812345678')
  })
  it('invalid returns empty', () => {
    expect(toE164('0512345678')).toBe('') // 05 not mobile
    expect(toE164('123')).toBe('')
  })
})

describe('extractPhoneCandidates', () => {
  it('โทร 081-234-5678 → +66812345678', () => {
    expect(extractPhoneCandidates('โทร 081-234-5678')).toEqual(['+66812345678'])
  })
  it('เบอร์ +66 81 234 5678 → +66812345678', () => {
    expect(extractPhoneCandidates('เบอร์ +66 81 234 5678')).toEqual(['+66812345678'])
  })
  it('66 812345678 → +66812345678', () => {
    expect(extractPhoneCandidates('66 812345678')).toEqual(['+66812345678'])
  })
  it('0812345678 → +66812345678', () => {
    expect(extractPhoneCandidates('0812345678')).toEqual(['+66812345678'])
  })
  it('+66812345678 → +66812345678', () => {
    expect(extractPhoneCandidates('+66812345678')).toEqual(['+66812345678'])
  })
  it('06-1234-5678 → +66612345678 (ตัด 0 หน้า)', () => {
    expect(extractPhoneCandidates('06-1234-5678')).toEqual(['+66612345678'])
  })
  it('(081) 234-5678 → +66812345678', () => {
    expect(extractPhoneCandidates('(081) 234-5678')).toEqual(['+66812345678'])
  })
  it('0912345678 → +66912345678', () => {
    expect(extractPhoneCandidates('0912345678')).toEqual(['+66912345678'])
  })
  it('081 234 5678 → +66812345678', () => {
    expect(extractPhoneCandidates('081 234 5678')).toEqual(['+66812345678'])
  })
  it('no phone → []', () => {
    expect(extractPhoneCandidates('ที่อยู่ 123 ถนนสุขุมวิท')).toEqual([])
  })
  it('two phones → two E.164 unique', () => {
    const r = extractPhoneCandidates('โทร 081-234-5678 หรือ 091-111-2233')
    expect(r).toContain('+66812345678')
    expect(r).toContain('+66911112233')
    expect(r).toHaveLength(2)
  })
  it('081-456-7890 → +66814567890', () => {
    expect(extractPhoneCandidates('โทร: 081-456-7890')).toEqual(['+66814567890'])
  })
})

describe('extractPhonesFromText', () => {
  it('returns candidates and rest without phone', () => {
    const { candidates, rest } = extractPhonesFromText('55/12 ถนนรามคำแหง 10240 โทร 081-234-5678')
    expect(candidates).toEqual(['+66812345678'])
    expect(rest).not.toContain('081')
    expect(rest).toContain('55/12')
    expect(rest).toContain('10240')
  })
  it('โทร 081-234-5678 → candidates [+66812345678], rest without number', () => {
    const { candidates, rest } = extractPhonesFromText('โทร 081-234-5678')
    expect(candidates).toEqual(['+66812345678'])
    expect(rest.replace(/\s/g, '')).not.toMatch(/081/)
  })
  it('empty text → empty candidates and rest', () => {
    const { candidates, rest } = extractPhonesFromText('')
    expect(candidates).toEqual([])
    expect(rest).toBe('')
  })
  it('ไม่มีคำว่าโทร มีแต่เบอร์ → แยกได้', () => {
    const { candidates, rest } = extractPhonesFromText('ที่อยู่ 123 0812345678')
    expect(candidates).toEqual(['+66812345678'])
    expect(rest).toContain('ที่อยู่ 123')
    expect(rest).not.toMatch(/0812345678/)
  })
  it('มี Tel อยู่ด้านหน้า → แยกได้และตัด Tel ออกจาก rest', () => {
    const { candidates, rest } = extractPhonesFromText('ที่อยู่ 55/12 Tel 081-234-5678')
    expect(candidates).toEqual(['+66812345678'])
    expect(rest).toContain('ที่อยู่ 55/12')
    expect(rest).not.toMatch(/Tel/)
    expect(rest).not.toMatch(/081/)
  })
  it('มี โทร อยู่ด้านหน้า → แยกได้และตัด โทร ออกจาก rest', () => {
    const { candidates, rest } = extractPhonesFromText('ที่อยู่ 55/12 โทร 081-234-5678')
    expect(candidates).toEqual(['+66812345678'])
    expect(rest).not.toMatch(/โทร/)
    expect(rest).not.toMatch(/081/)
  })
})

describe('e164ToLocal', () => {
  it('+66835671234 → 0835671234', () => {
    expect(e164ToLocal('+66835671234')).toBe('0835671234')
  })
  it('+66812345678 → 0812345678', () => {
    expect(e164ToLocal('+66812345678')).toBe('0812345678')
  })
})

describe('extractPhoneCandidates - รหัสไปรษณีย์ติดกับเบอร์', () => {
  it('11120 083-567-1234 (มีช่องว่าง) → แยกได้', () => {
    expect(extractPhoneCandidates('45/7 หมู่ 3 ตำบลปากเกร็ด นนทบุรี 11120 083-567-1234')).toEqual(['+66835671234'])
  })
  it('111200835671234 (รหัสไปรษณีย์ติดเบอร์ไม่มีช่องว่าง) → แยกได้', () => {
    expect(extractPhoneCandidates('นนทบุรี111200835671234')).toEqual(['+66835671234'])
  })
})
