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
  product_category: string | null
  product_type: ProductType
  rubber_code: string | null
  storage_location: string | null
  unit_cost: number | null
  landed_cost: number | null
  safety_stock: number | null
  unit_name: string | null
  unit_multiplier: number | null
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
  tested_by?: string | null
  tested_at?: string | null
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
  file_attachment?: string | null
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

export type ProductionOrderStatus = 'open' | 'pending' | 'approved' | 'rejected'

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
  rm_product_id: string
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
  rm_product_id: string
  rm_product_code: string
  rm_product_name: string
  rm_on_hand: number
  category_id: string | null
  category_name: string | null
  sheets_per_roll: number | null
  cost_per_sheet: number | null
  calc_sheets_per_roll: number | null
  calc_cost_per_sheet: number | null
  calc_period_start: string | null
  calc_period_end: string | null
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
  address?: Record<string, string>
  current_address?: Record<string, string>
  phone?: string
  emergency_contact?: { name: string; phone: string; relationship: string }
  photo_url?: string
  department_id?: string
  position_id?: string
  salary?: number
  hire_date?: string
  probation_end_date?: string
  employment_status: 'active' | 'probation' | 'resigned' | 'terminated'
  fingerprint_id_old?: string
  fingerprint_id_new?: string
  user_id?: string
  telegram_chat_id?: string
  documents?: { name: string; url: string; type: string; uploaded_at: string }[]
  card_issue_date?: string
  card_expiry_date?: string
  created_at: string
  updated_at: string
  department?: HRDepartment
  position?: HRPosition
}

export interface HRLeaveType {
  id: string
  name: string
  max_days_per_year?: number
  requires_doc: boolean
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
  reason?: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  approved_by?: string
  approved_at?: string
  reject_reason?: string
  medical_cert_url?: string
  notified_before: boolean
  notified_morning: boolean
  created_at: string
  updated_at: string
  employee?: HREmployee
  leave_type?: HRLeaveType
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
  birth_date?: string
  gender?: string
  religion?: string
  address?: Record<string, string>
  photo_url?: string
  phone?: string
  applied_position?: string
  applied_department_id?: string
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

export interface HRInterview {
  id: string
  candidate_id: string
  interview_date: string
  location?: string
  interviewer_ids: string[]
  status: 'scheduled' | 'completed' | 'cancelled' | 'no_show'
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

export interface HRAttendanceUpload {
  id: string
  source: 'new_building' | 'old_building'
  period_start: string
  period_end: string
  file_url?: string
  uploaded_by?: string
  row_count?: number
  created_at: string
}

export interface HRAttendanceSummary {
  id: string
  upload_id: string
  employee_id?: string
  fingerprint_id?: string
  employee_name?: string
  department?: string
  source: string
  period_start: string
  period_end: string
  scheduled_hours?: number
  actual_hours?: number
  overtime_hours: number
  late_count: number
  late_minutes: number
  early_leave_count: number
  early_leave_minutes: number
  absent_days: number
  leave_days: number
  work_days_required: number
  work_days_actual: number
  raw_data?: Record<string, unknown>
  created_at: string
}

export interface HRAttendanceDaily {
  id: string
  upload_id: string
  employee_id?: string
  fingerprint_id?: string
  employee_name?: string
  source: string
  work_date: string
  shift_code?: string
  clock_in?: string
  clock_out?: string
  clock_in_2?: string
  clock_out_2?: string
  late_minutes: number
  early_minutes: number
  is_absent: boolean
  is_holiday: boolean
  note?: string
  created_at: string
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
  leave_notify_before_days: number
  leave_notify_morning_time: string
  created_at: string
  updated_at: string
}

export interface HRWarning {
  id: string
  warning_number: string
  employee_id: string
  warning_level: 'verbal' | 'written_1' | 'written_2' | 'final'
  subject: string
  description?: string
  incident_date: string
  issued_date: string
  issued_by?: string
  witness_id?: string
  employee_response?: string
  status: 'draft' | 'issued' | 'acknowledged' | 'appealed' | 'resolved'
  resolution_note?: string
  resolved_at?: string
  attachment_urls: string[]
  created_at: string
  updated_at: string
  employee?: HREmployee
  issuer?: HREmployee
  witness?: HREmployee
}

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
  attachment_urls: string[]
  created_at: string
  updated_at: string
  employee?: HREmployee
  issuer?: HREmployee
}
