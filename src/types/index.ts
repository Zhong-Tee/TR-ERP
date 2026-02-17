// User and Auth Types
export interface User {
  id: string
  email: string
  username?: string
  role: UserRole
  created_at?: string
}

export type UserRole = 
  | 'superadmin' 
  | 'admin'
  | 'admin-tr' 
  | 'admin_qc' 
  | 'admin-pump' 
  | 'qc_staff' 
  | 'packing_staff' 
  | 'account' 
  | 'store'
  | 'production'
  | 'production_mb'
  | 'manager'
  | 'picker'
  | 'auditor'

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
  | 'ออกแบบแล้ว'
  | 'รอคอนเฟิร์ม'
  | 'คอนเฟิร์มแล้ว'
  | 'เสร็จสิ้น'
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
  entry_date: string
  work_order_name: string | null
  shipped_by: string | null
  shipped_time: string | null
  tracking_number: string | null
  claim_type: string | null
  claim_details: string | null
  confirm_note?: string | null
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
  order_items?: OrderItem[]
}

export interface OrderItem {
  id: string
  order_id: string
  item_uid: string
  product_id: string
  product_name: string
  quantity: number
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
  created_at: string
}

export interface OrderChatLog {
  id: string
  order_id: string
  bill_no: string
  sender_id: string
  sender_name: string
  message: string
  created_at: string
}

export interface IssueType {
  id: string
  name: string
  color: string
  is_active: boolean
  created_at: string
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
}

// Product Type: FG = Finished Goods, RM = Raw Material
export type ProductType = 'FG' | 'RM'

// Product Types (รูปสินค้าดึงจาก Bucket product-images ชื่อไฟล์ = product_code)
export interface Product {
  id: string
  product_code: string
  product_name: string
  seller_name: string | null
  product_name_cn: string | null
  order_point: string | null
  product_category: string | null
  product_type: ProductType
  rubber_code: string | null
  storage_location: string | null
  unit_cost: number | null
  safety_stock: number | null
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
  note?: string | null
  created_at: string
  updated_at: string
  /** joined */
  inv_po_items?: InventoryPOItem[]
  inv_pr?: { pr_no: string } | null
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
  inv_po?: { po_no: string } | null
}

export interface InventoryGRItem {
  id: string
  gr_id: string
  product_id: string
  qty_received: number
  qty_ordered?: number | null
  qty_shortage?: number | null
  shortage_note?: string | null
  created_at: string
  /** joined product */
  pr_products?: Product | null
}

export interface InventorySample {
  id: string
  sample_no: string
  status: string
  received_by?: string | null
  received_at?: string | null
  supplier_name?: string | null
  note?: string | null
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
  qty: number
  note?: string | null
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
  created_at: string
}

export interface InventoryReturn {
  id: string
  return_no: string
  ref_bill_no?: string | null
  reason?: string | null
  status: string
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
  created_at: string
}

/** QC session item (in-memory during QC Operation) */
export interface QCItem {
  uid: string
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
  status: 'pass' | 'fail' | 'pending'
  fail_reason?: string | null
  check_time?: Date | null
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
  created_at: string
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

// Bank Settings Types
export interface BankSetting {
  id: string
  account_number: string
  bank_code: string
  bank_name: string | null
  account_name: string | null
  is_active: boolean
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
