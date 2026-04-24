/** Parse Excel column letters (A, Z, AA, BD) to 0-based column index */
export function excelColumnToIndex(letter: string): number {
  const s = letter.trim().toUpperCase()
  if (!s) throw new Error('คอลัมน์ว่าง')
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 64
    if (c < 1 || c > 26) throw new Error(`คอลัมน์ไม่ถูกต้อง: ${letter}`)
    n = n * 26 + c
  }
  return n - 1
}

export type EcommerceFieldKey =
  | 'order_no'
  | 'payment_at'
  | 'sku_ref'
  | 'price_orig'
  | 'price_sell'
  | 'qty'
  | 'line_total'
  | 'commission'
  | 'transaction_fee'
  | 'platform_fees_plus1'
  | 'buyer_note'
  | 'province'
  | 'district'
  | 'postal_code'

export type ChannelMapRow = {
  field_key: EcommerceFieldKey
  source_type: 'excel_column_letter' | 'header_exact' | 'header_contains'
  source_value: string
  priority: number
}

const FIELD_KEYS: EcommerceFieldKey[] = [
  'order_no',
  'payment_at',
  'sku_ref',
  'price_orig',
  'price_sell',
  'qty',
  'line_total',
  'commission',
  'transaction_fee',
  'platform_fees_plus1',
  'buyer_note',
  'province',
  'district',
  'postal_code',
]

/** ลำดับฟิลด์สำหรับ UI map / ตรวจความครบ */
export const ECOMMERCE_FIELD_ORDER: readonly EcommerceFieldKey[] = FIELD_KEYS

/** ป้ายภาษาไทยสำหรับตั้งค่า map คอลัมน์ */
export const ECOMMERCE_FIELD_LABELS: Record<EcommerceFieldKey, string> = {
  order_no: 'เลขคำสั่งซื้อ',
  payment_at: 'วันที่/เวลาชำระเงิน',
  sku_ref: 'SKU',
  price_orig: 'ราคาตั้ง',
  price_sell: 'ราคาขาย',
  qty: 'จำนวน',
  line_total: 'ยอดชำระ (บรรทัด)',
  commission: 'ค่าคอมมิชชั่น',
  transaction_fee: 'ค่าธุรกรรม (Txn fee)',
  platform_fees_plus1: 'ค่าแพลตฟอร์ม +1',
  buyer_note: 'หมายเหตุผู้ซื้อ',
  province: 'จังหวัด',
  district: 'อำเภอ',
  postal_code: 'รหัสไปรษณีย์',
}

/** Build field_key → column index from channel maps and optional header row (typically sheet row 0). */
export function buildColIndexByField(maps: ChannelMapRow[], headerRow: unknown[] | null): Record<EcommerceFieldKey, number | undefined> {
  const result = {} as Record<EcommerceFieldKey, number | undefined>
  for (const k of FIELD_KEYS) result[k] = undefined

  const letterMaps = maps.filter((m) => m.source_type === 'excel_column_letter')
  for (const m of letterMaps) {
    try {
      result[m.field_key] = excelColumnToIndex(m.source_value)
    } catch {
      /* skip invalid letter */
    }
  }

  if (headerRow && headerRow.length > 0) {
    const headers = headerRow.map((h) => String(h ?? '').trim().toLowerCase())
    const headerMaps = maps.filter((m) => m.source_type === 'header_exact' || m.source_type === 'header_contains')
    const byField = new Map<EcommerceFieldKey, ChannelMapRow[]>()
    for (const m of headerMaps) {
      const list = byField.get(m.field_key) ?? []
      list.push(m)
      byField.set(m.field_key, list)
    }
    for (const [field, list] of byField) {
      const sorted = [...list].sort((a, b) => b.priority - a.priority)
      for (const m of sorted) {
        const target = m.source_value.trim().toLowerCase()
        let idx = -1
        if (m.source_type === 'header_exact') {
          idx = headers.findIndex((h) => h === target)
        } else {
          idx = headers.findIndex((h) => h.includes(target))
        }
        if (idx >= 0) {
          result[field] = idx
          break
        }
      }
    }
  }

  return result
}

export function parseNumericCell(val: unknown): number | null {
  if (val == null || val === '') return null
  if (typeof val === 'number' && !Number.isNaN(val)) return val
  const s = String(val).replace(/,/g, '').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Returns ISO string for timestamptz or null */
export function parsePaymentCell(val: unknown): string | null {
  if (val == null || val === '') return null
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString()
  }
  if (typeof val === 'number' && !Number.isNaN(val)) {
    const ms = (val - 25569) * 86400 * 1000
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  const s = String(val).trim()
  if (!s) return null
  const d = new Date(s)
  if (!Number.isNaN(d.getTime())) return d.toISOString()
  return null
}

function cellAt(row: unknown[], idx: number | undefined): unknown {
  if (idx == null || idx < 0) return null
  if (idx >= row.length) return null
  return row[idx]
}

function strCell(val: unknown): string | null {
  if (val == null || val === '') return null
  const s = String(val).trim()
  return s || null
}

export type ParsedSaleLine = {
  row_index: number
  order_no: string | null
  payment_at: string | null
  sku_ref: string | null
  price_orig: number | null
  price_sell: number | null
  qty: number | null
  line_total: number | null
  commission: number | null
  transaction_fee: number | null
  platform_fees_plus1: number | null
  buyer_note: string | null
  province: string | null
  district: string | null
  postal_code: string | null
  raw_snapshot: Record<string, string | number | null>
}

export function parseWorksheetRows(
  rows: unknown[][],
  colIndexByField: Record<EcommerceFieldKey, number | undefined>,
  headerRowsToSkip: number,
  maxRows: number,
): ParsedSaleLine[] {
  const dataStart = Math.max(0, headerRowsToSkip)
  const out: ParsedSaleLine[] = []

  for (let i = dataStart; i < rows.length; i++) {
    if (out.length >= maxRows) break
    const row = rows[i] as unknown[]
    if (!row || row.length === 0) continue

    const snap: Record<string, string | number | null> = {}
    const pick = (key: EcommerceFieldKey) => {
      const v = cellAt(row, colIndexByField[key])
      if (v == null || v === '') snap[key] = null
      else if (typeof v === 'number') snap[key] = v
      else snap[key] = String(v)
      return v
    }

    const order_no = strCell(pick('order_no'))
    const sku_ref = strCell(pick('sku_ref'))
    const payment_at = parsePaymentCell(pick('payment_at'))
    const price_orig = parseNumericCell(pick('price_orig'))
    const price_sell = parseNumericCell(pick('price_sell'))
    const qty = parseNumericCell(pick('qty'))
    const line_total = parseNumericCell(pick('line_total'))
    const commission = parseNumericCell(pick('commission'))
    const transaction_fee = parseNumericCell(pick('transaction_fee'))
    const platform_fees_plus1 = parseNumericCell(pick('platform_fees_plus1'))
    const buyer_note = strCell(pick('buyer_note'))
    const province = strCell(pick('province'))
    const district = strCell(pick('district'))
    const postal_code = strCell(pick('postal_code'))

    const emptyLine =
      !order_no &&
      !sku_ref &&
      payment_at == null &&
      price_orig == null &&
      price_sell == null &&
      qty == null &&
      line_total == null
    if (emptyLine) continue

    out.push({
      row_index: i,
      order_no,
      payment_at,
      sku_ref,
      price_orig,
      price_sell,
      qty,
      line_total,
      commission,
      transaction_fee,
      platform_fees_plus1,
      buyer_note,
      province,
      district,
      postal_code,
      raw_snapshot: snap,
    })
  }

  return out
}
