import { describe, expect, it } from 'vitest'
import { normalizeBankAccount, parseBankStatementCsv } from './bankStatement'

const KBANK_SAMPLE = `รายการเดินบัญชีเงินฝากออมทรัพย์ (มีรายละเอียด),,,,,,,,,,,,
K-DEPOSIT STATEMENT OF SAVING ACCOUNT (WITH DETAIL),,,,,,,,,,,,
,ที่ DD.048 : N1/2569,หน้าที่ 1/1,,,0723,,,,,,,
,ชื่อบัญชี,"บริษัท ตัวอย่าง\nกรุงเทพ",,,,,เลขที่อ้างอิง,,,,REF001,
,,,,,,,เลขที่บัญชีเงินฝาก,,,,167-8-27895-1,
,,,,,,,รอบระหว่างวันที่,,,,18/09/2026 - 18/09/2026,
,,,,,,,ยอดยกไป,,,,,"65,791.44"
,,,,,,,รวมถอนเงิน,,0,,รายการ,0.00
,,,,,,,รวมฝากเงิน,,2,,รายการ,327.00
,วันที่,เวลา/ วันที่มีผล,รายการ,ถอนเงิน,,ฝากเงิน,,ยอดคงเหลือ,,ช่องทาง,,รายละเอียด
,18-09-26,,ยอดยกมา,,,,,"65,464.44",,,,
,18-09-26,08:30,รับโอนเงิน,,,218.00,,"65,682.44",,K PLUS,,จาก X5264 ผู้โอนหนึ่ง
,18-09-26,09:25,รับโอนเงิน,,,109.00,,"65,791.44",,Internet/Mobile KTB,,จาก KTB X0452 ผู้โอนสอง`

describe('bank statement parser', () => {
  it('parses KBank savings CSV and reconciles control totals', () => {
    const result = parseBankStatementCsv(KBANK_SAMPLE)
    expect(result.bankCode).toBe('004')
    expect(result.accountNumber).toBe('167-8-27895-1')
    expect(result.periodStart).toBe('2026-09-18')
    expect(result.periodEnd).toBe('2026-09-18')
    expect(result.openingBalance).toBe(65464.44)
    expect(result.closingBalance).toBe(65791.44)
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions.reduce((sum, row) => sum + row.creditAmount, 0)).toBe(327)
    expect(result.transactions[0].transactionAt).toBe('2026-09-18T08:30:00+07:00')
    expect(result.warnings).toEqual([])
  })

  it('rejects an unsupported bank format', () => {
    expect(() => parseBankStatementCsv('date,amount\n2026-09-18,100')).toThrow(/ยังไม่ใช่รูปแบบ Statement กสิกร/)
  })

  it('normalizes account numbers for matching', () => {
    expect(normalizeBankAccount('167-8-27895-1')).toBe('1678278951')
  })
})
