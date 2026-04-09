/** ใช้ร่วมกับ ClaimRequestComparePanel + โหลดข้อมูลเปรียบเทียบคำขอเคลม */

export type RefOrderEmbed = {
  customer_name?: string | null
  customer_address?: string | null
  mobile_phone?: string | null
  channel_code?: string | null
  admin_user?: string | null
  tracking_number?: string | null
  bill_created_at_display?: string | null
} | null

export type ClaimCompareDetail = {
  id: string
  ref_order_id: string
  claim_type: string
  proposed_snapshot: { order?: Record<string, unknown>; items?: unknown[] } | null
  ref_snapshot: {
    bill_no?: string
    price?: number
    total_amount?: number
    shipping_cost?: number
    discount?: number
  } | null
  status: string
  created_at: string
  submitted_by: string | null
  rejected_reason?: string | null
  supporting_url?: string | null
  claim_description?: string | null
  ref_order?: RefOrderEmbed
  submitter?: { username?: string | null } | null
  packing_video_url?: string | null
  created_claim_order_id?: string | null
}

export type OrderItemRow = {
  product_name?: string | null
  quantity?: number | null
  unit_price?: number | null
  is_free?: boolean | null
}

export type RefOrderDetail = {
  bill_no: string
  price: number
  total_amount: number
  shipping_cost: number
  discount: number
  customer_name?: string | null
  customer_address?: string | null
  mobile_phone?: string | null
  channel_code?: string | null
  admin_user?: string | null
  /** สำหรับค้นหาวิดีโอแพค */
  tracking_number?: string | null
  order_items?: OrderItemRow[]
}

export function fmtMoney(n: number) {
  return n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function lineTotal(it: OrderItemRow) {
  if (it.is_free) return 0
  return (Number(it.quantity) || 0) * (Number(it.unit_price) || 0)
}

export function submitterDisplayClaim(s: ClaimCompareDetail): string {
  const u = s.submitter?.username?.trim()
  if (u) return u
  if (s.submitted_by) return s.submitted_by.slice(0, 8) + '…'
  return '–'
}

export function channelLabel(map: Record<string, string>, code: string | null | undefined): string {
  const c = (code ?? '').trim()
  if (!c) return '–'
  return map[c] ?? c
}

export function externalUrlOrNull(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  const s = raw.trim()
  if (/^https?:\/\//i.test(s)) return s
  return `https://${s}`
}

export function formatRefBillCreatedAt(entryDate: string | null | undefined, createdAt: string | null | undefined): string {
  const raw = (entryDate && String(entryDate).trim()) || (createdAt && String(createdAt).trim()) || ''
  if (!raw) return '–'
  const d = new Date(raw)
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleString('th-TH')
  }
  return raw
}

export function mobilePhoneFromBillingDetails(bd: unknown): string | null {
  if (!bd || typeof bd !== 'object') return null
  const o = bd as { mobile_phone?: unknown; tax_customer_phone?: unknown }
  const a = o.mobile_phone != null ? String(o.mobile_phone).trim() : ''
  const b = o.tax_customer_phone != null ? String(o.tax_customer_phone).trim() : ''
  return a || b || null
}

export function rowToRefEmbed(o: {
  customer_name?: string | null
  customer_address?: string | null
  channel_code?: string | null
  admin_user?: string | null
  tracking_number?: string | null
  billing_details?: unknown
  entry_date?: string | null
  created_at?: string | null
}): NonNullable<RefOrderEmbed> {
  return {
    customer_name: o.customer_name ?? null,
    customer_address: o.customer_address ?? null,
    mobile_phone: mobilePhoneFromBillingDetails(o.billing_details),
    channel_code: o.channel_code ?? null,
    admin_user: o.admin_user ?? null,
    tracking_number: o.tracking_number ?? null,
    bill_created_at_display: formatRefBillCreatedAt(o.entry_date, o.created_at),
  }
}

export function customerFromProposedOrder(order: Record<string, unknown>): {
  customer_name?: string | null
  customer_address?: string | null
  mobile_phone?: string | null
  channel_code?: string | null
  admin_user?: string | null
} | null {
  if (!order || typeof order !== 'object') return null
  const has =
    order.customer_name != null ||
    order.customer_address != null ||
    order.channel_code != null ||
    order.billing_details != null
  if (!has) return null
  const bd = order.billing_details
  return {
    customer_name: order.customer_name != null ? String(order.customer_name) : null,
    customer_address: order.customer_address != null ? String(order.customer_address) : null,
    mobile_phone: mobilePhoneFromBillingDetails(bd),
    channel_code: order.channel_code != null ? String(order.channel_code) : null,
    admin_user: null,
  }
}
