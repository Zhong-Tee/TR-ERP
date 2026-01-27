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
  | 'admin_qc' 
  | 'order_staff' 
  | 'qc_staff' 
  | 'packing_staff' 
  | 'account_staff' 
  | 'viewer'

// Order Types
export type OrderStatus = 
  | 'รอลงข้อมูล'
  | 'ตรวจสลิป'
  | 'รอตรวจคำสั่งซื้อ'
  | 'ลงข้อมูลเสร็จสิ้น'
  | 'ลงข้อมูลผิด'
  | 'ตรวจสอบไม่ผ่าน'
  | 'ตรวจสอบไม่สำเร็จ'
  | 'ตรวจสอบแล้ว'
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
  admin_user: string
  entry_date: string
  work_order_name: string | null
  shipped_by: string | null
  shipped_time: string | null
  tracking_number: string | null
  claim_type: string | null
  claim_details: string | null
  billing_details: BillingDetails | null
  packing_meta: PackingMeta | null
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
  notes: string | null
  file_attachment: string | null
  packing_status: string | null
  created_at: string
}

export interface BillingDetails {
  request_tax_invoice: boolean
  request_cash_bill: boolean
  tax_customer_name: string | null
  tax_customer_address: string | null
  tax_id: string | null
  tax_items: TaxItem[]
}

export interface TaxItem {
  product_name: string
  quantity: number
  unit_price: number
}

export interface PackingMeta {
  parcelScanned: boolean
  scanTime?: string
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

// Product Types
export interface Product {
  id: string
  product_code: string
  product_name: string
  product_category: string | null
  product_type: string | null
  rubber_code: string | null
  storage_location: string | null
  image_url: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

// Cartoon Pattern Types
export interface CartoonPattern {
  id: string
  pattern_name: string
  pattern_code: string
  image_url: string | null
  is_active: boolean
  created_at: string
  updated_at: string
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
