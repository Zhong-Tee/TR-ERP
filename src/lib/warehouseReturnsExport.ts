import * as ExcelJS from 'exceljs'
import type { InventoryReturn } from '../types'
import { formatReturnDate, returnStatusLabel } from './warehouseReturnFilters'

export interface ReturnExportItem {
  return_id: string
  qty: number
  disposition?: string | null
  pr_products?: { product_code: string; product_name: string; unit_cost?: number | null } | null
}

export function buildReturnsWorkbook(returns: InventoryReturn[], data: ReturnExportItem[], canSeeCost: boolean) {
  const itemsByReturn = new Map<string, ReturnExportItem[]>()
  data.forEach((item) => {
    const items = itemsByReturn.get(item.return_id) || []
    items.push(item)
    itemsByReturn.set(item.return_id, items)
  })

  const dispositionLabel = (value?: string | null) => {
    if (value === 'return_to_stock') return 'คืนกลับสต๊อค'
    if (value === 'waste') return 'ของเสีย'
    if (value === 'lost') return 'สูญหาย'
    return '-'
  }

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'TR-ERP'
  workbook.created = new Date()
  const worksheet = workbook.addWorksheet('รับสินค้าตีกลับ', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  const columns: Partial<ExcelJS.Column>[] = [
    { header: 'เลขที่รับคืน', key: 'return_no', width: 22 },
    { header: 'เลขบิลอ้างอิง', key: 'ref_bill_no', width: 20 },
    { header: 'เลขพัสดุ', key: 'tracking_number', width: 22 },
    { header: 'วันที่รับคืน', key: 'created_at', width: 20 },
    { header: 'วันที่ดำเนินการ', key: 'received_at', width: 20 },
    { header: 'สถานะ', key: 'status', width: 20 },
    { header: 'เหตุผลตีกลับ', key: 'reason', width: 28 },
    { header: 'หมายเหตุ', key: 'note', width: 28 },
    { header: 'รหัสสินค้า', key: 'product_code', width: 18 },
    { header: 'ชื่อสินค้า', key: 'product_name', width: 35 },
    { header: 'จำนวน', key: 'qty', width: 12 },
    { header: 'ผลตรวจสินค้า', key: 'item_disposition', width: 18 },
  ]
  if (canSeeCost) {
    columns.push(
      { header: 'ต้นทุนต่อหน่วย', key: 'unit_cost', width: 16 },
      { header: 'ต้นทุนรวม', key: 'total_cost', width: 16 },
    )
  }
  worksheet.columns = columns

  returns.forEach((ret) => {
    const items = itemsByReturn.get(ret.id) || []
    const rows = items.length > 0 ? items : [null]
    rows.forEach((item) => {
      const qty = item ? Number(item.qty) || 0 : null
      const unitCost = item ? Number(item.pr_products?.unit_cost) || 0 : null
      worksheet.addRow({
        return_no: ret.return_no,
        ref_bill_no: ret.ref_bill_no || '-',
        tracking_number: ret.tracking_number || '-',
        created_at: formatReturnDate(ret.created_at),
        received_at: ret.received_at ? formatReturnDate(ret.received_at) : '-',
        status: returnStatusLabel(ret),
        reason: ret.reason || '-',
        note: ret.note || '-',
        product_code: item?.pr_products?.product_code || '-',
        product_name: item?.pr_products?.product_name || '-',
        qty: qty ?? '-',
        item_disposition: dispositionLabel(item?.disposition),
        ...(canSeeCost ? {
          unit_cost: unitCost ?? '-',
          total_cost: qty !== null && unitCost !== null ? qty * unitCost : '-',
        } : {}),
      })
    })
  })

  const headerRow = worksheet.getRow(1)
  headerRow.height = 26
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
  worksheet.autoFilter = { from: 'A1', to: `${worksheet.getColumn(columns.length).letter}1` }

  let previousReturnNo = ''
  let useBlueFill = false
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const returnNo = String(row.getCell(1).value || '')
    if (returnNo !== previousReturnNo) {
      previousReturnNo = returnNo
      useBlueFill = !useBlueFill
    }
    row.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: useBlueFill ? 'FFEFF6FF' : 'FFFFFFFF' },
      }
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      }
      cell.alignment = { vertical: 'top', wrapText: true }
    })
  })
  worksheet.getColumn('qty').numFmt = '#,##0.##'
  if (canSeeCost) {
    worksheet.getColumn('unit_cost').numFmt = '#,##0.00'
    worksheet.getColumn('total_cost').numFmt = '#,##0.00'
  }

  return workbook
}
