import * as ExcelJS from 'exceljs'
import { WAYBILL_TEMPLATE_BASE64 } from '../assets/waybillTemplateBase64'

export type FlashWaybillRow = {
  billNo: string
  consigneeName: string
  address: string
  postalCode: string
  phone1: string
  phone2?: string
  cod?: string
}

const DATA_START_ROW = 3
const COLUMN_COUNT = 28
let templateBufferCache: ArrayBuffer | null = null

function templateBuffer(): ArrayBuffer {
  if (!templateBufferCache) {
    const bin = atob(WAYBILL_TEMPLATE_BASE64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
    templateBufferCache = bytes.buffer
  }
  return templateBufferCache
}

function safeFilePart(value: string): string {
  return String(value || 'output').trim().replace(/[/\\?%*:|"<>]/g, '_') || 'output'
}

export async function downloadFlashWaybillXlsx(rows: FlashWaybillRow[], fileBase: string): Promise<void> {
  if (rows.length === 0) throw new Error('ไม่มีข้อมูลสำหรับ Export ใบปะหน้า')

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(templateBuffer())
  const worksheet = workbook.getWorksheet('Order Template') ?? workbook.worksheets[0]
  if (!worksheet) throw new Error('ไม่พบ worksheet ในไฟล์ template')

  const styleRow = worksheet.getRow(DATA_START_ROW)
  const styleHeight = styleRow.height
  const deepClone = <T,>(value: T): T => {
    try {
      return structuredClone(value)
    } catch {
      return JSON.parse(JSON.stringify(value)) as T
    }
  }
  const styles: Array<Partial<ExcelJS.Style> | undefined> = []
  for (let column = 1; column <= COLUMN_COUNT; column += 1) {
    const style = styleRow.getCell(column).style
    styles[column] = style && Object.keys(style).length > 0 ? deepClone(style) : undefined
  }

  rows.forEach((row, index) => {
    const excelRow = worksheet.getRow(DATA_START_ROW + index)
    if (styleHeight != null) excelRow.height = styleHeight
    const values = new Array(COLUMN_COUNT).fill('')
    values[0] = row.billNo
    values[1] = row.consigneeName
    values[2] = row.address
    values[3] = row.postalCode
    values[4] = row.phone1
    values[5] = row.phone2 || ''
    values[6] = '1'
    values[7] = row.cod || '0'
    values[13] = 'อื่นๆ'
    values[14] = '0.1'
    values[15] = '1'
    values[16] = '1'
    values[17] = '1'
    values[23] = 'Standard'
    values[24] = 'payment by sender'
    values[25] = row.billNo

    for (let column = 1; column <= COLUMN_COUNT; column += 1) {
      const cell = excelRow.getCell(column)
      if (styles[column]) cell.style = styles[column]!
      cell.value = values[column - 1]
    }
    excelRow.commit()
  })

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${safeFilePart(fileBase)}.xlsx`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
