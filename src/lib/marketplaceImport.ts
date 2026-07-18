import * as XLSX from 'xlsx'
import { excelColumnToIndex } from './ecommerceImport'
import { computeDueTimestamps, DEFAULT_DUE_RULE, type DueRule } from './shipDueBadge'

/**
 * Parser ไฟล์ Order จากแพลตฟอร์ม (Shopee/TikTok/...) สำหรับเมนู Marketplace
 * - map คอลัมน์ตาม column_map ของ mp_channel_configs (ยืดหยุ่นต่อหัวตารางที่ต่างกัน)
 * - group แถวตามเลขคำสั่งซื้อ → 1 งานต่อ 1 ออเดอร์ (หลายรายการสินค้าได้)
 * - เวลาในไฟล์เป็นเวลาไทย ต้อง parse แบบระบุ +07:00 เสมอ
 */

export type MpFieldKey =
  // ระดับออเดอร์
  | 'order_no'
  | 'platform_status'
  | 'buyer_username'
  | 'order_date'
  | 'payment_time'
  | 'recipient_name'
  | 'phone'
  | 'address'
  | 'province'
  | 'district'
  | 'postal_code'
  | 'buyer_note'
  | 'tracking_no'
  | 'shipping_fee'
  | 'order_total'
  // ระดับรายการสินค้า
  | 'product_name'
  | 'sku_ref'
  | 'variation'
  | 'qty'
  | 'unit_price'
  | 'line_total'

export type MpMapRow = {
  field_key: MpFieldKey
  source_type: 'excel_column_letter' | 'header_exact' | 'header_contains'
  source_value: string
  priority: number
}

export const MP_FIELD_ORDER: readonly MpFieldKey[] = [
  'order_no', 'platform_status', 'buyer_username', 'order_date', 'payment_time',
  'product_name', 'sku_ref', 'variation', 'qty', 'unit_price', 'line_total',
  'order_total', 'shipping_fee', 'recipient_name', 'phone', 'buyer_note',
  'address', 'province', 'district', 'postal_code', 'tracking_no',
]

export const MP_FIELD_LABELS: Record<MpFieldKey, string> = {
  order_no: 'เลขคำสั่งซื้อ (จำเป็น)',
  platform_status: 'สถานะจากแพลตฟอร์ม',
  buyer_username: 'ชื่อผู้ใช้ (ผู้ซื้อ)',
  order_date: 'วันที่สั่งซื้อ',
  payment_time: 'เวลาชำระเงิน (ใช้คำนวณกำหนดส่ง)',
  product_name: 'ชื่อสินค้า',
  sku_ref: 'SKU อ้างอิง (จับคู่สินค้าในระบบ)',
  variation: 'ลาย (ชื่อตัวเลือกในไฟล์)',
  qty: 'จำนวน',
  unit_price: 'ราคาขาย/หน่วย',
  line_total: 'ยอดสุทธิ (บรรทัด)',
  order_total: 'ยอดรวมออเดอร์',
  shipping_fee: 'ค่าจัดส่ง (ผู้ซื้อจ่าย)',
  recipient_name: 'ชื่อผู้รับ',
  phone: 'เบอร์โทรศัพท์',
  buyer_note: 'หมายเหตุจากผู้ซื้อ',
  address: 'ที่อยู่จัดส่ง',
  province: 'จังหวัด',
  district: 'เขต/อำเภอ',
  postal_code: 'รหัสไปรษณีย์',
  tracking_no: 'เลขพัสดุ',
}

/**
 * จัดกลุ่มฟิลด์ให้เข้าใจง่ายในหน้าตั้งค่า — สื่อว่าจับคู่คอลัมน์ในไฟล์
 * เพื่อดึงข้อมูลมาเปิดบิล (รายการสินค้า + หัวบิล) และข้อมูลจัดส่ง
 */
export const MP_FIELD_GROUPS: { label: string; keys: MpFieldKey[] }[] = [
  {
    label: 'รายการสินค้า (แต่ละชิ้นในบิล)',
    keys: ['sku_ref', 'product_name', 'variation', 'qty', 'unit_price', 'line_total'],
  },
  {
    label: 'ข้อมูลบิล (หัวออเดอร์)',
    keys: ['order_no', 'payment_time', 'order_total', 'shipping_fee', 'buyer_username', 'buyer_note', 'platform_status', 'order_date'],
  },
  {
    label: 'ข้อมูลจัดส่ง / ผู้รับ',
    keys: ['tracking_no', 'recipient_name', 'phone', 'address', 'province', 'district', 'postal_code'],
  },
]

/** ค่าเริ่มต้นสำหรับไฟล์ Shopee (หัวตารางภาษาไทย) — ใช้เป็น preset ในหน้าตั้งค่า */
export const SHOPEE_DEFAULT_MAP: MpMapRow[] = [
  { field_key: 'order_no', source_type: 'header_exact', source_value: 'หมายเลขคำสั่งซื้อ', priority: 0 },
  { field_key: 'platform_status', source_type: 'header_exact', source_value: 'สถานะการสั่งซื้อ', priority: 0 },
  { field_key: 'buyer_username', source_type: 'header_exact', source_value: 'ชื่อผู้ใช้ (ผู้ซื้อ)', priority: 0 },
  { field_key: 'order_date', source_type: 'header_exact', source_value: 'วันที่ทำการสั่งซื้อ', priority: 0 },
  { field_key: 'payment_time', source_type: 'header_exact', source_value: 'เวลาการชำระสินค้า', priority: 0 },
  { field_key: 'product_name', source_type: 'header_exact', source_value: 'ชื่อสินค้า', priority: 0 },
  { field_key: 'sku_ref', source_type: 'header_contains', source_value: 'เลขอ้างอิง sku', priority: 0 },
  { field_key: 'variation', source_type: 'header_exact', source_value: 'ชื่อตัวเลือก', priority: 0 },
  { field_key: 'unit_price', source_type: 'header_exact', source_value: 'ราคาขาย', priority: 0 },
  { field_key: 'qty', source_type: 'header_exact', source_value: 'จำนวน', priority: 0 },
  { field_key: 'line_total', source_type: 'header_exact', source_value: 'ราคาขายสุทธิ', priority: 0 },
  { field_key: 'order_total', source_type: 'header_exact', source_value: 'จำนวนเงินทั้งหมด', priority: 0 },
  { field_key: 'shipping_fee', source_type: 'header_contains', source_value: 'ค่าจัดส่งที่ชำระโดยผู้ซื้อ', priority: 0 },
  { field_key: 'recipient_name', source_type: 'header_exact', source_value: 'ชื่อผู้รับ', priority: 0 },
  { field_key: 'phone', source_type: 'header_exact', source_value: 'หมายเลขโทรศัพท์', priority: 0 },
  { field_key: 'buyer_note', source_type: 'header_exact', source_value: 'หมายเหตุจากผู้ซื้อ', priority: 0 },
  { field_key: 'address', source_type: 'header_contains', source_value: 'ที่อยู่ในการจัดส่ง', priority: 0 },
  { field_key: 'province', source_type: 'header_exact', source_value: 'จังหวัด', priority: 0 },
  { field_key: 'district', source_type: 'header_exact', source_value: 'เขต/อำเภอ', priority: 0 },
  { field_key: 'postal_code', source_type: 'header_contains', source_value: 'รหัสไปรษณีย์', priority: 0 },
  { field_key: 'tracking_no', source_type: 'header_contains', source_value: 'หมายเลขติดตามพัสดุ', priority: 0 },
]

/** สร้าง field → column index จาก column_map + header row (ตัวอักษรคอลัมน์ก่อน แล้ว match หัวตาราง) */
export function buildMpColIndex(maps: MpMapRow[], headerRow: unknown[] | null): Partial<Record<MpFieldKey, number>> {
  const result: Partial<Record<MpFieldKey, number>> = {}

  for (const m of maps.filter((m) => m.source_type === 'excel_column_letter')) {
    try {
      result[m.field_key] = excelColumnToIndex(m.source_value)
    } catch {
      /* ข้ามตัวอักษรคอลัมน์ที่ไม่ถูกต้อง */
    }
  }

  if (headerRow && headerRow.length > 0) {
    const headers = headerRow.map((h) => String(h ?? '').trim().toLowerCase())
    const byField = new Map<MpFieldKey, MpMapRow[]>()
    for (const m of maps) {
      if (m.source_type !== 'header_exact' && m.source_type !== 'header_contains') continue
      const list = byField.get(m.field_key) ?? []
      list.push(m)
      byField.set(m.field_key, list)
    }
    for (const [field, list] of byField) {
      const sorted = [...list].sort((a, b) => b.priority - a.priority)
      for (const m of sorted) {
        const target = m.source_value.trim().toLowerCase()
        const idx = m.source_type === 'header_exact'
          ? headers.findIndex((h) => h === target)
          : headers.findIndex((h) => h.includes(target))
        if (idx >= 0) {
          result[field] = idx
          break
        }
      }
    }
  }

  return result
}

/**
 * แปลงค่าวันเวลาในไฟล์ (เวลาไทย) → ISO UTC
 * รองรับ "2026-07-16 21:36", "2026-07-16 21:36:05" และ Excel serial number
 * ห้ามใช้ new Date(string) ตรง ๆ เพราะจะตีความตาม timezone ของเครื่อง
 */
export function parseBangkokDateTime(val: unknown): string | null {
  if (val == null || val === '') return null

  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString()
  }

  if (typeof val === 'number' && !Number.isNaN(val)) {
    // Excel serial = wall-clock ไทย → ลบ offset +7 ชม. ให้เป็น UTC
    const ms = (val - 25569) * 86400 * 1000 - 7 * 3600 * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }

  const s = String(val).trim()
  if (!s) return null
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (m) {
    const [, y, mo, day, h, mi, sec] = m
    const d = new Date(`${y}-${mo}-${day}T${h.padStart(2, '0')}:${mi}:${sec || '00'}+07:00`)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  // รูปแบบวันที่อย่างเดียว
  const md = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (md) {
    const d = new Date(`${s}T00:00:00+07:00`)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

function parseNum(val: unknown): number | null {
  if (val == null || val === '') return null
  if (typeof val === 'number' && !Number.isNaN(val)) return val
  const s = String(val).replace(/,/g, '').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function str(val: unknown): string | null {
  if (val == null || val === '') return null
  const s = String(val).trim()
  return s || null
}

export interface MpParsedItem {
  line_index: number
  product_name_raw: string | null
  sku_ref: string | null
  variation: string | null
  qty: number | null
  unit_price: number | null
  line_total: number | null
  raw_snapshot: Record<string, string | number | null>
}

export interface MpParsedOrder {
  marketplace_order_no: string
  platform_status: string | null
  buyer_username: string | null
  order_date: string | null
  payment_time: string | null
  recipient_name: string | null
  phone: string | null
  address: string | null
  province: string | null
  district: string | null
  postal_code: string | null
  buyer_note: string | null
  tracking_no: string | null
  shipping_fee: number | null
  order_total: number | null
  raw_snapshot: Record<string, string | number | null>
  ship_due_at: string | null
  overdue_at: string | null
  items: MpParsedItem[]
}

export interface MpParseResult {
  orders: MpParsedOrder[]
  rowCount: number
  warnings: string[]
}

export interface MpParseConfig {
  sheet_name?: string | null
  header_row?: number | null
  column_map: MpMapRow[]
  due_rule?: DueRule | null
}

/** อ่าน workbook + group เป็นออเดอร์ พร้อมคำนวณ ship_due_at/overdue_at ตาม due_rule */
export async function parseMarketplaceWorkbook(file: File, config: MpParseConfig): Promise<MpParseResult> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array', cellDates: false })

  const wanted = (config.sheet_name || '').trim()
  const sheetName = wanted && wb.SheetNames.includes(wanted) ? wanted : wb.SheetNames[0]
  if (!sheetName) throw new Error('ไม่พบ sheet ในไฟล์')
  const sheet = wb.Sheets[sheetName]

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null })
  const headerRowIdx = Math.max(0, config.header_row ?? 0)
  const headerRow = (rows[headerRowIdx] as unknown[]) || []
  const colIndex = buildMpColIndex(config.column_map || [], headerRow)

  const warnings: string[] = []
  if (colIndex.order_no == null) {
    throw new Error('จับคู่คอลัมน์ "เลขคำสั่งซื้อ" ไม่ได้ — ตรวจสอบการตั้งค่าจับคู่คอลัมน์กับหัวตารางของไฟล์')
  }
  for (const key of ['payment_time', 'product_name', 'qty'] as MpFieldKey[]) {
    if (colIndex[key] == null) warnings.push(`จับคู่คอลัมน์ "${MP_FIELD_LABELS[key]}" ไม่ได้`)
  }

  const headerLabels = headerRow.map((h, i) => String(h ?? '').trim() || `คอลัมน์ ${i + 1}`)
  const cell = (row: unknown[], key: MpFieldKey): unknown => {
    const idx = colIndex[key]
    if (idx == null || idx < 0 || idx >= row.length) return null
    return row[idx]
  }

  const dueRule = config.due_rule || DEFAULT_DUE_RULE
  const orderMap = new Map<string, MpParsedOrder>()
  let rowCount = 0

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] as unknown[]
    if (!row || row.length === 0) continue
    const orderNo = str(cell(row, 'order_no'))
    if (!orderNo) {
      // แถวว่าง/แถวสรุปท้ายไฟล์ — ข้ามเงียบ ๆ ถ้าไม่มีข้อมูลสินค้า
      if (str(cell(row, 'product_name'))) warnings.push(`แถวที่ ${i + 1}: มีข้อมูลสินค้าแต่ไม่มีเลขคำสั่งซื้อ — ข้าม`)
      continue
    }
    rowCount++

    // raw snapshot ของทั้งแถว (key = หัวตาราง) เก็บที่รายการสินค้า
    const snap: Record<string, string | number | null> = {}
    row.forEach((v, idx) => {
      if (v == null || v === '') return
      snap[headerLabels[idx] || `คอลัมน์ ${idx + 1}`] = typeof v === 'number' ? v : String(v)
    })

    let order = orderMap.get(orderNo)
    if (!order) {
      const paymentTime = parseBangkokDateTime(cell(row, 'payment_time'))
      const due = computeDueTimestamps(paymentTime, dueRule)
      if (!paymentTime) warnings.push(`ออเดอร์ ${orderNo}: ไม่มีเวลาชำระเงิน — จะไม่มีป้ายส่งด่วน/ล่าช้า`)
      order = {
        marketplace_order_no: orderNo,
        platform_status: str(cell(row, 'platform_status')),
        buyer_username: str(cell(row, 'buyer_username')),
        order_date: parseBangkokDateTime(cell(row, 'order_date')),
        payment_time: paymentTime,
        recipient_name: str(cell(row, 'recipient_name')),
        phone: str(cell(row, 'phone')),
        address: str(cell(row, 'address')),
        province: str(cell(row, 'province')),
        district: str(cell(row, 'district')),
        postal_code: str(cell(row, 'postal_code')),
        buyer_note: str(cell(row, 'buyer_note')),
        tracking_no: str(cell(row, 'tracking_no')),
        shipping_fee: parseNum(cell(row, 'shipping_fee')),
        order_total: parseNum(cell(row, 'order_total')),
        raw_snapshot: snap,
        ship_due_at: due.ship_due_at,
        overdue_at: due.overdue_at,
        items: [],
      }
      orderMap.set(orderNo, order)
    }

    order.items.push({
      line_index: order.items.length,
      product_name_raw: str(cell(row, 'product_name')),
      sku_ref: str(cell(row, 'sku_ref')),
      variation: str(cell(row, 'variation')),
      qty: parseNum(cell(row, 'qty')),
      unit_price: parseNum(cell(row, 'unit_price')),
      line_total: parseNum(cell(row, 'line_total')),
      raw_snapshot: snap,
    })
  }

  return { orders: Array.from(orderMap.values()), rowCount, warnings }
}
