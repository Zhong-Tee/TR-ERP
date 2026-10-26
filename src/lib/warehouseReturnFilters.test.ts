import { describe, expect, it } from 'vitest'
import { filterReturnsByDate, filterReturnsByStatus, returnDateBounds, returnExportFilename, formatReturnDate } from './warehouseReturnFilters'
import type { InventoryReturn } from '../types'
import { buildReturnsWorkbook } from './warehouseReturnsExport'
import * as ExcelJS from 'exceljs'

const row = (id: string, created_at: string, status = 'received', disposition = 'waste'): InventoryReturn => ({ id, return_no: `RT-${id}`, created_at, status, disposition })
const range = { start: '2026-10-01', end: '2026-10-20' }
const rows = [
  row('before', '2026-09-30T16:59:59.999Z'),
  row('start', '2026-09-30T17:00:00Z', 'pending'),
  row('middle', '2026-10-10T12:00:00Z', 'received', 'return_to_stock'),
  row('end', '2026-10-20T16:59:59.999Z'),
  row('after', '2026-10-20T17:00:00Z'),
  row('mixed', '2026-10-19T00:00:00Z', 'received', 'mixed'),
]

describe('return date and status filtering', () => {
  it('includes the full first and final day in Bangkok time', () => {
    expect(filterReturnsByDate(rows, range).map(r => r.id)).toEqual(['start', 'middle', 'end', 'mixed'])
  })
  it.each(['all', 'pending', 'return_to_stock', 'waste'] as const)('combines dates with %s status', status => {
    const expected = { all: ['start', 'middle', 'end', 'mixed'], pending: ['start'], return_to_stock: ['middle'], waste: ['end'] }
    expect(filterReturnsByStatus(filterReturnsByDate(rows, range), status).map(r => r.id)).toEqual(expected[status])
  })
  it('supports same-day, open-ended and cleared date ranges', () => {
    expect(filterReturnsByDate(rows, { start: '2026-10-20', end: '2026-10-20' }).map(r => r.id)).toEqual(['end'])
    expect(filterReturnsByDate(rows, { start: '', end: range.end })).toHaveLength(5)
    expect(filterReturnsByDate(rows, { start: range.start, end: '' })).toHaveLength(5)
    expect(filterReturnsByDate(rows, { start: '', end: '' })).toEqual(rows)
    expect(filterReturnsByStatus(filterReturnsByDate(rows, { start: '', end: '' }), 'pending')).toEqual([rows[1]])
  })
  it.each([{ start: '2026-10-21', end: '2026-10-20' }, { start: '2026-02-30', end: '' }, { start: 'not-a-date', end: '' }])('rejects invalid range %j', invalid => {
    expect(() => returnDateBounds(invalid)).toThrow()
  })
  it('returns no rows for an empty period', () => {
    expect(filterReturnsByDate(rows, { start: '2025-01-01', end: '2025-01-31' })).toEqual([])
  })
  it('keeps filenames and displayed dates in Bangkok time', () => {
    expect(returnExportFilename('waste', range, new Date('2026-10-25T18:00:00Z'))).toBe('รับสินค้าตีกลับ_waste_2026-10-01_ถึง_2026-10-20_2026-10-26.xlsx')
    expect(formatReturnDate('2026-09-30T17:00:00Z')).toContain('01/10/')
  })
})

describe('filtered Excel workbook', () => {
  it.each(['all', 'pending', 'return_to_stock', 'waste'] as const)('exports exactly the displayed return set for %s', status => {
    const selected = filterReturnsByStatus(filterReturnsByDate(rows, range), status)
    const sheet = buildReturnsWorkbook(selected, rows.map(ret => ({ return_id: ret.id, qty: 1 })), false).worksheets[0]
    const exported: string[] = []
    sheet.eachRow((r, n) => { if (n > 1) exported.push(String(r.getCell(1).value)) })
    expect(exported).toEqual(selected.map(ret => ret.return_no))
  })
  it.each([true, false])('writes only matching returns and preserves cost visibility (%s)', async canSeeCost => {
    const selected = filterReturnsByStatus(filterReturnsByDate(rows, range), 'waste')
    const workbook = buildReturnsWorkbook(selected, [
      { return_id: 'end', qty: 2, disposition: 'waste', pr_products: { product_code: 'RM1', product_name: 'สินค้า', unit_cost: 12.5 } },
      { return_id: 'end', qty: 3, disposition: 'return_to_stock', pr_products: { product_code: 'RM2', product_name: 'สินค้าอีกตัว', unit_cost: 5 } },
      { return_id: 'after', qty: 999, pr_products: { product_code: 'EXCLUDED', product_name: 'นอกช่วง' } },
    ], canSeeCost)
    const loaded = new ExcelJS.Workbook()
    await loaded.xlsx.load(await workbook.xlsx.writeBuffer())
    const sheet = loaded.worksheets[0]
    expect(sheet.rowCount).toBe(3)
    expect(sheet.getCell('A2').value).toBe('RT-end')
    expect(sheet.getCell('A3').value).toBe('RT-end')
    expect(sheet.getCell('I2').value).toBe('RM1')
    expect(sheet.getCell('K2').value).toBe(2)
    expect(sheet.columnCount).toBe(canSeeCost ? 14 : 12)
    if (canSeeCost) expect(sheet.getCell('N2').value).toBe(25)
    else expect(sheet.getRow(1).values).not.toContain('ต้นทุนรวม')
  })
  it('keeps a matching return even when it has no detail items', () => {
    const workbook = buildReturnsWorkbook([rows[1]], [], false)
    expect(workbook.worksheets[0].getCell('A2').value).toBe('RT-start')
    expect(workbook.worksheets[0].getCell('I2').value).toBe('-')
  })
})
