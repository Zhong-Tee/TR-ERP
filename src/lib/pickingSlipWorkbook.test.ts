import { expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { buildPickingWorkbook } from './pickingSlipWorkbook'
import type { PickingSlipData } from './pickingSlipData'

it('exports separate sheets without mixing non-pick or sub-warehouse quantities into main picking', () => {
  const row = { woName: 'TEST', location: 'A1', code: '00123', name: 'สินค้า', finalQty: 7, dept: 'LASER' }
  const data: PickingSlipData = {
    workOrderName: 'TEST', departments: ['LASER', 'STAMP'], spareDept: 'STAMP',
    mainItems: [row, { ...row, code: '00124', dept: 'STAMP', finalQty: 2 }],
    spareItems: [{ label: 'R1', qty: 3 }],
    subItems: [{ ...row, code: '00999', warehouse: 'คลัง A / คลัง B', finalQty: 5 }],
    nonPickItems: [{ ...row, code: '00888', finalQty: 9 }],
  }
  const workbook = XLSX.read(buildPickingWorkbook(data), { type: 'array' })
  expect(workbook.SheetNames).toEqual(['สินค้าเบิก', 'อะไหล่', 'คลังย่อย', 'ไม่ต้องเบิก'])
  expect(workbook.Sheets['สินค้าเบิก'].C4.v).toBe('00123')
  expect(workbook.Sheets['สินค้าเบิก'].C4.t).toBe('s')
  expect(workbook.Sheets['สินค้าเบิก'].D5.v).toBe('STAMP')
  expect(workbook.Sheets['สินค้าเบิก'].F4).toMatchObject({ t: 'n', v: 7 })
  expect(workbook.Sheets['สินค้าเบิก'].C6).toBeUndefined()
  expect(workbook.Sheets['คลังย่อย'].C4.v).toBe('00999')
  expect(workbook.Sheets['คลังย่อย'].F4.v).toBe(5)
  expect(workbook.Sheets['ไม่ต้องเบิก'].C4.v).toBe('00888')
  expect(workbook.Sheets['ไม่ต้องเบิก'].F4.v).toBe(9)
})
