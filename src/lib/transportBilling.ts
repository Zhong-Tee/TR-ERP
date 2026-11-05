import { parsePickupAt, normalizeDeliveryKey as key } from './deliveryCheck'

export type BillingLine = { file: string; sheet: string; row: number; tracking: string; order: string; amount: number | null; consignment: boolean; shipmentId?: string; sender?: string; pickupDate?: string }
export type BillingOrder = { id: string; bill_no: string; channel_order_no: string | null; tracking_number: string | null; status: string }
export type BillingReference = { tracking_no: string | null; order_no: string | null }
export function billingSourceMetadata(headers: string[], row: string[]) {
  const normalized = headers.map(header => header.trim().toLowerCase())
  const senderColumn = normalized.findIndex(header => ['sender', 'ชื่อผู้ส่ง', 'ผู้ส่ง'].includes(header))
  const dateColumn = normalized.findIndex(header => ['pu time', 'เวลาสร้าง', 'วันที่จัดส่ง'].includes(header))
  const rawDate = dateColumn < 0 ? '' : (row[dateColumn] || '').trim()
  const iso = rawDate ? parsePickupAt(rawDate) : ''
  return {
    sender: senderColumn < 0 ? '' : (row[senderColumn] || '').trim(),
    pickupDate: iso ? new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(iso)) : '',
  }
}

export function detectBillingColumns(headers: string[], kind: 'bill' | 'wanyen') {
  const normalized = headers.map(header => header.trim().toLowerCase())
  const find = (...aliases: string[]) => { const index = normalized.findIndex(header => aliases.includes(header)); return index < 0 ? '' : String(index + 1) }
  return {
    tracking: find('เลขพัสดุ', 'tracking no.', 'tracking no', 'tracking'),
    order: kind === 'wanyen' ? find('สาขาปลายทาง', 'เลขออเดอร์', 'เลขบิล', 'order no.', 'order no') : find('เลขออเดอร์', 'เลขบิล', 'order no.', 'order no'),
    amount: kind === 'bill' ? find('freight', 'ยอดเรียกเก็บ', 'ค่าขนส่ง') : find('ต้นทุนค่าขนส่ง', 'ต้นทุนขนส่ง'),
    note: find('หมายเหตุ'),
    shipment: kind === 'wanyen' ? find('รหัสรายการจัดส่ง') : '',
  }
}

// The Wanyen export repeats a shipment per product. Only collapse rows with
// a shipment ID, identical references and no cost; never sum repeated costs.
export function groupWanyenShipments(lines: BillingLine[]): BillingLine[] {
  const grouped = new Map<string, BillingLine>()
  const result: BillingLine[] = []
  for (const line of lines) {
    if (!line.shipmentId || line.amount !== null) { result.push(line); continue }
    const id = JSON.stringify([key(line.shipmentId), key(line.tracking), key(line.order)])
    const existing = grouped.get(id)
    if (existing) existing.consignment ||= line.consignment
    else { const copy = { ...line }; grouped.set(id, copy); result.push(copy) }
  }
  return result
}

/** Summary rows have no shipment references and only an amount/total label.
 * Keep incomplete shipment rows with other details visible for review. */
export function isBillingSummaryRow(row: string[], columns: { tracking: string; order: string; amount: string }): boolean {
  const get = (column: string) => column ? String(row[Number(column) - 1] ?? '').trim() : ''
  if (get(columns.tracking) || get(columns.order) || !columns.amount || parseBillingAmount(get(columns.amount)) === null) return false
  const labels = row.filter((_, index) => index !== Number(columns.amount) - 1).map(value => String(value).trim()).filter(Boolean)
  return labels.every(value => /^(?:ยอดรวม|รวม|รวมทั้งหมด|ยอดรวมทั้งหมด|รวมทั้งสิ้น|ยอดรวมทั้งสิ้น|total|grand total|subtotal)\s*[:：]?$/i.test(value))
}

export function parseBillingAmount(value: unknown): number | null {
  const raw = String(value ?? '').trim().replace(/[,฿\s]/g, '')
  if (!raw || !/^-?\d+(\.\d{1,2})?$/.test(raw)) return null
  const amount = Number(raw)
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}
function matches(line: BillingLine, tracking: unknown, orders: unknown[]) {
  return Boolean((key(line.tracking) && key(line.tracking) === key(tracking)) || (key(line.order) && orders.some(order => key(order) === key(line.order))))
}
export function reconcileBilling(bills: BillingLine[], wanyen: BillingLine[], orders: BillingOrder[], consignments: BillingReference[]) {
  const shipments = groupWanyenShipments(wanyen)
  const counts = new Map<string, number>()
  bills.forEach(line => { const id = key(line.tracking) || key(line.order); if (id) counts.set(id, (counts.get(id) || 0) + 1) })
  return bills.map(line => {
    const erp = orders.filter(order => matches(line, order.tracking_number, [order.bill_no, order.channel_order_no]))
    const wy = shipments.filter(row => matches(line, row.tracking, [row.order]))
    const consignment = line.consignment || wy.some(row => row.consignment) || consignments.some(row => matches(line, row.tracking_no, [row.order_no]))
    const conflict = erp.some(order => key(line.tracking) && key(order.tracking_number) && key(line.tracking) !== key(order.tracking_number))
    const reference = wy.length === 1 ? wy[0].amount : null
    const difference = line.amount !== null && reference !== null ? Math.round((line.amount - reference) * 100) / 100 : null
    const status = !line.tracking && !line.order ? 'ไม่มีเลขอ้างอิง' : (counts.get(key(line.tracking) || key(line.order)) || 0) > 1 ? 'เรียกเก็บซ้ำ / ต้องตรวจ' : erp.length > 1 || wy.length > 1 || conflict ? 'ข้อมูลขัดแย้ง / ต้องตรวจ' : erp.some(order => order.status === 'ยกเลิก') ? 'บิลยกเลิก / ต้องตรวจ' : consignment ? 'ฝากส่ง' : !erp.length && !wy.length ? 'ไม่พบใน ERP + Wanyen' : 'พบรายการจัดส่ง'
    return { ...line, consignment, status, source: [erp.length ? 'ERP' : '', wy.length ? 'Wanyen' : ''].filter(Boolean).join(' + '), reference, difference, amountStatus: line.amount === null ? 'ยอดเรียกเก็บไม่ถูกต้อง' : difference === null ? 'รอตรวจอัตรา' : difference === 0 ? 'ยอดตรงกับอ้างอิง' : 'ยอดต่างจากอ้างอิง' }
  })
}
