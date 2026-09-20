import * as XLSX from 'xlsx'

export type EcommerceFileKind = 'orders' | 'income' | 'balance'

export type ShopeeOrderLine = {
  sourceLineIndex: number
  orderNo: string
  skuRef: string | null
  productName: string | null
  variation: string | null
  qty: number
  returnedQty: number
  originalPrice: number | null
  salePrice: number | null
  netLineAmount: number | null
  rawSnapshot: Record<string, unknown>
}

export type ShopeeOrder = {
  orderNo: string
  platformStatus: string | null
  deliveryStatus: 'delivered' | 'shipping' | 'cancelled' | 'returned' | 'other'
  refundStatus: string | null
  buyerUsername: string | null
  orderedAt: string | null
  paidAt: string | null
  shippedAt: string | null
  completedAt: string | null
  trackingNo: string | null
  buyerPaid: number | null
  merchandiseTotal: number
  orderTotal: number | null
  estimatedCommission: number | null
  estimatedTransactionFee: number | null
  estimatedServiceFee: number | null
  estimatedShippingCost: number | null
  province: string | null
  district: string | null
  postalCode: string | null
  rawSnapshot: Record<string, unknown>
  lines: ShopeeOrderLine[]
}

export type ShopeeSettlement = {
  orderNo: string
  settledAt: string | null
  orderedAt: string | null
  buyerUsername: string | null
  grossSales: number
  sellerDiscounts: number
  refunds: number
  shippingNet: number
  platformFeeTotal: number
  sellerCostTotal: number
  feeCategoryCount: number
  payoutAmount: number
  feeBreakdown: Record<string, number>
  rawSnapshot: Record<string, unknown>
}

export type ShopeeWalletTransaction = {
  sourceRowIndex: number
  sourceKey?: string
  orderNo: string | null
  transactionAt: string | null
  transactionType: string | null
  description: string | null
  direction: string | null
  amount: number
  status: string | null
  balanceAfter: number | null
  rawSnapshot: Record<string, unknown>
}

export const TIKTOK_REPORT_TOTAL_TYPE = 'tiktok_report_total'
export const TIKTOK_REPORT_FEE_TYPE = 'tiktok_report_fee_total'
export const TIKTOK_WITHDRAWAL_TYPE = 'tiktok_withdrawal'

export type ShopeeParsedFile =
  | { kind: 'orders'; sheetName: string; reportFrom: string | null; reportTo: string | null; orders: ShopeeOrder[] }
  | { kind: 'income'; sheetName: string; reportFrom: string | null; reportTo: string | null; settlements: ShopeeSettlement[]; walletTransactions?: ShopeeWalletTransaction[]; warnings?: string[] }
  | { kind: 'balance'; sheetName: string; reportFrom: string | null; reportTo: string | null; transactions: ShopeeWalletTransaction[] }

type Row = Record<string, unknown>

const ORDER_HEADER = 'หมายเลขคำสั่งซื้อ'
const INCOME_PAYOUT_HEADER = 'จำนวนเงินทั้งหมดที่โอนแล้ว (฿)'
const BALANCE_DATE_HEADER = 'วันที่'

function text(value: unknown): string | null {
  const result = value == null ? '' : String(value).trim()
  return result || null
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = numberValue(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isoDate(value: unknown): string | null {
  if (value == null || value === '') return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, Math.floor(parsed.S))).toISOString()
    }
  }
  const raw = String(value).trim()
  if (!raw) return null
  const normalized = raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function bangkokIsoDate(value: unknown): string | null {
  if (value == null || value === '') return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  const raw = String(value).trim()
  const ymd = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  const match = ymd ?? dmy
  if (!match) return isoDate(value)
  const [year, month, day, hour, minute, second] = ymd
    ? [match[1], match[2], match[3], match[4], match[5], match[6]]
    : [match[3], match[2], match[1], match[4], match[5], match[6]]
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${(hour ?? '00').padStart(2, '0')}:${minute ?? '00'}:${second ?? '00'}+07:00`
}

function snapshot(headers: string[], cells: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  headers.forEach((header, index) => {
    const key = header?.trim()
    const value = cells[index]
    if (key && value != null && value !== '') result[key] = value instanceof Date ? value.toISOString() : value
  })
  return result
}

function sheetRows(sheet: XLSX.WorkSheet): unknown[][] {
  // Some TikTok exports contain hundreds of populated rows while their XML
  // dimension is incorrectly left as A1:X2. SheetJS respects !ref, so repair
  // it from the actual cell addresses before converting the worksheet.
  let minRow = Number.POSITIVE_INFINITY
  let minColumn = Number.POSITIVE_INFINITY
  let maxRow = -1
  let maxColumn = -1
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!') || !/^[A-Z]+\d+$/.test(address)) continue
    const cell = XLSX.utils.decode_cell(address)
    minRow = Math.min(minRow, cell.r)
    minColumn = Math.min(minColumn, cell.c)
    maxRow = Math.max(maxRow, cell.r)
    maxColumn = Math.max(maxColumn, cell.c)
  }
  if (maxRow >= 0 && maxColumn >= 0) {
    sheet['!ref'] = XLSX.utils.encode_range({
      s: { r: minRow, c: minColumn },
      e: { r: maxRow, c: maxColumn },
    })
  }
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: true }) as unknown[][]
}

function findHeaderRow(rows: unknown[][], requiredHeader: string): number {
  return rows.findIndex((row) => row.some((cell) => String(cell ?? '').trim() === requiredHeader))
}

function rowsAsObjects(rows: unknown[][], headerIndex: number): { row: Row; cells: unknown[]; sourceRowIndex: number; headers: string[] }[] {
  const headers = (rows[headerIndex] ?? []).map((cell) => String(cell ?? '').trim())
  return rows.slice(headerIndex + 1).map((cells, offset) => {
    const row: Row = {}
    headers.forEach((header, index) => {
      if (header) row[header] = cells[index]
    })
    return { row, cells, sourceRowIndex: headerIndex + offset + 2, headers }
  })
}

function normalizeDeliveryStatus(status: string | null, refundStatus: string | null): ShopeeOrder['deliveryStatus'] {
  const combined = `${status ?? ''} ${refundStatus ?? ''}`.toLowerCase()
  if (combined.includes('ยกเลิก') || combined.includes('cancel')) return 'cancelled'
  if (combined.includes('คืนสินค้า') || combined.includes('return') || combined.includes('refund')) return 'returned'
  if (combined.includes('จัดส่งสำเร็จ') || combined.includes('สำเร็จ') || combined.includes('delivered') || combined.includes('completed')) return 'delivered'
  if (combined.includes('จัดส่ง') || combined.includes('shipping') || combined.includes('shipped')) return 'shipping'
  return 'other'
}

function reportRangeFromRows(rows: unknown[][]): { reportFrom: string | null; reportTo: string | null } {
  const lookup = (labels: string[]) => {
    const found = rows.find((row) => labels.includes(String(row[0] ?? '').trim()))
    return found ? isoDate(found[1])?.slice(0, 10) ?? text(found[1]) : null
  }
  return {
    reportFrom: lookup(['จาก', 'From']),
    reportTo: lookup(['ถึง', 'ไปยัง', 'To']),
  }
}

function parseOrders(sheet: XLSX.WorkSheet, sheetName: string): ShopeeParsedFile {
  const rows = sheetRows(sheet)
  const headerIndex = findHeaderRow(rows, ORDER_HEADER)
  if (headerIndex < 0) throw new Error('ไม่พบหัวคอลัมน์หมายเลขคำสั่งซื้อในไฟล์ Order')
  const grouped = new Map<string, ShopeeOrder>()

  for (const source of rowsAsObjects(rows, headerIndex)) {
    const orderNo = text(source.row[ORDER_HEADER])
    if (!orderNo) continue
    const platformStatus = text(source.row['สถานะการสั่งซื้อ'])
    const refundStatus = text(source.row['สถานะการคืนเงินหรือคืนสินค้า'])
    const line: ShopeeOrderLine = {
      sourceLineIndex: source.sourceRowIndex,
      orderNo,
      skuRef: text(source.row['เลขอ้างอิง SKU (SKU Reference No.)']),
      productName: text(source.row['ชื่อสินค้า']),
      variation: text(source.row['ชื่อตัวเลือก']),
      qty: numberValue(source.row['จำนวน']),
      returnedQty: numberValue(source.row['จำนวนที่ส่งคืน']),
      originalPrice: nullableNumber(source.row['ราคาตั้งต้น']),
      salePrice: nullableNumber(source.row['ราคาขาย']),
      netLineAmount: nullableNumber(source.row['ราคาขายสุทธิ']),
      rawSnapshot: snapshot(source.headers, source.cells),
    }

    const existing = grouped.get(orderNo)
    if (existing) {
      existing.lines.push(line)
      existing.merchandiseTotal += line.netLineAmount ?? 0
      continue
    }

    grouped.set(orderNo, {
      orderNo,
      platformStatus,
      deliveryStatus: normalizeDeliveryStatus(platformStatus, refundStatus),
      refundStatus,
      buyerUsername: text(source.row['ชื่อผู้ใช้ (ผู้ซื้อ)']),
      orderedAt: isoDate(source.row['วันที่ทำการสั่งซื้อ']),
      paidAt: isoDate(source.row['เวลาการชำระสินค้า']),
      shippedAt: isoDate(source.row['เวลาส่งสินค้า']),
      completedAt: isoDate(source.row['เวลาที่ทำการสั่งซื้อสำเร็จ']),
      trackingNo: text(source.row['*หมายเลขติดตามพัสดุ']),
      buyerPaid: nullableNumber(source.row['ราคาสินค้าที่ชำระโดยผู้ซื้อ (THB)']),
      merchandiseTotal: line.netLineAmount ?? 0,
      orderTotal: nullableNumber(source.row['จำนวนเงินทั้งหมด']),
      estimatedCommission: nullableNumber(source.row['ค่าคอมมิชชั่น']),
      estimatedTransactionFee: nullableNumber(source.row['Transaction Fee']),
      estimatedServiceFee: nullableNumber(source.row['ค่าบริการ']),
      estimatedShippingCost: nullableNumber(source.row['ค่าจัดส่งโดยประมาณ']),
      province: text(source.row['จังหวัด']),
      district: text(source.row['เขต/อำเภอ']),
      postalCode: text(source.row['รหัสไปรษณีย์']),
      rawSnapshot: snapshot(source.headers, source.cells),
      lines: [line],
    })
  }

  return { kind: 'orders', sheetName, reportFrom: null, reportTo: null, orders: [...grouped.values()] }
}

const PLATFORM_FEE_HEADERS = [
  'ค่าคอมมิชชั่น AMS',
  'ค่าคอมมิชชั่น',
  'ค่าบริการ',
  'ค่าธรรมเนียมโครงสร้างพื้นฐานแพลตฟอร์ม',
  'ค่าธรรมเนียม ของโปรแกรมประหยัดค่าจัดส่ง',
  'ค่าธุรกรรมการชำระเงิน',
  'ภาษี',
  'ค่าธรรมเนียมเติมเงินโฆษณาจากเงิน Escrow',
] as const

const SELLER_COST_HEADERS = [
  'ส่วนลดสินค้าจากผู้ขาย',
  'จำนวนเงินที่ทำการคืนให้ผู้ซื้อ',
  'โค้ดส่วนลดที่ออกโดยผู้ขาย',
  'โค้ดส่วนลดร่วมที่ออกโดยผู้ขาย',
  'Coins Cashback ที่สนับสนุนโดยผู้ขาย',
  'Coins Cashback ร่วมที่สนับสนุนโดยผู้ขาย',
  'ค่าจัดส่งที่ Shopee ชำระโดยชื่อของคุณ',
  'ค่าจัดส่งสินค้าคืน',
  'ค่าจัดส่งสินค้าคืนผู้ขาย',
  ...PLATFORM_FEE_HEADERS,
] as const

function parseIncome(sheet: XLSX.WorkSheet, sheetName: string): ShopeeParsedFile {
  const rows = sheetRows(sheet)
  const headerIndex = findHeaderRow(rows, INCOME_PAYOUT_HEADER)
  if (headerIndex < 0) throw new Error('ไม่พบตารางจำนวนเงินทั้งหมดที่โอนแล้วในไฟล์ Income')
  const settlements: ShopeeSettlement[] = []

  for (const source of rowsAsObjects(rows, headerIndex)) {
    const orderNo = text(source.row[ORDER_HEADER])
    if (!orderNo) continue
    const feeBreakdown: Record<string, number> = {}
    for (const header of PLATFORM_FEE_HEADERS) feeBreakdown[header] = numberValue(source.row[header])
    const platformFeeTotal = Object.values(feeBreakdown).reduce((sum, value) => sum + Math.abs(Math.min(value, 0)), 0)
    const sellerCostTotal = SELLER_COST_HEADERS.reduce(
      (sum, header) => sum + Math.abs(Math.min(numberValue(source.row[header]), 0)),
      0,
    )
    settlements.push({
      orderNo,
      settledAt: isoDate(source.row['วันที่โอนชำระเงินสำเร็จ']),
      orderedAt: isoDate(source.row['วันที่ทำการสั่งซื้อ']),
      buyerUsername: text(source.row['ชื่อผู้ใช้ (ผู้ซื้อ)']),
      grossSales: numberValue(source.row['สินค้าราคาปกติ']),
      sellerDiscounts:
        numberValue(source.row['ส่วนลดสินค้าจากผู้ขาย']) +
        numberValue(source.row['โค้ดส่วนลดที่ออกโดยผู้ขาย']) +
        numberValue(source.row['โค้ดส่วนลดร่วมที่ออกโดยผู้ขาย']),
      refunds: numberValue(source.row['จำนวนเงินที่ทำการคืนให้ผู้ซื้อ']),
      shippingNet:
        numberValue(source.row['ค่าจัดส่งที่ชำระโดยผู้ซื้อ']) +
        numberValue(source.row['ค่าจัดส่งสินค้าที่ออกโดย Shopee']) +
        numberValue(source.row['ค่าจัดส่งที่ Shopee ชำระโดยชื่อของคุณ']),
      platformFeeTotal,
      sellerCostTotal,
      feeCategoryCount: Object.values(feeBreakdown).filter((value) => value !== 0).length,
      payoutAmount: numberValue(source.row[INCOME_PAYOUT_HEADER]),
      feeBreakdown,
      rawSnapshot: snapshot(source.headers, source.cells),
    })
  }

  const range = reportRangeFromRows(rows.slice(0, headerIndex))
  return { kind: 'income', sheetName, ...range, settlements }
}

function parseBalance(sheet: XLSX.WorkSheet, sheetName: string): ShopeeParsedFile {
  const rows = sheetRows(sheet)
  const headerIndex = findHeaderRow(rows, BALANCE_DATE_HEADER)
  if (headerIndex < 0 || !rows[headerIndex]?.some((cell) => String(cell ?? '').trim() === 'รหัสคำสั่งซื้อ')) {
    throw new Error('ไม่พบตารางรายละเอียดการทำธุรกรรมในไฟล์ Balance')
  }
  const transactions: ShopeeWalletTransaction[] = []
  for (const source of rowsAsObjects(rows, headerIndex)) {
    const amount = nullableNumber(source.row['จำนวนเงิน'])
    if (amount == null) continue
    transactions.push({
      sourceRowIndex: source.sourceRowIndex,
      orderNo: text(source.row['รหัสคำสั่งซื้อ']),
      transactionAt: isoDate(source.row['วันที่']),
      transactionType: text(source.row['ประเภทการทำธุรกรรม']),
      description: text(source.row['คำอธิบาย']),
      direction: text(source.row['รูปแบบธุรกรรม']),
      amount,
      status: text(source.row['สถานะ']),
      balanceAfter: nullableNumber(source.row['ยอดเงินหลังทำธุรกรรมเสร็จสิ้น']),
      rawSnapshot: snapshot(source.headers, source.cells),
    })
  }
  const range = reportRangeFromRows(rows.slice(0, headerIndex))
  return { kind: 'balance', sheetName, ...range, transactions }
}

export function detectShopeeFileKind(workbook: XLSX.WorkBook): EcommerceFileKind {
  if (workbook.SheetNames.includes('orders')) return 'orders'
  if (workbook.SheetNames.includes('Income')) return 'income'
  if (workbook.SheetNames.includes('Transaction Report')) return 'balance'

  for (const sheetName of workbook.SheetNames) {
    const rows = sheetRows(workbook.Sheets[sheetName]).slice(0, 25)
    if (findHeaderRow(rows, INCOME_PAYOUT_HEADER) >= 0) return 'income'
    if (findHeaderRow(rows, ORDER_HEADER) >= 0) return 'orders'
    if (findHeaderRow(rows, 'รหัสคำสั่งซื้อ') >= 0) return 'balance'
  }
  throw new Error('ไม่สามารถระบุประเภทไฟล์ Shopee ได้')
}

export function parseShopeeWorkbook(workbook: XLSX.WorkBook): ShopeeParsedFile {
  const kind = detectShopeeFileKind(workbook)
  const preferredSheet = kind === 'orders' ? 'orders' : kind === 'income' ? 'Income' : 'Transaction Report'
  const sheetName = workbook.SheetNames.includes(preferredSheet) ? preferredSheet : workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) throw new Error('ไม่พบชีตข้อมูลในไฟล์')
  if (kind === 'orders') return parseOrders(sheet, sheetName)
  if (kind === 'income') return parseIncome(sheet, sheetName)
  return parseBalance(sheet, sheetName)
}

export function readShopeeWorkbook(buffer: ArrayBuffer): ShopeeParsedFile {
  const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true })
  return parseShopeeWorkbook(workbook)
}

const TIKTOK_ORDER_HEADER = 'Order ID'
const TIKTOK_INCOME_ORDER_HEADER = 'หมายเลขคำสั่งซื้อ/การปรับ'
const TIKTOK_PAYOUT_HEADER = 'ยอดการชำระเงินทั้งหมด'

function firstValue(row: Row, headers: string[]): unknown {
  for (const header of headers) {
    if (row[header] != null && row[header] !== '') return row[header]
  }
  return null
}

function parseTikTokOrders(sheet: XLSX.WorkSheet, sheetName: string): ShopeeParsedFile {
  const rows = sheetRows(sheet)
  const headerIndex = findHeaderRow(rows, TIKTOK_ORDER_HEADER)
  if (headerIndex < 0) throw new Error('ไม่พบหัวคอลัมน์ Order ID ในไฟล์คำสั่งซื้อ TikTok')
  const grouped = new Map<string, ShopeeOrder>()

  for (const source of rowsAsObjects(rows, headerIndex)) {
    const orderNo = text(source.row[TIKTOK_ORDER_HEADER])
    // TikTok places an English field-description row directly below the headers.
    // Real TikTok order IDs in this report are numeric.
    if (!orderNo || !/^\d+$/.test(orderNo)) continue
    const rawPlatformStatus = text(firstValue(source.row, ['Order Status', 'Order Substatus', 'Status']))
    const platformStatus = rawPlatformStatus ?? 'จัดส่งแล้ว'
    const refundStatus = text(firstValue(source.row, ['Cancelation/Return Type', 'Cancellation/Return Type', 'Refund Status']))
    const qty = Math.max(1, numberValue(firstValue(source.row, ['Quantity', 'Qty'])))
    const salePrice = nullableNumber(firstValue(source.row, ['SKU Subtotal After Discount', 'SKU Sale Price', 'Unit Price']))
    const line: ShopeeOrderLine = {
      sourceLineIndex: source.sourceRowIndex,
      orderNo,
      skuRef: text(firstValue(source.row, ['Seller SKU', 'SKU ID', 'SKU'])),
      productName: text(firstValue(source.row, ['Product Name', 'Product'])),
      variation: text(firstValue(source.row, ['Variation', 'SKU Name'])),
      qty,
      returnedQty: numberValue(firstValue(source.row, ['Sku Quantity of return', 'Returned Quantity', 'Return Quantity'])),
      originalPrice: nullableNumber(firstValue(source.row, ['SKU Unit Original Price', 'Original Price'])),
      salePrice,
      netLineAmount: nullableNumber(firstValue(source.row, ['SKU Subtotal After Discount', 'SKU Subtotal', 'Item Subtotal'])) ?? (salePrice == null ? null : salePrice * qty),
      rawSnapshot: snapshot(source.headers, source.cells),
    }

    const existing = grouped.get(orderNo)
    if (existing) {
      existing.lines.push(line)
      existing.merchandiseTotal += line.netLineAmount ?? 0
      continue
    }

    grouped.set(orderNo, {
      orderNo,
      platformStatus,
      deliveryStatus: rawPlatformStatus == null
        ? 'shipping'
        : normalizeDeliveryStatus(rawPlatformStatus, refundStatus) === 'other'
          ? 'delivered'
          : normalizeDeliveryStatus(rawPlatformStatus, refundStatus),
      refundStatus,
      buyerUsername: text(firstValue(source.row, ['Buyer Username', 'Buyer User Name', 'Username'])),
      orderedAt: bangkokIsoDate(firstValue(source.row, ['Created Time', 'Order Created Time', 'Order Date'])),
      paidAt: bangkokIsoDate(firstValue(source.row, ['Paid Time', 'Payment Time'])),
      shippedAt: bangkokIsoDate(firstValue(source.row, ['Shipped Time', 'RTS Time', 'Ready to Ship Time'])),
      completedAt: bangkokIsoDate(firstValue(source.row, ['Delivered Time', 'Delivery Time'])),
      trackingNo: text(firstValue(source.row, ['Tracking ID', 'Tracking Number'])),
      buyerPaid: nullableNumber(firstValue(source.row, ['Order Amount', 'Buyer Paid Amount'])),
      merchandiseTotal: line.netLineAmount ?? 0,
      orderTotal: nullableNumber(firstValue(source.row, ['Order Amount', 'Total Amount'])),
      estimatedCommission: null,
      estimatedTransactionFee: null,
      estimatedServiceFee: null,
      estimatedShippingCost: nullableNumber(firstValue(source.row, ['Shipping Fee', 'Original Shipping Fee'])),
      province: text(firstValue(source.row, ['State', 'Province'])),
      district: text(firstValue(source.row, ['District', 'City'])),
      postalCode: text(firstValue(source.row, ['Zipcode', 'Zip Code', 'Postal Code'])),
      rawSnapshot: snapshot(source.headers, source.cells),
      lines: [line],
    })
  }

  return { kind: 'orders', sheetName, reportFrom: null, reportTo: null, orders: [...grouped.values()] }
}

function findTikTokReportValue(rows: unknown[][], label: string): { rowIndex: number; value: unknown } | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]
    const labelIndex = row.findIndex((cell) => text(cell) === label)
    if (labelIndex < 0) continue
    const value = row.slice(labelIndex + 1).find((cell) => cell != null && cell !== '')
    return { rowIndex: rowIndex + 1, value: value ?? null }
  }
  return null
}

function tikTokReportRange(rows: unknown[][]): { reportFrom: string | null; reportTo: string | null } {
  const period = findTikTokReportValue(rows, 'ช่วงเวลา')?.value
  const dates = String(period ?? '').match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}/g) ?? []
  return {
    reportFrom: dates[0]?.replaceAll('/', '-') ?? null,
    reportTo: dates[1]?.replaceAll('/', '-') ?? dates[0]?.replaceAll('/', '-') ?? null,
  }
}

function parseTikTokIncome(workbook: XLSX.WorkBook, sheet: XLSX.WorkSheet, sheetName: string): ShopeeParsedFile {
  const rows = sheetRows(sheet)
  const headerIndex = findHeaderRow(rows, TIKTOK_INCOME_ORDER_HEADER)
  if (headerIndex < 0) throw new Error('ไม่พบตารางรายละเอียดคำสั่งซื้อในไฟล์ Income ของ TikTok')
  const settlements: ShopeeSettlement[] = []
  const walletTransactions: ShopeeWalletTransaction[] = []

  for (const source of rowsAsObjects(rows, headerIndex)) {
    const orderNo = text(source.row[TIKTOK_INCOME_ORDER_HEADER])
    if (!orderNo) continue
    const settledAt = bangkokIsoDate(source.row['เวลาที่ชำระคำสั่งซื้อ'])
    const payoutAmount = numberValue(source.row[TIKTOK_PAYOUT_HEADER])
    const totalFee = numberValue(source.row['ค่าธรรมเนียมทั้งหมด'])
    const totalFeeIndex = source.headers.indexOf('ค่าธรรมเนียมทั้งหมด')
    const feeBreakdown: Record<string, number> = {}
    source.headers.forEach((header, index) => {
      const isFee = header.includes('ค่าธรรมเนียม') || header.includes('ค่าคอมมิช') || header.startsWith('การผ่อนชำระ')
      if (index <= totalFeeIndex || !header || !isFee) return
      const value = numberValue(source.row[header])
      if (value !== 0) feeBreakdown[header] = value
    })
    if (Object.keys(feeBreakdown).length === 0 && totalFee !== 0) feeBreakdown['ค่าธรรมเนียมทั้งหมด'] = totalFee

    const rawSnapshot = snapshot(source.headers, source.cells)
    settlements.push({
      orderNo,
      settledAt,
      orderedAt: bangkokIsoDate(source.row['เวลาที่สร้างคำสั่งซื้อ']),
      buyerUsername: null,
      grossSales: numberValue(source.row['ยอดรวมค่าสินค้าก่อนหักส่วนลด']),
      sellerDiscounts: numberValue(source.row['ส่วนลดจากร้านค้า']),
      refunds: numberValue(source.row['ยอดรวมเงินคืนหลังหักส่วนลดจากผู้ขาย']),
      shippingNet: numberValue(source.row['ยอดรวมค่าจัดส่งที่ร้านค้าจ่ายจริง']),
      platformFeeTotal: Math.abs(Math.min(totalFee, 0)),
      sellerCostTotal: Math.abs(Math.min(numberValue(source.row['ส่วนลดจากร้านค้า']), 0)) + Math.abs(Math.min(totalFee, 0)),
      feeCategoryCount: Object.values(feeBreakdown).filter((value) => value !== 0).length,
      payoutAmount,
      feeBreakdown,
      rawSnapshot,
    })
    walletTransactions.push({
      sourceRowIndex: source.sourceRowIndex,
      orderNo,
      transactionAt: settledAt,
      transactionType: text(source.row['ประเภทธุรกรรม']) ?? 'TikTok Order Settlement',
      description: 'รายได้จากคำสั่งซื้อเข้าในบัญชี TikTok',
      direction: 'เงินเข้า',
      amount: payoutAmount,
      status: settledAt ? 'สำเร็จ' : null,
      balanceAfter: null,
      rawSnapshot,
    })
  }

  const reportSheet = workbook.Sheets['รายงาน']
  const reportRows = reportSheet ? sheetRows(reportSheet) : []
  const reportRange = tikTokReportRange(reportRows)
  const reportTotal = findTikTokReportValue(reportRows, TIKTOK_PAYOUT_HEADER)
  const reportedPayoutTotal = reportTotal ? numberValue(reportTotal.value) : null
  if (reportTotal && reportRange.reportTo) {
    walletTransactions.push({
      sourceRowIndex: reportTotal.rowIndex,
      sourceKey: `tiktok-report:${reportRange.reportFrom ?? reportRange.reportTo}:${reportRange.reportTo}`,
      orderNo: null,
      transactionAt: bangkokIsoDate(reportRange.reportTo),
      transactionType: TIKTOK_REPORT_TOTAL_TYPE,
      description: `ยอดที่ TikTok แจ้งจ่าย รอบ ${reportRange.reportFrom ?? reportRange.reportTo} ถึง ${reportRange.reportTo}`,
      direction: 'ยอดแจ้งจ่าย',
      amount: reportedPayoutTotal ?? 0,
      status: 'reported',
      balanceAfter: null,
      rawSnapshot: {
        report_from: reportRange.reportFrom,
        report_to: reportRange.reportTo,
        payout_amount: reportedPayoutTotal,
      },
    })
  }
  const reportFee = findTikTokReportValue(reportRows, 'ค่าธรรมเนียมทั้งหมด')
  if (reportFee && reportRange.reportTo) {
    walletTransactions.push({
      sourceRowIndex: reportFee.rowIndex,
      sourceKey: `tiktok-report-fee:${reportRange.reportFrom ?? reportRange.reportTo}:${reportRange.reportTo}`,
      orderNo: null,
      transactionAt: bangkokIsoDate(reportRange.reportTo),
      transactionType: TIKTOK_REPORT_FEE_TYPE,
      description: `ค่าธรรมเนียมรวม TikTok รอบ ${reportRange.reportFrom ?? reportRange.reportTo} ถึง ${reportRange.reportTo}`,
      direction: 'ค่าธรรมเนียม',
      amount: Math.abs(numberValue(reportFee.value)),
      status: 'reported',
      balanceAfter: null,
      rawSnapshot: {
        report_from: reportRange.reportFrom,
        report_to: reportRange.reportTo,
        fee_amount: numberValue(reportFee.value),
      },
    })
  }

  const withdrawalSheet = workbook.Sheets['บันทึกการถอน']
  if (withdrawalSheet) {
    const withdrawalRows = sheetRows(withdrawalSheet)
    const withdrawalHeader = findHeaderRow(withdrawalRows, 'ID อ้างอิง')
    if (withdrawalHeader >= 0) {
      for (const source of rowsAsObjects(withdrawalRows, withdrawalHeader)) {
        const referenceId = text(source.row['ID อ้างอิง'])
        const amount = numberValue(source.row['จำนวน'])
        if (!referenceId || amount === 0) continue
        const completedAt = bangkokIsoDate(source.row['เวลาที่สำเร็จ'] ?? source.row['เวลาส่งคำขอ'])
        walletTransactions.push({
          sourceRowIndex: source.sourceRowIndex,
          sourceKey: `tiktok-withdrawal:${referenceId}`,
          orderNo: null,
          transactionAt: completedAt,
          transactionType: TIKTOK_WITHDRAWAL_TYPE,
          description: `TikTok โอนเงินสำเร็จ อ้างอิง ${referenceId}`,
          direction: 'เงินเข้า',
          amount,
          status: text(source.row['สถานะ']),
          balanceAfter: null,
          rawSnapshot: snapshot(source.headers, source.cells),
        })
      }
    }
  }

  const settledDates = settlements.map((row) => row.settledAt?.slice(0, 10)).filter((value): value is string => Boolean(value)).sort()
  const detailPayoutTotal = settlements.reduce((sum, row) => sum + row.payoutAmount, 0)
  const warnings = reportedPayoutTotal != null && Math.abs(reportedPayoutTotal - detailPayoutTotal) > 0.02
    ? [`พบรายละเอียด ${settlements.length.toLocaleString()} รายการ รวม ${detailPayoutTotal.toFixed(2)} แต่ยอดรอบเป็น ${reportedPayoutTotal.toFixed(2)} กรุณาล้างตัวกรองใน TikTok เมนู การเงิน > ธุรกรรม > ชำระเงินแล้ว แล้ว Export ใหม่`]
    : []
  return {
    kind: 'income',
    sheetName,
    reportFrom: reportRange.reportFrom ?? settledDates[0] ?? null,
    reportTo: reportRange.reportTo ?? settledDates.at(-1) ?? null,
    settlements,
    walletTransactions,
    warnings,
  }
}

export function parseTikTokWorkbook(workbook: XLSX.WorkBook): ShopeeParsedFile {
  if (workbook.SheetNames.includes('OrderSKUList')) {
    const sheet = workbook.Sheets.OrderSKUList
    if (!sheet) throw new Error('ไม่พบชีต OrderSKUList ในไฟล์ TikTok')
    return parseTikTokOrders(sheet, 'OrderSKUList')
  }
  const incomeSheetName = workbook.SheetNames.find((name) => name === 'รายละเอียดคำสั่งซื้อ')
    ?? workbook.SheetNames.find((name) => findHeaderRow(sheetRows(workbook.Sheets[name]).slice(0, 10), TIKTOK_INCOME_ORDER_HEADER) >= 0)
  if (incomeSheetName) return parseTikTokIncome(workbook, workbook.Sheets[incomeSheetName], incomeSheetName)
  throw new Error('ไม่สามารถระบุประเภทไฟล์ TikTok ได้ กรุณาเลือกไฟล์คำสั่งซื้อหรือ Income จาก TikTok Shop')
}

export function readEcommerceWorkbook(buffer: ArrayBuffer, platform: string): ShopeeParsedFile {
  const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true })
  return platform === 'tiktok' ? parseTikTokWorkbook(workbook) : parseShopeeWorkbook(workbook)
}
