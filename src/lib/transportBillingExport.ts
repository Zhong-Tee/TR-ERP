import * as ExcelJS from 'exceljs'
import type { reconcileBilling } from './transportBilling'

type Result = ReturnType<typeof reconcileBilling>[number]
const navy = 'FF1E293B'
const amountFormat = '#,##0.00;[Red](#,##0.00);"–"'
const countFormat = '#,##0;[Red](#,##0);"–"'
const sum = (rows: Result[]) => Math.round(rows.reduce((total, row) => total + (row.amount ?? 0), 0) * 100) / 100

export function buildTransportBillingWorkbook(results: Result[], exportedAt = new Date()) {
  const book = new ExcelJS.Workbook()
  book.creator = 'TR-ERP'
  book.created = exportedAt
  book.calcProperties.fullCalcOnLoad = true
  const summary = book.addWorksheet('สรุป', { views: [{ showGridLines: false }], pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } })
  const detail = book.addWorksheet('รายการทั้งหมด', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] })
  detail.columns = [
    { header: 'ไฟล์', width: 30 }, { header: 'ชีต', width: 28 }, { header: 'แถว', width: 9 },
    { header: 'Tracking', width: 24 }, { header: 'เลขบิล', width: 30 }, { header: 'ผลตรวจรายการ', width: 32 },
    { header: 'แหล่งอ้างอิง', width: 20 }, { header: 'เรียกเก็บ (บาท)', width: 20 }, { header: 'ฝากส่ง', width: 12 }, { header: 'ผู้ส่ง', width: 26 }, { header: 'วันที่', width: 16 }, { header: 'กลุ่ม', width: 18 }, { header: 'กลุ่มผลตรวจ', width: 24 },
  ]
  const category = (row: Result) => ['พบรายการจัดส่ง', 'ฝากส่ง'].includes(row.status) ? 'จับคู่สำเร็จ' : row.status === 'ไม่พบใน ERP + Wanyen' ? 'มีบิลไม่มีออเดอร์' : 'ต้องตรวจเพิ่มเติม'
  const group = (row: Result) => (row.sender || '').trim().toLowerCase() === 'pump21' ? 'PUMP21' : 'TR และอื่นๆ'
  for (const row of results) detail.addRow([row.file, row.sheet, row.row, row.tracking, row.order, row.status, row.source || '–', row.amount, row.consignment ? 'ใช่' : '', row.sender || 'ไม่ระบุผู้ส่ง', row.pickupDate || 'ไม่ระบุวันที่', group(row), category(row)])
  detail.autoFilter = { from: 'A1', to: `M${Math.max(1, detail.rowCount)}` }
  detail.getColumn(8).numFmt = amountFormat
  for (const sheet of [summary, detail]) {
    sheet.properties.defaultRowHeight = 24
    sheet.eachRow(row => row.eachCell(cell => { cell.font = { name: 'Tahoma', size: 11, color: { argb: navy } }; cell.alignment = { vertical: 'middle' } }))
  }
  function header(sheet: ExcelJS.Worksheet, rowNumber: number) {
    const row = sheet.getRow(rowNumber)
    row.height = 30
    row.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }; cell.font = { name: 'Tahoma', size: 11, bold: true, color: { argb: 'FFFFFFFF' } } })
  }
  header(detail, 1)
  detail.eachRow((row, index) => {
    if (index === 1) return
    row.height = 30
    row.eachCell(cell => {
      cell.alignment = { vertical: 'middle', wrapText: true }
      if (index % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
    })
    const result = results[index - 2]
    row.getCell(6).font = { name: 'Tahoma', size: 11, color: { argb: result.status === 'พบรายการจัดส่ง' ? 'FF047857' : result.consignment ? 'FF7C3AED' : 'FFB45309' } }
  })
  summary.columns = [{ width: 46 }, { width: 19 }, { width: 23 }]
  summary.views = [{ showGridLines: false }]
  const last = Math.max(2, results.length + 1)
  const range = (column: string) => `'รายการทั้งหมด'!$${column}$2:$${column}$${last}`
  let cursor = 1
  function title(text: string) {
    summary.mergeCells(`A${cursor}:C${cursor}`)
    const cell = summary.getCell(`A${cursor}`)
    cell.value = text
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }
    cell.font = { name: 'Tahoma', bold: true, size: 12, color: { argb: navy } }
    summary.getRow(cursor).height = 28
    cursor++
  }
  function tableHeader(label: string) {
    summary.getRow(cursor).values = [label, 'จำนวนกล่อง', 'ยอดรวม (บาท)']
    summary.getRow(cursor).height = 26
    summary.getRow(cursor).eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } }
      cell.font = { name: 'Tahoma', size: 11, bold: true, color: { argb: navy } }
    })
    cursor++
  }
  const escapeCriteria = (value: string) => value.replace(/~/g, '~~').replace(/\*/g, '~*').replace(/\?/g, '~?').replace(/"/g, '""')
  function entry(label: string, items: Result[], criteria: [string, string][], total = false) {
    const args = criteria.flatMap(([column, value]) => [range(column), `"${escapeCriteria(value)}"`]).join(',')
    const row = summary.getRow(cursor)
    row.values = [label, { formula: criteria.length ? `COUNTIFS(${args})` : `COUNTA(${range('A')})`, result: items.length }, { formula: criteria.length ? `SUMIFS(${range('H')},${args})` : `SUM(${range('H')})`, result: sum(items) }]
    row.height = 25
    row.getCell(2).numFmt = countFormat; row.getCell(3).numFmt = amountFormat
    row.eachCell(cell => {
      cell.font = { name: 'Tahoma', size: 11, bold: total, color: { argb: navy } }
      cell.alignment = { vertical: 'middle', wrapText: true }
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFD1D5DB' } } }
      if (total) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } }
    })
    cursor++
  }
  const dates = results.map(row => row.pickupDate).filter((date): date is string => Boolean(date)).sort()
  const period = dates.length ? ` · ${dates[0]} ถึง ${dates[dates.length - 1]}` : ''
  title(`ภาพรวมทั้งรอบ${period}`)
  tableHeader('รายการ')
  for (const label of ['จับคู่สำเร็จ', 'มีบิลไม่มีออเดอร์', 'ต้องตรวจเพิ่มเติม']) {
    const items = results.filter(row => category(row) === label)
    if (items.length || label !== 'ต้องตรวจเพิ่มเติม') entry(label, items, [['M', label]])
  }
  entry('รวมกล่องทั้งหมดในบิล', results, [], true)
  cursor++
  const matched = results.filter(row => category(row) === 'จับคู่สำเร็จ')
  function breakdown(titleText: string, label: string, column: string, labels: string[], field: (row: Result) => string) {
    title(titleText); tableHeader(label)
    for (const value of labels) entry(value, matched.filter(row => field(row) === value), [['M', 'จับคู่สำเร็จ'], [column, value]])
    entry('รวม', matched, [['M', 'จับคู่สำเร็จ']], true)
    cursor++
  }
  breakdown('สรุปตามกลุ่ม (เฉพาะจับคู่สำเร็จ)', 'กลุ่ม', 'L', ['PUMP21', 'TR และอื่นๆ'], group)
  const sender = (row: Result) => row.sender || 'ไม่ระบุผู้ส่ง'
  const date = (row: Result) => row.pickupDate || 'ไม่ระบุวันที่'
  breakdown('สรุปตามผู้ส่ง (เฉพาะจับคู่สำเร็จ)', 'ผู้ส่ง', 'J', [...new Set(matched.map(sender))], sender)
  breakdown('สรุปตามวันที่ (เฉพาะจับคู่สำเร็จ)', 'วันที่', 'K', [...new Set(matched.map(date))].sort(), date)
  for (const note of [
    `ส่งออก ${exportedAt.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })} · ข้อมูลทั้งหมดในรอบ`,
    'จับคู่สำเร็จรวมฝากส่งที่ระบุแล้ว · PUMP21 แยกตามชื่อผู้ส่ง Pump21',
    'จำนวนกล่องนับตามรายการเรียกเก็บ · ยอดรวมรวมรายการซ้ำไว้ให้ตรวจสอบ',
    `ยอดเงินไม่ถูกต้อง ${results.filter(row => row.amount === null).length} รายการ ไม่รวมในยอดเงิน`,
    'ดูรายละเอียดที่ชีต “รายการทั้งหมด” · รายงานนี้ไม่ได้ยืนยันอัตราค่าขนส่ง',
  ]) {
    summary.mergeCells(`A${cursor}:C${cursor}`)
    const cell = summary.getCell(`A${cursor}`)
    cell.value = note; cell.font = { name: 'Tahoma', size: 10, color: { argb: 'FF64748B' } }; cell.alignment = { wrapText: true, vertical: 'middle' }
    summary.getRow(cursor).height = 30
    cursor++
  }
  summary.pageSetup.printArea = `A1:C${cursor - 1}`

  return book
}

export async function downloadTransportBillingWorkbook(results: Result[]) {
  const buffer = await buildTransportBillingWorkbook(results).xlsx.writeBuffer()
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const link = document.createElement('a')
  link.href = url; link.download = 'transport-billing.xlsx'
  document.body.appendChild(link)
  link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
