import type { DueRule } from '../lib/shipDueBadge'
import type { MpMapRow } from '../lib/marketplaceImport'

/** ตาราง mp_channel_configs — ตั้งค่าช่องทางนำเข้าไฟล์ Order (เมนู Marketplace) */
export interface MpChannelConfig {
  id: string
  name: string
  channel_code: string
  sheet_name: string | null
  header_row: number
  column_map: MpMapRow[]
  due_rule: DueRule
  is_active: boolean
  created_at: string
  updated_at: string
}

export type MpOrderStatus = 'new' | 'assigned' | 'follow_up' | 'done' | 'cancelled'

/** ตาราง mp_orders — งาน 1 แถวต่อ 1 ออเดอร์จากไฟล์ */
export interface MpOrder {
  id: string
  batch_id: string
  config_id: string
  channel_code: string
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
  raw_snapshot: Record<string, string | number | null> | null
  ship_due_at: string | null
  overdue_at: string | null
  status: MpOrderStatus
  assigned_to: string | null
  assigned_at: string | null
  assigned_by: string | null
  follow_up_note: string | null
  follow_up_at: string | null
  draft_saved_at: string | null
  billed_order_id: string | null
  billed_bill_no: string | null
  billed_at: string | null
  cancel_note: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  created_at: string
  mp_order_items?: MpOrderItem[]
}

/** ตาราง mp_order_items — รายการสินค้าจากไฟล์ + ร่างข้อมูลที่ sales กรอก */
export interface MpOrderItem {
  id: string
  mp_order_id: string
  line_index: number
  product_name_raw: string | null
  sku_ref: string | null
  variation: string | null
  qty: number | null
  unit_price: number | null
  line_total: number | null
  raw_snapshot: Record<string, string | number | null> | null
  product_id: string | null
  product_type: string | null
  ink_color: string | null
  cartoon_pattern: string | null
  line_pattern: string | null
  font: string | null
  line_1: string | null
  line_2: string | null
  line_3: string | null
  no_name_line: boolean
  is_free: boolean
  notes: string | null
  created_at: string
}

/** ผู้ใช้ sales สำหรับ dropdown มอบหมายงาน */
export interface MpSalesUser {
  id: string
  username: string | null
  email: string
  role: string
}
