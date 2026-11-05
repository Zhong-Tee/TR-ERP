import { describe, expect, it } from 'vitest'
import * as ExcelJS from 'exceljs'
import { reconcileBilling, type BillingLine } from './transportBilling'
import { buildTransportBillingWorkbook } from './transportBillingExport'
const base: BillingLine = { file: 'bill.xlsx', sheet: 'Sheet1', row: 2, tracking: 'TH1', order: '', amount: 23, consignment: false, sender: 'Pump21', pickupDate: '2026-10-16' }
describe('transport billing export', () => {
  it('summarizes matched consignments by sender, group and day and retains all rows', async () => {
    const results = reconcileBilling([base, { ...base, row: 3, tracking: 'TH2', amount: 30, consignment: true }, { ...base, row: 4, tracking: 'TH3', amount: null }], [], [], [])
    const book = buildTransportBillingWorkbook(results)
    expect(book.worksheets.map(sheet => sheet.name)).toEqual(['สรุป', 'รายการทั้งหมด'])
    const summary = book.getWorksheet('สรุป')!
    const find = (label: string) => { let found = 0; summary.eachRow(row => { if (!found && row.getCell(1).value === label) found = row.number }); return summary.getRow(found) }
    expect(find('จับคู่สำเร็จ').getCell(2).value).toMatchObject({ result: 1 })
    expect(find('มีบิลไม่มีออเดอร์').getCell(2).value).toMatchObject({ result: 2 })
    expect(find('รวมกล่องทั้งหมดในบิล').getCell(3).value).toMatchObject({ result: 53 })
    expect(find('PUMP21').getCell(3).value).toMatchObject({ result: 30 })
    expect(find('Pump21').getCell(3).value).toMatchObject({ result: 30 })
    expect(find('2026-10-16').getCell(3).value).toMatchObject({ result: 30 })
    const restored = new ExcelJS.Workbook()
    await restored.xlsx.load(await book.xlsx.writeBuffer())
    const detail = restored.getWorksheet('รายการทั้งหมด')!
    expect(detail.rowCount).toBe(4)
    expect(detail.getCell('H2').value).toBe(23)
    expect(detail.getCell('J2').value).toBe('Pump21')
    expect(detail.getCell('K2').value).toBe('2026-10-16')
    expect(detail.getRow(1).values).not.toContain('ผลตรวจยอด')
  })
  it('keeps conflicting shipments in a separate review category', () => {
    const results = reconcileBilling([base, base], [], [], [])
    const summary = buildTransportBillingWorkbook(results).getWorksheet('สรุป')!
    let review = 0
    summary.eachRow(row => { if (row.getCell(1).value === 'ต้องตรวจเพิ่มเติม') review = (row.getCell(2).value as { result: number }).result })
    expect(review).toBe(2)
  })
})
