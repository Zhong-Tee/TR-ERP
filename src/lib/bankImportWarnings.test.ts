import { describe, expect, it } from 'vitest'
import { formatBankImportWarning } from './bankImportWarnings'

describe('bank import warning display', () => {
  it('preserves text warnings from CSV parsers', () => expect(formatBankImportWarning('ยอดรวมไม่ตรง')).toBe('ยอดรวมไม่ตรง'))
  it('describes an imported file needing another matching attempt', () => expect(formatBankImportWarning({ code: 'auto_match_failed', message: 'internal failure' })).toContain('นำเข้าข้อมูลแล้ว'))
  it('shows a row-level guard warning as readable text', () => expect(formatBankImportWarning({ code: 'auto_match_skipped', message: 'บิลถูกจับคู่ครบแล้ว' })).toContain('บิลถูกจับคู่ครบแล้ว'))
  it('handles older or malformed warning entries safely', () => {
    expect(formatBankImportWarning({ message: 'ตรวจยอด' })).toBe('ตรวจยอด')
    expect(typeof formatBankImportWarning(null)).toBe('string')
    expect(typeof formatBankImportWarning({})).toBe('string')
  })
})
