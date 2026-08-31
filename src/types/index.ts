// User and Auth Types
export interface User {
  id: string
  email: string
  username?: string
  role: UserRole
  is_active?: boolean
  /** เปิดสิทธิ์เข้าหน้า Employee บนมือถือ โดยไม่ต้องเปลี่ยน role หลัก */
  employee_access?: boolean
  /** สิทธิ์โหมดมือถือหลาย role เช่น ["production_mb","picker"] — ดู src/lib/mobileMode.ts */
  mobile_access?: string[]
  created_at?: string
}

export type UserRole = 
  | 'superadmin' 
  | 'admin'
  | 'sales-tr'
  | 'qc_order'
  | 'sales-pump'
  | 'qc_staff' 
  | 'packing_staff' 
  | 'account' 
  | 'store'
  | 'production'
  | 'production_mb'
  | 'manager'
  | 'technician'
  | 'picker'
  | 'auditor'
  | 'hr'
  | 'employee'

// Order Types
export type OrderStatus = 
  | 'รอลงข้อมูล'
  | 'รอตรวจคำสั่งซื้อ'
  | 'ลงข้อมูลเสร็จสิ้น'
  | 'ลงข้อมูลผิด'
  | 'ตรวจสอบไม่ผ่าน'
  | 'ตรวจสอบไม่สำเร็จ'
  | 'ตรวจสอบแล้ว'
  | 'รอออกแบบ'
  | 'ไม่ต้องออกแบบ'
  | 'ออกแบบแล้ว'
  | 'รอคอนเฟิร์ม'
  | 'คอนเฟิร์มแล้ว'
  | 'เสร็จสิ้น'
  | 'ย้ายจากใบงาน'
  | 'ใบสั่งงาน'
  | 'ใบงานกำลังผลิต'
  | 'จัดส่งแล้ว'
  | 'ยกเลิก'

export interface Order {
  id: string
  channel_code: string
  bill_no: string
  status: OrderStatus
  price: number
  shipping_cost: number
  discount: number
  total_amount: number
  payment_method: string | null
  promotion: string | null
  payment_date: string | null
  payment_time: string | null
  customer_name: string
  customer_address: string
  /** เลขคำสั่งซื้อ (ช่องทาง SPTR, FSPTR, TTTR, LZTR, PGTR, WY) */
  channel_order_no?: string | null
  /** ชื่อลูกค้า ใต้ที่อยู่ (ช่องทาง FBTR, PUMP, OATR, SHOP, INFU, PN) */
  recipient_name?: string | null
  /** วันที่ เวลา นัดรับ (ช่องทาง SHOP PICKUP) */
  scheduled_pickup_at?: string | null
  admin_user: string
  /** ผู้แก้ไขบิลล่าสุด — แสดงผลเท่านั้น ไม่มีผลต่อการมองเห็น (การมองเห็นใช้ admin_user = ผู้สร้างบิล) */
  last_edited_by?: string | null
  entry_date: string
  work_order_name: string | null
  /** อ้างอิงใบงานด้วย UUID (รองรับ reuse เลขใบงาน) */
  work_order_id?: string | null
  /** ชื่อใบงานที่บิลถูก "ย้ายไปใบสั่งงาน" จาก (Plan ป้ายแก้ไข) */
  plan_released_from_work_order?: string | null
  plan_released_at?: string | null
  shipped_by: string | null
  shipped_time: string | null
  /** กำหนดส่ง (จากเมนู Marketplace) — ใช้แสดงป้าย ส่งด่วน/ล่าช้า; NULL = ไม่มีป้าย */
  ship_due_at?: string | null
  /** เวลาที่นับเป็น "ล่าช้า" (เวลาชำระเงิน + ชั่วโมงตามตั้งค่า) */
  overdue_at?: string | null
  /** ชื่อป้ายตัวเลือกการจัดส่งจากกฎ Marketplace */
  urgency_label?: string | null
  /** สีป้ายตัวเลือกการจัดส่งจากกฎ Marketplace */
  urgency_color?: string | null
  /** ค่าตัวเลือกการจัดส่งต้นทางจากไฟล์ Marketplace */
  shipping_option?: string | null
  tracking_number: string | null
  claim_type: string | null
  claim_details: string | null
  /** บิล REQ: เวลายืนยันที่อยู่/ผู้รับ/เบอร์ (ว่าง = ยังไม่ยืนยัน) */
  claim_shipping_confirmed_at?: string | null
  confirm_note?: string | null
  /** PUMP: true = คิว Confirm งานใหม่ (ต้องออกแบบ), false = คิว ไม่ต้องออกแบบ เมื่อเข้าสู่ขั้นตรวจสอบแล้ว */
  requires_confirm_design?: boolean
  billing_details: BillingDetails | null
  packing_meta: PackingMeta | null
  transport_meta?: {
    verified?: boolean
    verified_at?: string
    verified_by?: string
    carrier?: string
    parcel_type?: string
  } | null
  created_at: string
  updated_at: string
  /** การเก็บรายการตรวจสอบไม่ผ่านเข้าประวัติ (ไม่ลบบิล/สลิป) */
  failed_queue_archived_at?: string | null
  failed_queue_archived_by?: string | null
  failed_queue_archived_by_name?: string | null
  failed_queue_archive_reason?: string | null
  order_items?: OrderItem[]
}

export interface OrderItem {
  id: string
  order_id: string
  item_uid: string
  product_id: string
  product_name: string
  quantity: number
  /** แถวรายละเอียด เช่น ชั้น 2–5 ของ CONDO STAMP; ไม่นับราคา สต๊อก หรือจำนวนผลิต */
  is_detail_row?: boolean
  /** แถวสินค้าหลักที่รายละเอียดนี้สังกัด */
  parent_item_id?: string | null
  unit_price?: number
  ink_color: string | null
  product_type: string | null
  cartoon_pattern: string | null
  line_pattern: string | null
  font: string | null
  line_1: string | null
  line_2: string | null
  line_3: string | null
  /** เมื่อ true = ไม่รับข้อความบรรทัด 1-3, แสดง "ไม่รับชื่อ" ที่หมายเหตุ */
  no_name_line?: boolean
  /** เมื่อ true = สินค้าของแถม (ฟรี) ไม่คิดราคา */
  is_free?: boolean
  notes: string | null
  file_attachment: string | null
  attachment_name?: string | null
  packing_status: string | null
  item_scan_time?: string | null
  created_at: string
}

export interface BillingDetails {
  request_tax_invoice: boolean
  request_cash_bill: boolean
  tax_customer_name: string | null
  tax_customer_address: string | null
  /** เบอร์โทรสำหรับบิลเงินสด/ใบกำกับ (เมื่อระบุในฟอร์มขอเอกสาร) */
  tax_customer_phone?: string | null
  tax_id: string | null
  tax_items: TaxItem[]
  /** Optional address parts for customer shipping (ที่อยู่, แขวง, เขต, จังหวัด, รหัสไปรษณีย์, เบอร์โทร) */
  address_line?: string | null
  sub_district?: string | null
  district?: string | null
  province?: string | null
  postal_code?: string | null
  mobile_phone?: string | null
}

export interface TaxItem {
  product_name: string
  quantity: number
  unit_price: number
}

export interface PackingMeta {
  parcelScanned: boolean
  scanTime?: string
  scannedBy?: string
  /** หมายเลข Tag ประจำวัน (รีเซ็ตตามวันที่ใน client) */
  dailyPackingTag?: number
}

export interface PackingVideo {
  id: string
  order_id: string | null
  work_order_name: string | null
  tracking_number: string | null
  storage_path: string
  duration_seconds: number | null
  recorded_by: string | null
  recorded_at: string | null
  gdrive_file_id?: string | null
  gdrive_url?: string | null
  created_at: string
}

export interface OrderChatLog {
  id: string
  order_id: string
  bill_no: string
  sender_id: string
  sender_name: string
  message: string
  link_url?: string | null
  created_at: string
}

export interface IssueType {
  id: string
  name: string
  color: string
  is_active: boolean
  created_at: string
  /** ค่าคงที่สำหรับ logic (เช่น stop_production) — แถวเก่าอาจเป็น null */
  slug?: string | null
}

export interface Issue {
  id: string
  order_id: string
  work_order_name?: string | null
  type_id?: string | null
  title: string
  status: 'On' | 'Close'
  created_by: string
  created_at: string
  closed_at?: string | null
  duration_minutes?: number | null
}

export interface IssueMessage {
  id: string
  issue_id: string
  sender_id: string
  sender_name: string
  message: string
  source_scope?: 'orders' | 'plan'
  is_hidden?: boolean
  created_at: string
}

export interface IssueRead {
  issue_id: string
  user_id: string
  last_read_at: string
}

// Work Order Types
export interface WorkOrder {
  id: string
  work_order_name: string
  status: string
  order_count: number
  created_at: string
  updated_at: string
  /** มีบิลถูกย้ายออกจากใบงานบางส่วน */
  plan_wo_modified?: boolean
}

// Product Type: FG = Finished Goods, RM = Raw Material, PP = Processed Products
export type ProductType = 'FG' | 'RM' | 'PP'

// Product Types (รูปสินค้าดึงจาก Bucket product-images ชื่อไฟล์ = product_code)
export interface Product {
  id: string
  product_code: string
  product_name: string
  seller_name: string | null
  product_name_cn: string | null
  order_point: string | null
  order_point_days: number | null
  product_category: string | null
  product_type: ProductType
  rubber_code: string | null
  storage_location: string | null
  unit_cost: number | null
  landed_cost: number | null
  safety_stock: number | null
  unit_name: string | null
  unit_multiplier: number | null
  /** true = ไม่แจ้งเตือนถึงจุดสั่งซื้อ (รอขายหมดแล้วค่อยซ่อน) */
  is_hold: boolean
  hold_reason?: string | null
  hold_at?: string | null
  hold_by?: string | null
  /** @deprecated ลบคอลัมน์แล้ว รูปดึงจาก bucket product-images ตาม product_code */
  image_url?: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface StockBalance {
  id: string
  product_id: string
  on_hand: number
  reserved: number
  safety_stock: number
  created_at: string
  updated_at: string
}

export interface StockMovement {
  id: string
  product_id: string
  movement_type: string
  qty: number
  ref_type?: string | null
  ref_id?: string | null
  note?: string | null
  created_by?: string | null
  created_at: string
}

export interface InventoryPR {
  id: string
  pr_no: string
  status: string
  pr_type?: string | null
  supplier_id?: string | null
  supplier_name?: string | null
  requested_by?: string | null
  requested_at?: string | null
  approved_by?: string | null
  approved_at?: string | null
  rejected_by?: string | null
  rejected_at?: string | null
  rejection_reason?: string | null
  note?: string | null
  created_at: string
  updated_at: string
  /** joined */
  inv_pr_items?: InventoryPRItem[]
  inv_po?: Array<Pick<InventoryPO, 'id' | 'po_no' | 'status'>>
}

export interface InventoryPRItem {
  id: string
  pr_id: string
  product_id: string
  qty: number
  unit?: string | null
  last_purchase_price?: number | null
  estimated_price?: number | null
  note?: string | null
  created_at: string
  /** joined product */
  pr_products?: Product | null
}

export interface InventoryPO {
  id: string
  po_no: string
  pr_id?: string | null
  status: string
  supplier_id?: string | null
  supplier_name?: string | null
  created_by?: string | null
  ordered_by?: string | null
  ordered_at?: string | null
  intl_shipping_method?: string | null
  intl_shipping_weight?: number | null
  intl_shipping_cbm?: number | null
  intl_shipping_cost?: number | null
  intl_shipping_currency?: string | null
  intl_exchange_rate?: number | null
  intl_shipping_cost_thb?: number | null
  total_amount?: number | null
  grand_total?: number | null
  expected_arrival_date?: string | null
  note?: string | null
  created_at: string
  updated_at: string
  /** joined */
  inv_po_items?: InventoryPOItem[]
  inv_pr?: { pr_no: string; note?: string | null } | null
}

export interface InventoryPOItem {
  id: string
  po_id: string
  product_id: string
  qty: number
  unit_price?: number | null
  subtotal?: number | null
  unit?: string | null
  note?: string | null
  qty_received_total?: number | null
  resolution_type?: string | null
  resolution_qty?: number | null
  resolution_note?: string | null
  resolved_at?: string | null
  resolved_by?: string | null
  created_at: string
  /** joined product */
  pr_products?: Product | null
}

export interface InventoryGR {
  id: string
  gr_no: string
  po_id?: string | null
  status: string
  received_by?: string | null
  received_at?: string | null
  dom_shipping_company?: string | null
  dom_shipping_cost?: number | null
  dom_cost_per_piece?: number | null
  shortage_note?: string | null
  note?: string | null
  created_at: string
  updated_at: string
  /** joined */
  inv_gr_items?: InventoryGRItem[]
  inv_po?: {
    po_no: string
    note?: string | null
    status?: string | null
    expected_arrival_date?: string | null
    intl_shipping_cost_thb?: number | null
    inv_po_items?: Array<{
      product_id?: string | null
      qty?: number | null
      unit_price?: number | null
      resolution_type?: string | null
      qty_received_total?: number | null
    }> | null
    inv_pr?: { pr_no?: string | null; note?: string | null; pr_type?: string | null } | null
  } | null
}

export interface InventoryGRItem {
  id: string
  gr_id: string
  product_id: string
  qty_received: number
  qty_ordered?: number | null
  qty_shortage?: number | null
  shortage_note?: string | null
  unit_cost?: number | null
  total_cost?: number | null
  created_at: string
  /** joined product */
  pr_products?: Product | null
  /** joined images */
  inv_gr_item_images?: InventoryGRItemImage[]
}

export interface InventoryGRItemImage {
  id: string
  gr_item_id: string
  storage_bucket: string
  storage_path: string
  file_name?: string | null
  mime_type?: string | null
  size_bytes?: number | null
  sort_order?: number | null
  created_at: string
}

export interface InventorySample {
  id: string
  sample_no: string
  status: string
  received_by?: string | null
  received_at?: string | null
  sample_label?: string | null
  testing_by_name?: string | null
  testing_started_by?: string | null
  testing_started_at?: string | null
  supplier_name?: string | null
  note?: string | null
  tested_by?: string | null
  tested_at?: string | null
  approved_by?: string | null
  approved_at?: string | null
  test_result?: string | null
  test_note?: string | null
  rejection_reason?: string | null
  created_at: string
  updated_at: string
  /** joined */
  inv_sample_items?: InventorySampleItem[]
}

export interface InventorySampleItem {
  id: string
  sample_id: string
  product_id?: string | null
  product_name_manual?: string | null
  image_url?: string | null
  qty: number
  note?: string | null
  converted_product_id?: string | null
  item_test_result?: string | null
  item_test_note?: string | null
  created_at: string
  /** joined product */
  pr_products?: Product | null
}

export type AuditStatus = 'draft' | 'in_progress' | 'review' | 'completed' | 'closed'
export type AuditType = 'full' | 'category' | 'location' | 'custom' | 'free_scan'

export interface InventoryAudit {
  id: string
  audit_no: string
  status: AuditStatus
  audit_type?: AuditType | null
  scope_filter?: Record<string, string[]> | null
  assigned_to?: string[] | null
  frozen_at?: string | null
  reviewed_by?: string | null
  reviewed_at?: string | null
  adjustment_id?: string | null
  location_accuracy_percent?: number | null
  safety_stock_accuracy_percent?: number | null
  total_location_mismatches?: number | null
  total_safety_stock_mismatches?: number | null
  created_by?: string | null
  created_at: string
  completed_at?: string | null
  accuracy_percent?: number | null
  total_items?: number | null
  total_variance?: number | null
  note?: string | null
  show_system_qty?: boolean | null
}

export interface InventoryAuditItem {
  id: string
  audit_id: string
  product_id: string
  system_qty: number
  counted_qty: number
  variance: number
  counted_by?: string | null
  counted_at?: string | null
  is_counted?: boolean
  storage_location?: string | null
  product_category?: string | null
  unit_name?: string | null
  system_location?: string | null
  actual_location?: string | null
  location_match?: boolean | null
  system_safety_stock?: number | null
  counted_safety_stock?: number | null
  safety_stock_match?: boolean | null
  created_at: string
  /** Joined product data */
  pr_products?: {
    product_code: string
    product_name: string
    storage_location?: string | null
    product_category?: string | null
    unit_name?: string | null
  }
}

export interface InventoryAuditCountLog {
  id: string
  audit_item_id: string
  log_type: 'count' | 'location' | 'safety_stock'
  counted_qty?: number | null
  actual_location?: string | null
  counted_safety_stock?: number | null
  counted_by?: string | null
  counted_at: string
}

export interface InventoryAdjustment {
  id: string
  adjust_no: string
  status: string
  adjustment_type?: 'audit_adjustment' | 'safety_reclass'
  reason_code?: string | null
  created_by?: string | null
  created_at: string
  approved_by?: string | null
  approved_at?: string | null
  note?: string | null
}

export interface InventoryAdjustmentItem {
  id: string
  adjustment_id: string
  product_id: string
  qty_delta: number
  new_safety_stock?: number | null
  new_order_point?: string | null
  before_on_hand?: number | null
  after_on_hand?: number | null
  before_safety_stock?: number | null
  after_safety_stock?: number | null
  before_total_qty?: number | null
  after_total_qty?: number | null
  estimated_unit_cost?: number | null
  estimated_total_cost_impact?: number | null
  approved_unit_cost?: number | null
  approved_total_cost_impact?: number | null
  created_at: string
}

export interface InventoryReturn {
  id: string
  return_no: string
  ref_bill_no?: string | null
  tracking_number?: string | null
  reason?: string | null
  status: string
  disposition?: string | null
  created_by?: string | null
  created_at: string
  received_by?: string | null
  received_at?: string | null
  note?: string | null
}

  export interface InventoryReturnItem {
  id: string
  return_id: string
  product_id: string
    qty: number
    disposition?: 'return_to_stock' | 'waste' | 'lost' | null
  created_at: string
}

// WMS Return Requisition Types (คืนของ)
export interface WmsReturnRequisition {
  id: string
  return_no: string
  topic?: string | null
  status: string
  created_by?: string | null
  created_at: string
  approved_by?: string | null
  approved_at?: string | null
  note?: string | null
}

export interface WmsReturnRequisitionItem {
  id: string
  return_requisition_id: string
  product_id: string
  qty: number
  created_at: string
}

// Cartoon Pattern Types (รูปลายการ์ตูนดึงจาก Bucket cartoon-patterns ชื่อไฟล์ = pattern_name)
export interface CartoonPattern {
  id: string
  pattern_name: string
  pattern_code?: string
  /** @deprecated ใช้ product_categories แทน */
  product_category?: string | null
  /** หมวดหมู่สินค้าที่ลายนี้ใช้ได้ (รองรับหลายหมวดหมู่) */
  product_categories?: string[] | null
  line_count?: number | null
  /** 0 = ไม่จำกัด; NULL = ไม่ใช้บรรทัดนั้นตาม line_count */
  line_1_max_chars?: number | null
  line_2_max_chars?: number | null
  line_3_max_chars?: number | null
  /** @deprecated ลบคอลัมน์แล้ว รูปดึงจาก bucket cartoon-patterns ตาม pattern_name */
  image_url?: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

/** Override ตั้งค่าฟิลด์ระดับสินค้า — null = ใช้ค่าจากหมวดหมู่, true/false = override */
export interface ProductFieldOverride {
  product_id: string
  ink_color: boolean | null
  layer: boolean | null
  cartoon_pattern: boolean | null
  line_pattern: boolean | null
  font: boolean | null
  line_1: boolean | null
  line_2: boolean | null
  line_3: boolean | null
  quantity: boolean | null
  unit_price: boolean | null
  notes: boolean | null
  attachment: boolean | null
  created_at?: string
  updated_at?: string
}

// QC Types
export interface QCSession {
  id: string
  username: string
  filename: string
  start_time: string
  end_time: string | null
  total_items: number
  pass_count: number
  fail_count: number
  kpi_score: number | null
  created_at: string
}

export interface QCRecord {
  id: string
  session_id: string
  item_uid: string
  qc_by: string
  status: 'pass' | 'fail' | 'pending'
  fail_reason: string | null
  is_rejected: boolean
  retry_count: number
  product_code: string
  product_name: string
  bill_no: string
  ink_color: string | null
  font: string | null
  floor: string | null
  cartoon_name: string | null
  line1: string | null
  line2: string | null
  line3: string | null
  qty: number
  remark: string | null
  reject_duration?: number | null
  workflow_status?: 'pending' | 'passed' | 'waiting_recheck' | 'escalated' | 'closed'
  attempt_started_at?: string | null
  resolved_at?: string | null
  last_result_at?: string | null
  created_at: string
  /** กำหนดส่ง/เวลาที่นับเป็นล่าช้า จากบิล (or_orders) — enrich ตอน fetchRejectItems ใช้แสดงป้าย ส่งด่วน/ล่าช้า */
  ship_due_at?: string | null
  overdue_at?: string | null
}

/** QC session item (in-memory during QC Operation) */
export interface QCItem {
  uid: string
  /** item_uid แถว or_order_items — ใช้รองรับ session/qc_records รูปแบบเก่า */
  source_line_uid?: string
  product_code: string
  product_name: string
  product_category?: string | null
  bill_no: string
  ink_color: string | null
  font: string | null
  floor: string
  cartoon_name: string
  line1: string
  line2: string
  line3: string
  qty: number
  remark: string
  file_attachment?: string | null
  status: 'pass' | 'fail' | 'pending'
  fail_reason?: string | null
  check_time?: Date | null
  /** กำหนดส่ง/เวลาที่นับเป็นล่าช้า จากบิล (or_orders) — ใช้แสดงป้าย ส่งด่วน/ล่าช้า */
  ship_due_at?: string | null
  overdue_at?: string | null
}

export interface SettingsReason {
  id: string
  reason_text: string
  fail_type?: 'Man' | 'Machine' | 'Material' | 'Method' | string
  parent_id?: string | null
  created_at?: string
  children?: SettingsReason[]
}

export interface InkType {
  id: number
  ink_name: string
  hex_code?: string | null
  created_at?: string
}

// QC Checklist Types
export interface QCChecklistTopic {
  id: string
  name: string
  sort_order: number
  created_at: string
  items_count?: number
  products_count?: number
}

export interface QCChecklistItem {
  id: string
  topic_id: string
  title: string
  file_url: string | null
  file_type: 'image' | 'pdf' | null
  sort_order: number
  created_at: string
  topic_name?: string
}

export interface QCChecklistTopicProduct {
  id: string
  topic_id: string
  product_code: string
  product_name: string
  created_at: string
}

/** กรุ๊ปหมวดหมู่สินค้าสำหรับตัวกรองในเมนู QC Operation (ตั้งค่าได้ในแถบ Settings ของ QC) */
export interface QCCategoryGroup {
  id: string
  name: string
  sort_order: number
  created_at: string
  /** หมวดหมู่ที่อยู่ในกรุ๊ปนี้ */
  categories: string[]
}

// Order Review Types (Admin QC)
export interface OrderReview {
  id: string
  order_id: string
  reviewed_by: string
  reviewed_at: string
  status: 'approved' | 'rejected'
  rejection_reason: string | null
  created_at: string
}

// Refund Types
export interface Refund {
  id: string
  order_id: string
  amount: number
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  approved_by: string | null
  approved_at: string | null
  /** เหตุผลไม่อนุมัติ (กรอกตอนกดปฏิเสธ) */
  rejected_reason?: string | null
  created_at: string
  /** บัญชีรับโอนคืน (โอนเกิน) */
  refund_recipient_account_name?: string | null
  refund_recipient_bank?: string | null
  refund_recipient_account_number?: string | null
  /** เหตุผลโอนคืน (กรอกจากออเดอร์) — แสดงใต้บรรทัดยอดบิล/สลิป */
  refund_recipient_reason?: string | null
  /** path สลิปการโอนเงินคืนลูกค้า (หลายรูป) — บัญชีอัปโหลด, Sales เปิดดู */
  refund_slip_paths?: string[] | null
  /** เวลาที่บัญชียืนยันว่าส่งสลิปโอนคืนให้ลูกค้าแล้ว (NULL = ยังไม่ส่ง) */
  refund_slip_sent_at?: string | null
  /** ผู้กดยืนยันว่าส่งสลิปโอนคืนแล้ว */
  refund_slip_sent_by?: string | null
}

// Verified Slip Types
export interface VerifiedSlip {
  id: string
  order_id: string
  slip_image_url: string
  verified_amount: number
  verified_at: string
  created_at: string
}

// Bill Header Settings Types
export interface BillHeaderSetting {
  id: string
  company_key: string
  bill_code: string | null
  company_name: string
  company_name_en: string | null
  address: string
  tax_id: string
  branch: string | null
  phone: string | null
  logo_url: string | null
  created_at: string
  updated_at: string
}

// ── PP (Processed Products) ─────────────────────────────────
export interface PpRecipe {
  id: string
  product_id: string
  created_by: string | null
  created_at: string
  updated_at: string
  min_stock: number | null
  max_stock: number | null
}

export interface QCAttempt {
  id: string
  qc_record_id: string
  session_id: string
  item_uid: string
  attempt_no: number
  attempt_type: 'initial' | 'recheck' | 'special_recheck'
  result: 'pass' | 'fail'
  fail_reason: string | null
  qc_by: string
  started_at: string
  completed_at: string
  duration_seconds: number
  created_at: string
}

export interface PpRecipeInclude {
  id: string
  recipe_id: string
  product_id: string
  qty: number
  created_at: string
  product?: Product
}

export interface PpRecipeRemove {
  id: string
  recipe_id: string
  product_id: string
  qty: number
  unit_cost: number
  created_at: string
  product?: Product
}

export type ProductionOrderStatus = 'open' | 'pending' | 'approved' | 'processing' | 'completed' | 'rejected'

export interface PpProductionOrder {
  id: string
  doc_no: string
  title: string | null
  status: ProductionOrderStatus
  note: string | null
  created_by: string | null
  approved_by: string | null
  approved_at: string | null
  rejected_by: string | null
  rejected_at: string | null
  rejection_reason: string | null
  started_by: string | null
  started_at: string | null
  completed_by: string | null
  completed_at: string | null
  created_at: string
  creator?: { display_name: string }
  approver?: { display_name: string }
  rejector?: { display_name: string }
}

export interface PpProductionOrderItem {
  id: string
  order_id: string
  product_id: string
  qty: number
  unit_cost: number | null
  total_cost: number | null
  created_at: string
  product?: Product
}

// Bank Settings Types
export interface BankSetting {
  id: string
  account_number: string
  bank_code: string
  bank_name: string | null
  account_name: string | null
  is_active: boolean
  bill_header_id: string | null
  created_at: string
  updated_at: string
  channels?: { channel_code: string; channel_name: string }[]
}

// Bank Codes from EasySlip
export const BANK_CODES = [
  { code: '002', name: 'ธนาคารกรุงเทพ', abbreviation: 'BBL' },
  { code: '004', name: 'ธนาคารกสิกรไทย', abbreviation: 'KBANK' },
  { code: '006', name: 'ธนาคารกรุงไทย', abbreviation: 'KTB' },
  { code: '011', name: 'ธนาคารทหารไทยธนชาต', abbreviation: 'TTB' },
  { code: '014', name: 'ธนาคารไทยพาณิชย์', abbreviation: 'SCB' },
  { code: '022', name: 'ธนาคารซีไอเอ็มบีไทย', abbreviation: 'CIMBT' },
  { code: '024', name: 'ธนาคารยูโอบี', abbreviation: 'UOBT' },
  { code: '025', name: 'ธนาคารกรุงศรีอยุธยา', abbreviation: 'BAY' },
  { code: '030', name: 'ธนาคารออมสิน', abbreviation: 'GSB' },
  { code: '033', name: 'ธนาคารอาคารสงเคราะห์', abbreviation: 'GHB' },
  { code: '034', name: 'ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร', abbreviation: 'BAAC' },
  { code: '035', name: 'ธนาคารเพื่อการส่งออกและนำเข้าแห่งประเทศไทย', abbreviation: 'EXIM' },
  { code: '067', name: 'ธนาคารทิสโก้', abbreviation: 'TISCO' },
  { code: '069', name: 'ธนาคารเกียรตินาคินภัทร', abbreviation: 'KKP' },
  { code: '070', name: 'ธนาคารไอซีบีซี (ไทย)', abbreviation: 'ICBCT' },
  { code: '071', name: 'ธนาคารไทยเครดิตเพื่อรายย่อย', abbreviation: 'TCD' },
  { code: '073', name: 'ธนาคารแลนด์ แอนด์ เฮ้าส์', abbreviation: 'LHFG' },
  { code: '098', name: 'ธนาคารพัฒนาวิสาหกิจขนาดกลางและขนาดย่อมแห่งประเทศไทย', abbreviation: 'SME' },
] as const

// ── Roll Material Calculator ────────────────────────────────
export interface RollMaterialCategory {
  id: string
  name: string
  sort_order: number
  created_at: string
}

export interface RollMaterialConfig {
  id: string
  fg_product_id: string
  rm_product_id: string | null
  category_id: string | null
  sheets_per_roll: number | null
  cost_per_sheet: number | null
  created_at: string
  updated_at: string
}

export interface RollCalcDashboardRow {
  config_id: string
  fg_product_id: string
  fg_product_code: string
  fg_product_name: string
  fg_product_category: string | null
  rm_product_id: string | null
  rm_product_code: string
  rm_product_name: string
  rm_count: number
  rm_on_hand: number
  category_id: string | null
  category_name: string | null
  sheets_per_roll: number | null
}

// ─── HR Module Types ────────────────────────────────────────────────────────

export interface HRDepartment {
  id: string
  name: string
  description?: string
  manager_id?: string
  telegram_group_id?: string
  created_at: string
}

export interface HRPosition {
  id: string
  name: string
  department_id?: string
  level: number
  created_at: string
}

export interface HREmployee {
  id: string
  employee_code: string
  citizen_id?: string
  prefix?: string
  first_name: string
  last_name: string
  first_name_en?: string
  last_name_en?: string
  nickname?: string
  birth_date?: string
  gender?: string
  religion?: string
  nationality?: string
  /** ที่อยู่ตามบัตรประชาชน */
  address?: Record<string, string>
  /** ที่อยู่ปัจจุบัน */
  current_address?: Record<string, string>
  phone?: string
  emergency_contact?: { name: string; phone: string; relationship: string }
  emergency_contact_2?: { name: string; phone: string; relationship: string }
  photo_url?: string
  department_id?: string
  position_id?: string
  company_id?: string
  /** ฐานเงินเดือน */
  salary?: number
  /** เงินพิเศษ/ประจำตำแหน่ง */
  position_allowance?: number
  /** รายการหักประจำเดือนสำหรับจัดทำเงินเดือน */
  monthly_personal_tax?: number
  monthly_social_security?: number
  monthly_savings?: number
  /** เพดานยอดเงินสะสมรวม; null/undefined = ไม่จำกัด */
  savings_maximum?: number | null
  monthly_student_loan?: number
  monthly_company_loan?: number
  /** ยอดตั้งต้นก่อนเริ่มใช้ระบบเงินเดือน */
  income_opening_balance?: number
  personal_tax_opening_balance?: number
  social_security_opening_balance?: number
  ewf_opening_balance?: number
  student_loan_opening_balance?: number
  savings_opening_balance?: number
  company_loan_opening_balance?: number
  company_loan_opening_installments?: number
  hire_date?: string
  probation_end_date?: string
  /** วันที่สิ้นสุดสัญญาจ้าง ใช้สำหรับแจ้งเตือนและเรียงลำดับอายุสัญญา */
  contract_end_date?: string | null
  employment_status: 'active' | 'probation' | 'resigned' | 'terminated'
  /** ประเภทสัญญาจ้าง: permanent=ประจำ, daily=รายวัน */
  contract_type?: 'permanent' | 'daily'
  /** รูปแบบการทำงาน: office=ออฟฟิศ, hybrid=ออฟฟิศ+WFH (ต้องขอ), wfh=WFH ประจำ */
  work_mode?: 'office' | 'hybrid' | 'wfh' | 'no_clock'
  /** จุดบันทึกเวลา (hr_clock_locations) ที่พนักงานคนนี้ใช้ */
  clock_location_id?: string
  /** มาตรฐานเวลาทำงาน (hr_work_schedules) ของพนักงานคนนี้ — ว่าง = ใช้ชุดค่าเริ่มต้น */
  work_schedule_id?: string
  user_id?: string
  telegram_chat_id?: string
  documents?: { name: string; url: string; type: string; uploaded_at: string }[]
  card_issue_date?: string
  card_expiry_date?: string
  created_at: string
  updated_at: string
  department?: HRDepartment
  position?: HRPosition
  company?: HRCompany
}

export interface HRCompany {
  id: string
  company_key: string
  name_th: string
  name_en?: string | null
  address?: string | null
  tax_id?: string | null
  branch?: string | null
  phone?: string | null
  logo_url?: string | null
  signatory_name?: string | null
  signatory_title?: string | null
  signature_url?: string | null
  /** เปิด/ปิดการหักกองทุนสงเคราะห์ลูกจ้าง (EWF) ของบริษัท */
  ewf_enabled?: boolean
  sort_order?: number
  is_active: boolean
  created_at?: string
  updated_at?: string
}

export interface HRLeaveType {
  id: string
  name: string
  max_days_per_year?: number
  /** จำนวนวันปฏิทินขั้นต่ำที่พนักงานต้องยื่นคำขอล่วงหน้า */
  advance_notice_days: number
  requires_doc: boolean
  /** ชื่อเอกสารที่ต้องแนบ (ป้ายปุ่มอัปโหลดตอนขอลา) เมื่อ requires_doc = true */
  doc_label?: string
  is_paid: boolean
  created_at: string
}

export interface HRLeaveRequest {
  id: string
  employee_id: string
  leave_type_id: string
  start_date: string
  end_date: string
  total_days: number
  /** เต็มวัน หรือ ลาเป็นชั่วโมง */
  leave_mode?: 'full_day' | 'hourly'
  start_time?: string
  end_time?: string
  total_hours?: number
  reason?: string
  /** ลากิจฉุกเฉิน: อนุญาตให้ข้ามเงื่อนไขแจ้งล่วงหน้า */
  is_emergency?: boolean
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  approved_by?: string
  approved_at?: string
  reject_reason?: string
  /** พนักงานผู้กดยกเลิกใบลา */
  cancelled_by?: string | null
  /** ชื่อบัญชีสำรอง กรณีผู้ยกเลิกไม่ได้ผูกกับข้อมูลพนักงาน */
  cancelled_by_name?: string | null
  cancelled_at?: string | null
  medical_cert_url?: string
  notified_before: boolean
  notified_morning: boolean
  created_at: string
  updated_at: string
  employee?: HREmployee
  leave_type?: HRLeaveType
  /** ผู้อนุมัติ (join จาก approved_by) */
  approver?: { first_name?: string; last_name?: string; nickname?: string } | null
  /** ผู้ยกเลิก (join จาก cancelled_by) */
  canceller?: { first_name?: string; last_name?: string; nickname?: string } | null
}

export interface HRLeaveBalance {
  id: string
  employee_id: string
  leave_type_id: string
  year: number
  entitled_days: number
  used_days: number
  carried_days: number
  leave_type_name?: string
  remaining?: number
}

export interface HRCandidate {
  id: string
  citizen_id?: string
  prefix?: string
  first_name: string
  last_name: string
  first_name_en?: string
  last_name_en?: string
  nickname?: string
  birth_date?: string
  gender?: string
  religion?: string
  address?: Record<string, string>
  photo_url?: string
  phone?: string
  applied_position?: string
  applied_department_id?: string
  portfolio_url?: string
  resume_url?: string
  source?: string
  status: 'new' | 'scheduled' | 'interviewed' | 'passed' | 'failed' | 'hired' | 'withdrawn'
  custom_field_1?: string
  custom_field_2?: string
  custom_field_3?: string
  custom_field_4?: string
  raw_siam_data?: Record<string, string>
  created_at: string
  updated_at: string
}

/** หัวข้อเกณฑ์การให้คะแนนสัมภาษณ์เริ่มต้นของแต่ละตำแหน่ง */
export interface HRInterviewCriteriaTemplate {
  id: string
  position_id: string
  name: string
  max_score: number
  sort_order: number
  is_active: boolean
  created_at: string
}

/** พนักงานที่ตั้งค่าไว้ให้เลือกเป็นผู้สัมภาษณ์ (ตั้งค่าโดย superadmin) */
export interface HRInterviewer {
  id: string
  employee_id: string
  sort_order: number
  is_active: boolean
  created_at: string
  employee?: Pick<HREmployee, 'id' | 'employee_code' | 'first_name' | 'last_name' | 'nickname'>
}

export interface HRInterview {
  id: string
  candidate_id: string
  interview_date: string
  location?: string
  interviewer_ids: string[]
  status:
    | 'waiting_contact'
    | 'scheduled'
    | 'attended'
    | 'rescheduled'
    | 'no_show'
    | 'completed'
    | 'cancelled'
  notes?: string
  created_at: string
  candidate?: HRCandidate
}

export interface HRInterviewScore {
  id: string
  interview_id: string
  interviewer_id: string
  criteria: { name: string; max_score: number; score: number; note?: string }[]
  total_score: number
  max_possible: number
  recommendation: 'hire' | 'maybe' | 'reject'
  comments?: string
  created_at: string
}

// ─── HR Time Clock (บันทึกเวลาเข้า-ออกงานด้วย GPS + กล้อง) ───────────────────

export interface HRClockLocation {
  id: string
  name: string
  lat: number
  lng: number
  radius_m: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export type HRTimeEntryType = 'clock_in' | 'clock_out' | 'ot_in' | 'ot_out'

export interface HRTimeEntry {
  id: string
  employee_id: string
  entry_type: HRTimeEntryType
  work_date: string
  entry_time: string
  lat?: number
  lng?: number
  accuracy_m?: number
  distance_m?: number
  location_id?: string
  location_name?: string
  photo_url?: string
  photo_expired_at?: string
  note?: string
  /** แหล่งที่มา: mobile=แอปมือถือ, device=เครื่องสแกนนิ้ว (นำเข้า), manual=HR กรอกเอง */
  source?: 'mobile' | 'device' | 'manual'
  work_location_type?: 'office' | 'wfh_approved' | 'wfh_permanent'
  wfh_request_id?: string
  created_at: string
  employee?: HREmployee
}

export interface HREmployeeOpeningBalance {
  id: string
  employee_id: string
  leave_type_id: string
  year: number
  effective_date: string
  opening_remaining_days: number
  note?: string
  updated_at?: string
}

export interface HREmployeeOpeningAttendance {
  id: string
  employee_id: string
  year: number
  effective_date: string
  absence_days: number
  late_count: number
  late_minutes: number
  early_leave_count: number
  early_leave_minutes: number
  note?: string
  updated_at?: string
}

export interface HRPortalVisibleTimeEntry {
  id: string
  employee_id: string
  employee_code: string
  employee_name: string
  nickname?: string | null
  department_id?: string | null
  department_name?: string | null
  entry_type: HRTimeEntryType
  work_date: string
  entry_time: string
}

export interface HRWFHRequest {
  id: string
  employee_id: string
  start_date: string
  end_date: string
  /** ช่วงเวลาทำงานที่ขอ WFH (HH:mm:ss) — null = ใช้ตารางเวลามาตรฐาน (คำขอเก่าก่อน migration 334) */
  start_time?: string | null
  end_time?: string | null
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  approved_by?: string
  approved_at?: string
  reject_reason?: string
  created_at: string
  updated_at: string
  employee?: HREmployee
  approver?: { first_name?: string; last_name?: string; nickname?: string } | null
}

export interface HROTRequest {
  id: string
  employee_id: string
  request_date: string
  ot_start: string
  ot_end: string
  hours?: number
  reason?: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  approved_by?: string
  approved_at?: string
  reject_reason?: string
  created_at: string
  updated_at: string
  employee?: HREmployee
  /** ผู้อนุมัติ (join จาก approved_by) */
  approver?: { first_name?: string; last_name?: string; nickname?: string } | null
}

/** มาตรฐานเวลาทำงาน (หลายชุด ตั้งชื่อได้ กำหนดต่อพนักงานผ่าน hr_employees.work_schedule_id) */
export interface HRWorkSchedule {
  id: string
  name: string
  work_start: string
  work_end: string
  lunch_start: string
  lunch_end: string
  late_grace_min: number
  /** วันทำงานต่อสัปดาห์ (ISO: 1=จันทร์ ... 7=อาทิตย์) คั่นด้วย comma */
  work_days: string
  /** ชุดค่าเริ่มต้นสำหรับพนักงานที่ยังไม่ได้กำหนด (มีได้ชุดเดียว) */
  is_default: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export type HRWorkCalendarDayType = 'work' | 'weekly_off'
export type HRWorkCalendarSource = 'manual' | 'pattern' | 'swap' | 'import'

export interface HREmployeeWorkCalendar {
  id: string
  employee_id: string
  work_date: string
  day_type: HRWorkCalendarDayType
  work_schedule_id?: string
  work_start?: string
  work_end?: string
  source: HRWorkCalendarSource
  note?: string
  created_by?: string
  updated_by?: string
  created_at: string
  updated_at: string
}

export interface HRCompanyHoliday {
  id: string
  holiday_date: string
  name: string
  is_paid: boolean
  note?: string
  created_by?: string
  created_at: string
  updated_at: string
}

export interface HRContractTemplate {
  id: string
  name: string
  description?: string
  template_content: string
  placeholders: { key: string; label: string; source?: string }[]
  is_active: boolean
  version: number
  created_at: string
  updated_at: string
}

export interface HRContract {
  id: string
  employee_id: string
  template_id?: string
  contract_number?: string
  content: string
  start_date?: string
  end_date?: string
  salary?: number
  position?: string
  status: 'draft' | 'active' | 'expired' | 'terminated'
  pdf_url?: string
  signed_at?: string
  created_at: string
  updated_at: string
  employee?: HREmployee
}

export interface HRDocumentCategory {
  id: string
  name: string
  parent_id?: string
  sort_order: number
  created_at: string
}

// ─── ประกาศ (Announcements) ─────────────────────────────────────────────────

export interface HRAnnouncementCategory {
  id: string
  name: string
  description?: string
  sort_order: number
  is_active: boolean
  created_at: string
}

/** สถานะประกาศ: รออนุมัติ → เผยแพร่ (อนุมัติครบทุกคน) หรือ ไม่อนุมัติ */
export type HRAnnouncementStatus = 'pending' | 'published' | 'rejected'

export interface HRAnnouncementApproval {
  id: string
  announcement_id: string
  employee_id: string
  status: 'pending' | 'approved' | 'rejected'
  note?: string | null
  acted_at?: string | null
  created_at: string
  employee?: Pick<HREmployee, 'id' | 'first_name' | 'last_name' | 'nickname'>
}

export interface HRAnnouncement {
  id: string
  category_id?: string | null
  title: string
  content: string
  attachment_urls: string[]
  is_pinned: boolean
  target_all_departments: boolean
  status: HRAnnouncementStatus
  created_by?: string | null
  created_by_user?: string | null
  published_at?: string | null
  reject_reason?: string | null
  created_at: string
  updated_at: string
  category?: Pick<HRAnnouncementCategory, 'name'> | null
  creator?: Pick<HREmployee, 'first_name' | 'last_name' | 'nickname'> | null
  approvals?: HRAnnouncementApproval[]
  departments?: { department_id: string; department?: { name: string } }[]
}

export interface HRAnnouncementApprover {
  id: string
  employee_id: string
  sort_order: number
  is_active: boolean
  created_at: string
  employee?: Pick<HREmployee, 'id' | 'first_name' | 'last_name' | 'nickname'>
}

/** สถานะการรับทราบรายคน (RPC get_announcement_ack_status) */
export interface HRAnnouncementAckStatus {
  employee_id: string
  employee_name: string
  department_name: string | null
  position_name: string | null
  acknowledged: boolean
  acknowledged_at: string | null
}

/** สรุปจำนวนการรับทราบต่อประกาศ — ใช้แสดงคอลัมน์ "รับทราบ" (รับทราบ/เป้าหมาย) */
export interface HRAnnouncementAckSummary {
  announcement_id: string
  target_count: number
  acked_count: number
}

export interface HRDocument {
  id: string
  category_id?: string
  title: string
  description?: string
  file_url?: string
  content?: string
  department_id?: string
  level?: string
  version: string
  is_active: boolean
  requires_acknowledgment: boolean
  created_at: string
  updated_at: string
  category?: HRDocumentCategory
}

export interface HRExam {
  id: string
  title: string
  description?: string
  department_id?: string
  level?: string
  passing_score: number
  time_limit_minutes?: number
  questions: { question: string; options: string[]; correct_answer: number; score: number }[]
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface HRExamResult {
  id: string
  exam_id: string
  employee_id: string
  answers: { question_idx: number; answer: number; is_correct: boolean }[]
  score: number
  max_score: number
  percentage: number
  passed: boolean
  started_at?: string
  completed_at?: string
  created_at: string
}

export interface HROnboardingTemplate {
  id: string
  department_id?: string
  position_id?: string
  name: string
  phases: {
    name: string
    day_start: number
    day_end: number
    tasks: {
      title: string
      description?: string
      type: 'learn' | 'read_doc' | 'exam' | 'evaluate'
      doc_id?: string
      exam_id?: string
      evaluator_role?: string
      deadline_day: number
      passing_score?: number
    }[]
  }[]
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface HROnboardingPlan {
  id: string
  employee_id: string
  template_id?: string
  mentor_id?: string
  supervisor_id?: string
  manager_id?: string
  start_date: string
  expected_end_date?: string
  status: 'in_progress' | 'completed' | 'failed' | 'extended'
  created_at: string
  updated_at: string
  employee?: HREmployee
  mentor?: HREmployee
  supervisor?: HREmployee
  manager?: HREmployee
}

export interface HROnboardingProgress {
  id: string
  plan_id: string
  phase_index: number
  task_index: number
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  score?: number
  evaluated_by?: string
  evaluated_at?: string
  note?: string
  due_date?: string
  completed_at?: string
  created_at: string
}

export interface HRCareerTrack {
  id: string
  name: string
  department_id?: string
  description?: string
  created_at: string
}

export interface HRCareerLevel {
  id: string
  track_id: string
  position_id?: string
  level_order: number
  title: string
  salary_min: number
  salary_max: number
  salary_step?: number
  requirements: { item: string; description: string }[]
  created_at: string
}

export interface HREmployeeCareer {
  id: string
  employee_id: string
  track_id: string
  current_level_id: string
  current_salary?: number
  effective_date: string
  created_at: string
}

export interface HRSalaryHistory {
  id: string
  employee_id: string
  /** ฐานเงินเดือน */
  salary: number
  /** ประเภทค่าจ้าง ณ วันที่มีผล */
  pay_type: 'permanent' | 'daily'
  /** เงินพิเศษ/ประจำตำแหน่ง */
  position_allowance?: number
  effective_date: string
  note?: string
  created_at: string
}

export interface HRCareerHistory {
  id: string
  employee_id: string
  from_level_id?: string
  to_level_id: string
  from_salary?: number
  to_salary?: number
  effective_date: string
  reason?: string
  approved_by?: string
  created_at: string
}

export interface HRNotification {
  id: string
  employee_id: string
  type: string
  title: string
  message?: string
  link?: string
  is_read: boolean
  related_id?: string
  created_at: string
}

export interface HRNotificationSettings {
  id: string
  bot_token: string
  hr_group_chat_id?: string
  manager_group_chat_id?: string
  ticket_group_chat_id?: string
  leave_notify_before_days: number
  leave_notify_morning_time: string
  created_at: string
  updated_at: string
}

export type HRTaskStatus = 'draft' | 'new' | 'acknowledged' | 'in_progress' | 'review' | 'revision' | 'completed' | 'paused' | 'cancelled'
export type HRTaskParticipantRole = 'assignee' | 'supervisor' | 'coordinator' | 'advisor'

export interface HRTaskCategory {
  id: string
  name: string
  color: string
  description?: string
  default_due_days?: number
  /** ลำดับการแสดงผล — ข้อมูลก่อน migration 318 อาจไม่มีค่านี้ */
  sort_order?: number
  is_active: boolean
}

export interface HRTaskParticipant {
  id: string
  task_id: string
  employee_id: string
  role: HRTaskParticipantRole
  is_primary: boolean
  work_status?: 'pending' | 'in_progress' | 'completed'
  acknowledged_at?: string
  started_at?: string
  completed_at?: string
  submission_note?: string
  submission_link?: string
  employee?: HREmployee
}

export interface HRTaskChecklistItem {
  id: string
  task_id: string
  title: string
  description?: string
  assignee_id?: string
  due_at?: string
  is_completed: boolean
  completed_at?: string
  sort_order: number
}

export interface HRTask {
  id: string
  task_no: string
  title: string
  description?: string
  category_id?: string
  team_id?: string
  priority: 'normal' | 'high' | 'urgent'
  status: HRTaskStatus
  progress: number
  start_date?: string
  acknowledged_at?: string
  started_at?: string
  due_at?: string
  submitted_at?: string
  /** เวลาส่งงานครั้งแรก ใช้วัด SLA กำหนดส่งโดยไม่ถูกการส่งแก้ไขทับ */
  first_submitted_at?: string
  completed_at?: string
  completion_note?: string
  completion_link?: string
  created_by: string
  created_at: string
  updated_at: string
  category?: HRTaskCategory
  creator?: HREmployee
  participants?: HRTaskParticipant[]
  checklist?: HRTaskChecklistItem[]
  evaluations?: HRTaskEvaluation[]
}

export interface HRTaskEvent {
  id: string
  task_id: string
  event_type: string
  from_status?: HRTaskStatus
  to_status?: HRTaskStatus
  actor_id?: string
  event_at: string
  details: Record<string, unknown>
  actor?: Pick<HREmployee, 'id' | 'employee_code' | 'first_name' | 'last_name' | 'nickname'>
}

export interface HRTaskEvaluation {
  id: string
  task_id: string
  employee_id: string
  evaluator_id: string
  speed: number
  responsibility: number
  quality: number
  communication: number
  /** การแก้ปัญหา/ความคิดริเริ่ม — ผลประเมินเก่าอาจไม่มีค่านี้ */
  problem_solving?: number
  /** การทำงานเป็นทีม — ผลประเมินเก่าอาจไม่มีค่านี้ */
  teamwork?: number
  comment?: string
  visibility: 'manager_only' | 'employee_visible'
}

export interface HRWarning {
  id: string
  warning_number?: string | null
  case_number?: string | null
  employee_id: string
  warning_level: 'verbal' | 'verbal_2' | 'written_1' | 'written_2' | 'final' | 'termination_review'
  recommended_level?: HRWarning['warning_level'] | null
  level_override_reason?: string | null
  recommendation_basis?: Record<string, unknown>[]
  offense_type_id?: string | null
  corrective_action?: string | null
  reference_warning_id?: string
  subject: string
  description?: string
  incident_date: string
  issued_date: string
  issued_by?: string
  witness_id?: string
  employee_response?: string
  status: 'draft' | 'pending_review' | 'changes_requested' | 'pending_approval' | 'approved' | 'pending_acknowledgement' | 'acknowledged' | 'acknowledgement_refused' | 'termination_review' | 'closed' | 'cancelled' | 'issued' | 'appealed' | 'resolved'
  acknowledged_at?: string
  resolution_note?: string
  resolved_at?: string
  attachment_urls: string[]
  created_at: string
  updated_at: string
  reviewer_id?: string | null
  approver_id?: string | null
  reviewed_at?: string | null
  approved_at?: string | null
  effective_until?: string | null
  created_by_user?: string | null
  employee?: HREmployee
  issuer?: HREmployee
  witness?: HREmployee
  reviewer?: HREmployee
  approver?: HREmployee
  offense_type?: HRWarningOffenseType
  policy_links?: { policy_id: string; policy?: HRWarningPolicy }[]
  approvals?: HRWarningApproval[]
  responses?: HRWarningResponse[]
  acknowledgements?: HRWarningAcknowledgement[]
  decisions?: HRWarningDecision[]
  audit_logs?: HRWarningAuditLog[]
}

export interface HRWarningOffenseType { id:string; code:string; name:string; lookback_days?:number|null; is_active:boolean }
export interface HRWarningPolicy { id:string; code?:string|null; title:string; description?:string|null; source_document_id?:string|null; is_active:boolean }
export interface HRWarningApproval { id:string; warning_id:string; step:'review'|'approval'; actor_id?:string|null; action:'submitted'|'approved'|'returned'|'cancelled'; note?:string|null; acted_at:string; actor?:HREmployee }
export interface HRWarningResponse { id:string; warning_id:string; response_text:string; recorded_by?:string|null; attachment_urls:string[]; created_at:string }
export interface HRWarningAcknowledgement { id:string; warning_id:string; outcome:'acknowledged'|'refused'; method:string; handled_by?:string|null; witness_id?:string|null; note?:string|null; acknowledged_at:string; witness?:HREmployee }
export interface HRWarningDecision { id:string; warning_id:string; outcome:'terminated'|'continued_employment'|'other_discipline'|'cancelled'|'other'; reason?:string|null; conditions?:string|null; approved_by?:string|null; effective_date?:string|null; created_at:string; approver?:HREmployee }
export interface HRWarningAuditLog { id:number; warning_id:string; actor_user_id?:string|null; actor_employee_id?:string|null; actor?:HREmployee; action:string; old_data?:Record<string,unknown>|null; new_data?:Record<string,unknown>|null; reason?:string|null; created_at:string }

export interface HRCertificate {
  id: string
  certificate_number: string
  employee_id: string
  training_name: string
  training_type: 'internal' | 'external'
  description?: string
  trainer?: string
  training_start_date: string
  training_end_date?: string
  training_hours?: number
  score?: number
  pass_status: 'passed' | 'failed' | 'pending'
  certificate_date?: string
  expiry_date?: string
  issued_by?: string
  status: 'draft' | 'issued'
  acknowledged_at?: string
  attachment_urls: string[]
  created_at: string
  updated_at: string
  employee?: HREmployee
  issuer?: HREmployee
}

export interface HRAsset {
  id: string
  asset_code?: string
  name: string
  category?: string
  /** ประเภทย่อย เช่น Notebook, Printer, Monitor */
  sub_type?: string
  serial_number?: string
  vendor_name?: string
  description?: string
  department_id?: string
  location?: string
  purchase_date?: string
  /** วันที่รับเข้า */
  received_date?: string
  /** มีการรับประกันหรือไม่ — false = วันหมดประกันเท่ากับวันที่ซื้อ */
  has_warranty?: boolean
  /** ระยะเวลารับประกัน (จำนวน) ใช้คู่กับ warranty_unit */
  warranty_period?: number | null
  warranty_unit?: 'day' | 'year' | null
  /** วันหมดประกัน — คำนวณจากวันที่ซื้อ + ระยะประกัน */
  warranty_expire_date?: string
  purchase_cost?: number
  /** อายุการใช้งาน (ปี) — ใช้คำนวณค่าเสื่อม/ปี */
  useful_life_years?: number
  /** ค่าเสื่อมราคาต่อปี = มูลค่าตอนซื้อ ÷ อายุการใช้งาน */
  depreciation_per_year?: number
  /** มูลค่าปัจจุบัน = มูลค่าตอนซื้อ − (ค่าเสื่อม/ปี × ปีที่ใช้งานไปแล้ว) ไม่ต่ำกว่า 0 */
  current_value?: number
  status: 'active' | 'borrowed' | 'maintenance' | 'retired' | 'disposed' | 'lost'
  assigned_employee_id?: string
  images: string[]
  /** ไฟล์เอกสารแนบ (PDF) — path อยู่ใน bucket hr-assets */
  documents?: { name: string; path: string; uploaded_at?: string }[]
  notes?: string
  created_at: string
  updated_at: string
  department?: HRDepartment
  assigned_employee?: HREmployee
}

/** ประวัติการเปลี่ยนแปลงทรัพย์สิน (บันทึกอัตโนมัติผ่าน trigger) */
export interface HRAssetLog {
  id: string
  asset_id: string | null
  asset_code: string | null
  asset_name: string | null
  /** 'created' = สร้างใหม่, 'updated' = แก้ไขฟิลด์ */
  action: 'created' | 'updated'
  /** ชื่อคอลัมน์ที่เปลี่ยน (null เมื่อ action = created) */
  field: string | null
  field_label: string | null
  old_value: string | null
  new_value: string | null
  changed_by: string | null
  changed_by_name: string | null
  created_at: string
}

// ─── คะแนนการปฏิบัติงาน (Work Score) ────────────────────────────────────────
// หมายเหตุ: HRScoreCategory / HRScoreRule / AttendanceFact อยู่ใน lib/workScore.ts
// (ที่เดียวกับตรรกะการคิดคะแนน) — ที่นี่เก็บเฉพาะ row ที่ UI ใช้ตรง ๆ

/** ใบรับรองเวลาเข้า-ออกโดยหัวหน้า (ใช้แทนบันทึกที่หายไป ไม่แก้ hr_time_entries) */
export interface HRTimeCertification {
  id: string
  employee_id: string
  work_date: string
  entry_type: 'clock_in' | 'clock_out'
  certified_time: string
  reason: string
  certified_by?: string | null
  certified_at: string
  created_at: string
  updated_at: string
  employee?: HREmployee
  certifier?: { first_name?: string; last_name?: string; nickname?: string } | null
}

/** เหตุการณ์คะแนนที่บันทึกลง ledger แล้ว (ตอนปิดรอบ หรือ HR เพิ่มเอง) */
export interface HRScoreEvent {
  id: string
  employee_id: string
  event_date: string
  category_id: string
  rule_id?: string | null
  event_code: string
  points: number
  source: 'auto' | 'manual'
  ref_table?: string | null
  ref_id?: string | null
  detail: Record<string, unknown>
  note?: string | null
  created_by?: string | null
  created_at: string
  employee?: HREmployee
}

/** สรุปคะแนนรายเดือนต่อคนต่อหมวด */
export interface HRScorePeriod {
  id: string
  employee_id: string
  /** วันที่ 1 ของเดือน */
  period: string
  category_id: string
  base_points: number
  /** ยอดหักจริงก่อนชนพื้น (ค่าบวก) */
  raw_deduction: number
  total_points: number
  status: 'open' | 'locked'
  locked_at?: string | null
  locked_by?: string | null
  note?: string | null
  created_at: string
  updated_at: string
  employee?: HREmployee
}

/**
 * คำทักท้วงคะแนนของพนักงาน
 * ผูกกับ (employee_id + event_date + event_code) ไม่ใช่แถวใน hr_score_events
 * เพื่อให้ทักท้วงคะแนนที่ยังคำนวณสดอยู่ได้ โดยไม่ต้องรอ HR บันทึกลง ledger ก่อน
 */
export interface HRScoreAppeal {
  id: string
  /** มีค่าเฉพาะเมื่อตอนยื่นมีแถวใน ledger อยู่แล้ว */
  score_event_id?: string | null
  employee_id: string
  event_date: string
  event_code: string
  /** คะแนนที่ถูกหัก ณ ตอนยื่น (ค่าติดลบ) */
  points: number
  category_id: string
  reason: string
  status: 'pending' | 'accepted' | 'rejected'
  reviewed_by?: string | null
  reviewed_at?: string | null
  decision_note?: string | null
  created_at: string
  updated_at: string
  employee?: HREmployee
  event?: HRScoreEvent
}

/** ค่ากลางของรอบคะแนน (แถวเดียว) */
export interface HRScoreSettings {
  id: string
  /** ปิดรอบของเดือนก่อนหน้า เมื่อถึงวันที่นี้ของเดือนถัดไป */
  lock_day_of_month: number
  auto_lock: boolean
  /** พนักงานทักท้วงได้ภายในกี่วันนับจากวันเกิดเหตุ */
  appeal_days: number
  /** หัวหน้ารับรองเวลาย้อนหลังได้ไม่เกินกี่วัน */
  certify_back_days: number
  updated_at: string
}
