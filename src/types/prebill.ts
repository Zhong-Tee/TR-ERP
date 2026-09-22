export type PreBillDocumentType = 'quotation' | 'production_confirmation'

export type PreBillStatus =
  | 'draft'
  | 'active'
  | 'pending_discount'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'converted'
  | 'cancelled'

export interface PreBillItem {
  id?: string
  document_id?: string
  sort_order: number
  product_id: string | null
  product_code: string | null
  product_name: string
  quantity: number
  unit_price: number
  is_free: boolean
  is_detail_row?: boolean
  parent_item_id?: string | null
  oh_snapshot: number
  ink_color: string | null
  product_type: string | null
  cartoon_pattern: string | null
  line_pattern: string | null
  font: string | null
  line_1: string | null
  line_2: string | null
  line_3: string | null
  no_name_line: boolean
  notes: string | null
  file_attachment: string | null
  attachment_name: string | null
  field_snapshot: Record<string, unknown>
}

export interface PreBillDocument {
  id: string
  document_type: PreBillDocumentType
  document_no: string
  status: PreBillStatus
  channel_code: string
  header_name: string
  customer_name: string
  customer_address: string | null
  recipient_name: string | null
  customer_phone: string | null
  billing_details: Record<string, unknown>
  delivery_term: string
  valid_until: string
  payment_method: string | null
  subtotal: number
  shipping_cost: number
  promotion_discount: number
  special_discount: number
  special_discount_type: 'amount' | 'percent' | null
  special_discount_value: number
  total_amount: number
  promotion_ids: string[]
  promotion_snapshot: Array<Record<string, unknown>>
  shipping_snapshot: Record<string, unknown>
  internal_note: string | null
  discount_request_note: string | null
  discount_requested_at: string | null
  discount_requested_by: string | null
  approved_special_discount: number | null
  approval_note: string | null
  approved_at: string | null
  approved_by: string | null
  rejection_note: string | null
  converted_order_id: string | null
  converted_order?: { bill_no: string | null } | null
  converted_at: string | null
  source_document_id: string | null
  owner_id: string
  owner_name: string
  created_at: string
  updated_at: string
  or_prebill_items?: PreBillItem[]
}

export interface PreBillChannelSetting {
  channel_code: string
  document_type: PreBillDocumentType
  document_prefix: string
  header_name: string
  default_valid_days: number
}

export const PREBILL_TYPE_LABEL: Record<PreBillDocumentType, string> = {
  quotation: 'ใบเสนอราคา',
  production_confirmation: 'ใบยืนยันรายละเอียดการผลิต',
}

export const PREBILL_STATUS_LABEL: Record<PreBillStatus, string> = {
  draft: 'ร่าง',
  active: 'ใช้งาน',
  pending_discount: 'รออนุมัติส่วนลด',
  approved: 'อนุมัติแล้ว',
  rejected: 'ไม่อนุมัติ',
  expired: 'หมดอายุ',
  converted: 'เปิดบิลแล้ว',
  cancelled: 'ยกเลิก',
}
