import * as XLSX from 'xlsx'

export const DELIVERY_REQUIRED_HEADERS = [
  'PU time',
  'Order No.',
  'Tracking No.',
  'Sender',
  'Consignee',
  'Consignee phone',
  'Consignee address',
] as const

export type DeliveryCheckParsedRow = {
  source_row_number: number
  pickup_at: string
  order_no: string
  tracking_no: string
  sender: string
  consignee: string
  consignee_phone: string
  consignee_address: string
  is_consignment: boolean
  note: string | null
  raw_data: Record<string, unknown>
}

export type ParsedDeliveryFile = {
  sheetName: string
  rows: DeliveryCheckParsedRow[]
  pickupDateFrom: string
  pickupDateTo: string
  warnings: string[]
}

function text(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^\s+|\s+$/g, '')
}

export function normalizeDeliveryKey(value: unknown): string {
  return text(value).replace(/\s+/g, '').toUpperCase()
}

export function normalizeDeliveryPhone(value: unknown): string {
  return text(value).replace(/\D/g, '')
}

/**
 * Carrier rows without an order number are consignment shipments. Known free-text
 * order references (for example "46. Moshi อยุธยา") are consignments too and the
 * original text becomes the initial note.
 */
export function isConsignmentOrderNo(value: unknown): boolean {
  const orderNo = text(value)
  if (!orderNo) return true
  return /moshi|โมชิ|ฝากส่ง/i.test(orderNo)
}

function excelSerialToDate(value: number): Date {
  const parsed = XLSX.SSF.parse_date_code(value)
  if (!parsed) return new Date(Number.NaN)
  return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, Math.floor(parsed.S)))
}

export function parsePickupAt(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    return value.toISOString()
  }
  if (typeof value === 'number') {
    const date = excelSerialToDate(value)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString()
  }
  const raw = text(value)
  if (!raw) return ''
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (match) {
    const [, year, month, day, hour, minute, second = '00'] = match
    const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+07:00`)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString()
  }
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function bangkokDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

function normalizedHeader(value: unknown): string {
  return text(value).replace(/\s+/g, ' ').toLowerCase()
}

export function parseDeliveryWorksheetRows(matrix: unknown[][], sheetName = 'Sheet1'): ParsedDeliveryFile {
  if (matrix.length < 2) throw new Error('ไฟล์ไม่มีรายการสำหรับตรวจสอบ')
  const headers = matrix[0].map(normalizedHeader)
  const positions = new Map(headers.map((header, index) => [header, index]))
  const missing = DELIVERY_REQUIRED_HEADERS.filter((header) => !positions.has(normalizedHeader(header)))
  if (missing.length > 0) throw new Error(`ไฟล์ขาดคอลัมน์: ${missing.join(', ')}`)

  const get = (row: unknown[], header: typeof DELIVERY_REQUIRED_HEADERS[number]) => row[positions.get(normalizedHeader(header))!]
  const rows: DeliveryCheckParsedRow[] = []
  const warnings: string[] = []

  matrix.slice(1).forEach((source, index) => {
    if (source.every((value) => !text(value))) return
    const pickupAt = parsePickupAt(get(source, 'PU time'))
    const orderNo = text(get(source, 'Order No.'))
    const trackingNo = text(get(source, 'Tracking No.'))
    const isConsignment = isConsignmentOrderNo(orderNo)
    if (!pickupAt) warnings.push(`แถว ${index + 2}: วันที่ PU time ไม่ถูกต้อง`)
    if (!trackingNo) warnings.push(`แถว ${index + 2}: ไม่มี Tracking No.`)
    rows.push({
      source_row_number: index + 2,
      pickup_at: pickupAt,
      order_no: orderNo,
      tracking_no: trackingNo,
      sender: text(get(source, 'Sender')),
      consignee: text(get(source, 'Consignee')).replace(/^"+/, ''),
      consignee_phone: normalizeDeliveryPhone(get(source, 'Consignee phone')),
      consignee_address: text(get(source, 'Consignee address')),
      is_consignment: isConsignment,
      note: isConsignment && orderNo ? orderNo : null,
      raw_data: Object.fromEntries(DELIVERY_REQUIRED_HEADERS.map((header) => [header, get(source, header)])),
    })
  })

  if (rows.length === 0) throw new Error('ไฟล์ไม่มีรายการสำหรับตรวจสอบ')
  const dates = rows.map((row) => row.pickup_at).filter(Boolean).map(bangkokDate).sort()
  if (dates.length === 0) throw new Error('ไม่พบวันที่ PU time ที่ใช้งานได้')
  const uniqueDates = [...new Set(dates)]
  if (uniqueDates.length > 1) warnings.push(`ไฟล์มีรายการ ${uniqueDates.length} วัน (${uniqueDates[0]} ถึง ${uniqueDates.at(-1)})`)

  const trackingCounts = new Map<string, number>()
  rows.forEach((row) => {
    const key = normalizeDeliveryKey(row.tracking_no)
    if (key) trackingCounts.set(key, (trackingCounts.get(key) || 0) + 1)
  })
  const duplicateCount = [...trackingCounts.values()].filter((count) => count > 1).length
  if (duplicateCount > 0) warnings.push(`พบ Tracking No. ซ้ำ ${duplicateCount} เลข`)

  return {
    sheetName,
    rows,
    pickupDateFrom: dates[0],
    pickupDateTo: dates.at(-1)!,
    warnings,
  }
}

export async function parseDeliveryFile(file: File): Promise<ParsedDeliveryFile> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, raw: true })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw new Error('ไฟล์ไม่มี Worksheet')
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: '',
  })
  return parseDeliveryWorksheetRows(matrix, sheetName)
}

export async function deliveryFileHash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

