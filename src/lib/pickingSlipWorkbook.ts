import * as XLSX from 'xlsx'
import type { PickingMainRow, PickingSlipData } from './pickingSlipData'

/** Excel preserves product codes as text and quantities as numbers across separate sheets. */
export function buildPickingWorkbook(data: PickingSlipData): ArrayBuffer {
  const book = XLSX.utils.book_new()
  const mainColumns = ['ลำดับ', 'จุดเก็บ', 'รหัส', 'แผนก', 'รายการ', 'จำนวน']
  const mainRows = (items: PickingMainRow[]) => items.map((r, i) => [i + 1, r.location, r.code, r.dept, r.name, r.finalQty])
  const sheets = [
    { name: 'สินค้าเบิก', headers: mainColumns, rows: mainRows(data.mainItems), widths: [8, 22, 18, 16, 55, 12] },
    { name: 'อะไหล่', headers: ['ลำดับ', 'รายการอะไหล่ (หน้ายาง/โฟม)', 'จำนวน'], rows: data.spareItems.map((r, i) => [i + 1, r.label, r.qty]), widths: [8, 55, 12] },
    { name: 'คลังย่อย', headers: ['ลำดับ', 'คลังย่อย', 'รหัส', 'แผนก', 'รายการ', 'จำนวน'], rows: data.subItems.map((r, i) => [i + 1, r.warehouse, r.code, r.dept, r.name, r.finalQty]), widths: [8, 35, 18, 16, 55, 12] },
    { name: 'ไม่ต้องเบิก', headers: mainColumns, rows: mainRows(data.nonPickItems), widths: [8, 22, 18, 16, 55, 12] },
  ]
  for (const { name, headers, rows, widths } of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet([['ใบเบิก', data.workOrderName], [], headers, ...rows])
    sheet['!cols'] = widths.map((wch) => ({ wch }))
    sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 2, c: 0 }, { r: 2 + rows.length, c: headers.length - 1 }) }
    XLSX.utils.book_append_sheet(book, sheet, name)
  }
  return XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}
