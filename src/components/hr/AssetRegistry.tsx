import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { FiChevronLeft, FiChevronRight, FiDownload, FiEdit2, FiPlus, FiSearch, FiTrash2, FiUpload, FiX } from 'react-icons/fi'
import * as XLSX from 'xlsx'
import {
  deleteAsset,
  fetchAssets,
  fetchDepartments,
  fetchEmployees,
  getHRFileUrl,
  peekNextAssetCode,
  removeHRFiles,
  uploadHRFile,
  upsertAsset,
} from '../../lib/hrApi'
import { createStoragePath } from '../../lib/storagePath'
import type { HRAsset, HRDepartment, HREmployee } from '../../types'
import Modal from '../ui/Modal'

const BUCKET = 'hr-assets'

type AssetFormState = {
  id?: string
  asset_code: string
  name: string
  category: string
  sub_type: string
  serial_number: string
  vendor_name: string
  description: string
  department_id: string
  location: string
  purchase_date: string
  received_date: string
  has_warranty: boolean
  warranty_period: string
  warranty_unit: 'day' | 'year'
  warranty_expire_date: string
  purchase_cost: string
  useful_life_years: string
  depreciation_per_year: string
  current_value: string
  status: HRAsset['status']
  assigned_employee_id: string
  images: string[]
  documents: AssetDoc[]
  notes: string
}

type AssetDoc = { name: string; path: string; uploaded_at?: string }

const EMPTY_FORM: AssetFormState = {
  asset_code: '',
  name: '',
  category: '',
  sub_type: '',
  serial_number: '',
  vendor_name: '',
  description: '',
  department_id: '',
  location: '',
  purchase_date: '',
  received_date: '',
  has_warranty: false,
  warranty_period: '',
  warranty_unit: 'year',
  warranty_expire_date: '',
  purchase_cost: '',
  useful_life_years: '',
  depreciation_per_year: '',
  current_value: '',
  status: 'active',
  assigned_employee_id: '',
  images: [],
  documents: [],
  notes: '',
}

const STATUS_META: Record<HRAsset['status'], { label: string; chip: string; card: string; num: string; ring: string }> = {
  active: { label: 'ใช้งาน', chip: 'bg-emerald-100 text-emerald-700', card: 'border-emerald-200 bg-emerald-50', num: 'text-emerald-800', ring: 'ring-emerald-400' },
  borrowed: { label: 'ยืมใช้งาน', chip: 'bg-blue-100 text-blue-700', card: 'border-blue-200 bg-blue-50', num: 'text-blue-800', ring: 'ring-blue-400' },
  maintenance: { label: 'ซ่อมบำรุง', chip: 'bg-amber-100 text-amber-700', card: 'border-amber-200 bg-amber-50', num: 'text-amber-800', ring: 'ring-amber-400' },
  retired: { label: 'ปลดระวาง', chip: 'bg-gray-100 text-gray-700', card: 'border-gray-200 bg-gray-50', num: 'text-gray-700', ring: 'ring-gray-400' },
  disposed: { label: 'จำหน่ายแล้ว', chip: 'bg-purple-100 text-purple-700', card: 'border-purple-200 bg-purple-50', num: 'text-purple-800', ring: 'ring-purple-400' },
  lost: { label: 'สูญหาย', chip: 'bg-red-100 text-red-700', card: 'border-red-200 bg-red-50', num: 'text-red-800', ring: 'ring-red-400' },
}

const STATUS_ORDER = Object.keys(STATUS_META) as HRAsset['status'][]

const CATEGORY_OPTIONS = [
  'IT', 'Production', 'Office', 'Electrical', 'Warehouse',
  'Vehicle', 'Marketing', 'Network', 'Tools', 'Others',
]

const SUB_TYPE_OPTIONS = ['Notebook', 'Printer', 'Monitor', 'Machine', 'Table', 'Chair', 'Car']

function round2(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** แปลงวันที่ ISO เป็นรูปแบบไทยอ่านง่าย เช่น 15 ม.ค. 2569 */
function thaiDate(d?: string): string {
  if (!d) return '-'
  const date = new Date(`${d}T00:00:00`)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** ค่าเสื่อมราคาต่อปี = มูลค่าตอนซื้อ ÷ อายุการใช้งาน (ปี) — null เมื่อคำนวณไม่ได้ */
function computeDepreciationPerYear(purchaseCost: string, usefulLifeYears: string): number | null {
  if (!purchaseCost.trim() || !usefulLifeYears.trim()) return null
  const cost = Number(purchaseCost)
  const years = Number(usefulLifeYears)
  if (!Number.isFinite(cost) || !Number.isFinite(years) || years <= 0) return null
  return cost / years
}

/** จำนวนปีที่ใช้งานไปแล้ว นับจากวันที่ซื้อถึงวันนี้ (ทศนิยม, ไม่ติดลบ) */
function yearsInUse(purchaseDate: string): number {
  if (!purchaseDate) return 0
  const start = new Date(`${purchaseDate}T00:00:00`)
  if (Number.isNaN(start.getTime())) return 0
  const ms = Date.now() - start.getTime()
  if (ms <= 0) return 0
  return ms / (365.25 * 24 * 60 * 60 * 1000)
}

/**
 * วันหมดประกัน = วันที่ซื้อ + ระยะประกัน
 * ไม่มีประกัน (สวิตช์ปิด) = วันเดียวกับวันที่ซื้อ
 */
function computeWarrantyExpire(form: AssetFormState): string {
  if (!form.purchase_date) return ''
  if (!form.has_warranty) return form.purchase_date
  const period = Number(form.warranty_period)
  if (!form.warranty_period.trim() || !Number.isInteger(period) || period <= 0) return ''
  const d = new Date(`${form.purchase_date}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  if (form.warranty_unit === 'year') d.setUTCFullYear(d.getUTCFullYear() + period)
  else d.setUTCDate(d.getUTCDate() + period)
  return d.toISOString().slice(0, 10)
}

/** อัปเดตช่องที่คำนวณเองทั้งหมด (ค่าเสื่อม/ปี + มูลค่าปัจจุบัน + วันหมดประกัน) */
function withDerived(next: AssetFormState): AssetFormState {
  const dep = computeDepreciationPerYear(next.purchase_cost, next.useful_life_years)
  const cost = Number(next.purchase_cost)
  let depreciation = next.depreciation_per_year
  let currentValue = next.current_value
  if (dep !== null && Number.isFinite(cost)) {
    depreciation = round2(dep)
    // มูลค่าปัจจุบัน = ราคาซื้อ − ค่าเสื่อมสะสมตามปีที่ใช้ไปแล้ว (ไม่ต่ำกว่า 0)
    currentValue = round2(Math.max(0, cost - dep * yearsInUse(next.purchase_date)))
  }
  return {
    ...next,
    depreciation_per_year: depreciation,
    current_value: currentValue,
    warranty_expire_date: computeWarrantyExpire(next),
  }
}

/** ช่องที่บังคับกรอกทั้งหมด — ช่องที่ระบบคำนวณให้เองไม่นับ */
function missingRequiredLabels(form: AssetFormState): string[] {
  const missing: string[] = []
  const req: [string, string][] = [
    ['ชื่อทรัพย์สิน', form.name.trim()],
    ['หมวดหมู่', form.category.trim()],
    ['ประเภทย่อย', form.sub_type.trim()],
    ['S/N', form.serial_number.trim()],
    ['ชื่อผู้ขาย', form.vendor_name.trim()],
    ['แผนก', form.department_id],
    ['สถานที่ใช้งาน', form.location.trim()],
    ['วันที่ซื้อ', form.purchase_date],
    ['วันที่รับเข้า', form.received_date],
    ['มูลค่าตอนซื้อ', form.purchase_cost.trim()],
    ['อายุการใช้งาน (ปี)', form.useful_life_years.trim()],
    ['ผู้รับผิดชอบทรัพย์สิน', form.assigned_employee_id],
    ['รายละเอียด', form.description.trim()],
    ['หมายเหตุเพิ่มเติม', form.notes.trim()],
  ]
  for (const [label, value] of req) {
    if (!value) missing.push(label)
  }
  if (form.has_warranty && !form.warranty_period.trim()) missing.push('ระยะเวลารับประกัน')
  return missing
}

function employeeLabel(emp: HREmployee): string {
  const name = [emp.first_name, emp.last_name].filter(Boolean).join(' ')
  return `${emp.employee_code ?? '-'} ${name}`.trim()
}

// ─── Template / Import ทะเบียนทรัพย์สิน ──────────────────────────────────────

type AssetTemplateRow = Record<string, unknown>

const ASSET_TEMPLATE_HEADERS = [
  'รหัสทรัพย์สิน',
  'ชื่อทรัพย์สิน *',
  'หมวดหมู่ *',
  'ประเภทย่อย *',
  'S/N *',
  'ชื่อผู้ขาย *',
  'แผนก *',
  'สถานที่ใช้งาน *',
  'สถานะ *',
  'ผู้รับผิดชอบ (รหัสพนักงาน) *',
  'วันที่ซื้อ *',
  'วันที่รับเข้า *',
  'มูลค่าตอนซื้อ *',
  'อายุการใช้งาน (ปี) *',
  'มีการรับประกัน',
  'ระยะเวลารับประกัน',
  'หน่วยรับประกัน',
  'รายละเอียด *',
  'หมายเหตุเพิ่มเติม *',
] as const

const ASSET_TEMPLATE_SAMPLE_ROW = [
  'AST-2026-0001',
  'Notebook Lenovo ThinkPad',
  'IT',
  'Notebook',
  'SN-ABC123456',
  'บริษัท ไอที ซัพพลาย จำกัด',
  'Management',
  'Office · ตึกใหม่ ชั้น 2',
  'ใช้งาน',
  'EMP00003',
  '2026-01-15',
  '2026-01-20',
  35000,
  5,
  'มี',
  3,
  'ปี',
  'โน้ตบุ๊กสำหรับงานออกแบบ',
  'รับประกันศูนย์ 3 ปี',
] as const

const ASSET_STATUS_LABEL_TO_ENUM: Record<string, HRAsset['status']> = Object.fromEntries(
  (Object.entries(STATUS_META) as [HRAsset['status'], { label: string }][]).map(([key, meta]) => [meta.label, key])
) as Record<string, HRAsset['status']>

function normalizeText(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeLookup(value: unknown): string {
  return normalizeText(value).toLowerCase()
}

function optionalText(value: unknown): string | undefined {
  const text = normalizeText(value)
  return text || undefined
}

/** แปลงค่าในเซลล์เป็นวันที่ ISO (YYYY-MM-DD) โดยไม่ผ่าน Date object เพื่อเลี่ยง timezone shift */
function parseTemplateDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed) {
      const month = String(parsed.m).padStart(2, '0')
      const day = String(parsed.d).padStart(2, '0')
      return `${parsed.y}-${month}-${day}`
    }
  }
  const text = normalizeText(value)
  if (!text) return undefined
  const match = text.replace(/\//g, '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (match) {
    const [, y, m, d] = match
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return text
}

function assetStatusFromLabel(value: unknown): HRAsset['status'] {
  const text = normalizeText(value)
  return ASSET_STATUS_LABEL_TO_ENUM[text] ?? 'active'
}

/** แปลงข้อมูลทรัพย์สิน 1 รายการ → แถวตามลำดับหัวคอลัมน์ template (ค่าที่ import กลับได้) */
function assetToTemplateRow(asset: HRAsset): (string | number)[] {
  const values: Record<string, string | number> = {
    'รหัสทรัพย์สิน': asset.asset_code ?? '',
    'ชื่อทรัพย์สิน *': asset.name ?? '',
    'หมวดหมู่ *': asset.category ?? '',
    'ประเภทย่อย *': asset.sub_type ?? '',
    'S/N *': asset.serial_number ?? '',
    'ชื่อผู้ขาย *': asset.vendor_name ?? '',
    'แผนก *': asset.department?.name ?? '',
    'สถานที่ใช้งาน *': asset.location ?? '',
    'สถานะ *': STATUS_META[asset.status]?.label ?? '',
    'ผู้รับผิดชอบ (รหัสพนักงาน) *': asset.assigned_employee?.employee_code ?? '',
    'วันที่ซื้อ *': asset.purchase_date ?? '',
    'วันที่รับเข้า *': asset.received_date ?? '',
    'มูลค่าตอนซื้อ *': asset.purchase_cost ?? '',
    'อายุการใช้งาน (ปี) *': asset.useful_life_years ?? '',
    'มีการรับประกัน': asset.has_warranty ? 'มี' : 'ไม่มี',
    'ระยะเวลารับประกัน': asset.has_warranty && asset.warranty_period != null ? asset.warranty_period : '',
    'หน่วยรับประกัน': asset.has_warranty ? (asset.warranty_unit === 'day' ? 'วัน' : 'ปี') : '',
    'รายละเอียด *': asset.description ?? '',
    'หมายเหตุเพิ่มเติม *': asset.notes ?? '',
  }
  return ASSET_TEMPLATE_HEADERS.map((header) => values[header] ?? '')
}

/** สร้าง payload สำหรับ upsert จากแถว template + คำนวณค่าอัตโนมัติ (ค่าเสื่อม/มูลค่าปัจจุบัน/วันหมดประกัน) */
function buildAssetPayloadFromRow(
  row: AssetTemplateRow,
  departments: HRDepartment[],
  employees: HREmployee[],
  existing?: HRAsset
): Partial<HRAsset> {
  const departmentName = normalizeLookup(row['แผนก *'])
  const departmentId = departmentName
    ? departments.find((d) => normalizeLookup(d.name) === departmentName)?.id
    : undefined

  const empCode = normalizeLookup(row['ผู้รับผิดชอบ (รหัสพนักงาน) *'])
  const assignedEmployeeId = empCode
    ? employees.find((e) => normalizeLookup(e.employee_code) === empCode)?.id
    : undefined

  const purchaseDate = parseTemplateDate(row['วันที่ซื้อ *'])
  const receivedDate = parseTemplateDate(row['วันที่รับเข้า *'])

  const costText = normalizeText(row['มูลค่าตอนซื้อ *']).replace(/,/g, '')
  const purchaseCost = costText ? Number(costText) : undefined
  const lifeText = normalizeText(row['อายุการใช้งาน (ปี) *']).replace(/,/g, '')
  const usefulLifeYears = lifeText ? Number(lifeText) : undefined

  const hasWarranty = normalizeText(row['มีการรับประกัน']) === 'มี'
  const periodText = normalizeText(row['ระยะเวลารับประกัน']).replace(/,/g, '')
  const warrantyPeriod = hasWarranty && periodText ? Number(periodText) : null
  const warrantyUnit: 'day' | 'year' | null = hasWarranty
    ? (normalizeText(row['หน่วยรับประกัน']) === 'วัน' ? 'day' : 'year')
    : null

  // ค่าที่คำนวณอัตโนมัติ — ตรงกับสูตรในฟอร์ม
  let depreciationPerYear: number | undefined
  let currentValue: number | undefined
  if (purchaseCost != null && usefulLifeYears != null && usefulLifeYears > 0) {
    const dep = purchaseCost / usefulLifeYears
    depreciationPerYear = Number(round2(dep))
    currentValue = Number(round2(Math.max(0, purchaseCost - dep * yearsInUse(purchaseDate ?? ''))))
  }
  const warrantyExpire = computeWarrantyExpire({
    purchase_date: purchaseDate ?? '',
    has_warranty: hasWarranty,
    warranty_period: warrantyPeriod == null ? '' : String(warrantyPeriod),
    warranty_unit: warrantyUnit ?? 'year',
  } as AssetFormState)

  return {
    id: existing?.id,
    asset_code: optionalText(row['รหัสทรัพย์สิน']),
    name: normalizeText(row['ชื่อทรัพย์สิน *']),
    category: optionalText(row['หมวดหมู่ *']),
    sub_type: optionalText(row['ประเภทย่อย *']),
    serial_number: optionalText(row['S/N *']),
    vendor_name: optionalText(row['ชื่อผู้ขาย *']),
    department_id: departmentId,
    location: optionalText(row['สถานที่ใช้งาน *']),
    status: assetStatusFromLabel(row['สถานะ *']),
    assigned_employee_id: assignedEmployeeId,
    purchase_date: purchaseDate,
    received_date: receivedDate,
    purchase_cost: Number.isFinite(purchaseCost) ? purchaseCost : undefined,
    useful_life_years: Number.isFinite(usefulLifeYears) ? usefulLifeYears : undefined,
    depreciation_per_year: depreciationPerYear,
    current_value: currentValue,
    has_warranty: hasWarranty,
    warranty_period: warrantyPeriod,
    warranty_unit: warrantyUnit,
    warranty_expire_date: warrantyExpire || undefined,
    description: optionalText(row['รายละเอียด *']),
    notes: optionalText(row['หมายเหตุเพิ่มเติม *']),
  }
}

function downloadAssetTemplate(assets: HRAsset[] = []) {
  const workbook = XLSX.utils.book_new()

  const rows: (string | number)[][] = [
    Array.from(ASSET_TEMPLATE_HEADERS),
    ...assets.map(assetToTemplateRow),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  sheet['!cols'] = ASSET_TEMPLATE_HEADERS.map((header) => ({ wch: Math.max(String(header).length + 4, 16) }))
  XLSX.utils.book_append_sheet(workbook, sheet, 'ทะเบียนทรัพย์สิน')

  const sampleSheet = XLSX.utils.aoa_to_sheet([
    Array.from(ASSET_TEMPLATE_HEADERS),
    Array.from(ASSET_TEMPLATE_SAMPLE_ROW),
  ])
  sampleSheet['!cols'] = ASSET_TEMPLATE_HEADERS.map((header) => ({ wch: Math.max(String(header).length + 4, 16) }))
  XLSX.utils.book_append_sheet(workbook, sampleSheet, 'ตัวอย่าง')

  const statusList = STATUS_ORDER.map((s) => STATUS_META[s].label).join(' / ')
  const instructionRows = [
    ['หัวข้อ', 'รายละเอียด'],
    ['ช่องที่มี *', 'ต้องกรอกข้อมูลก่อน import'],
    ['รหัสทรัพย์สิน', 'เว้นว่างเมื่อเพิ่มใหม่ (ระบบออกรหัสให้อัตโนมัติ) — หากตรงกับรหัสเดิม ระบบจะอัปเดตข้อมูลรายการนั้น'],
    ['แผนก', 'กรอกชื่อแผนกให้ตรงกับที่มีในระบบ เช่น Management, Production'],
    ['ผู้รับผิดชอบ', 'กรอกเป็น "รหัสพนักงาน" เช่น EMP00003 (ดูได้จากเมนูทะเบียนพนักงาน)'],
    ['สถานะ', `กรอกเป็นภาษาไทยอย่างใดอย่างหนึ่ง: ${statusList}`],
    ['วันที่ (ซื้อ/รับเข้า)', 'รูปแบบ YYYY-MM-DD เช่น 2026-01-15'],
    ['มูลค่าตอนซื้อ / อายุการใช้งาน', 'กรอกเป็นตัวเลข — ระบบจะคำนวณค่าเสื่อม/ปี และมูลค่าปัจจุบันให้อัตโนมัติ'],
    ['มีการรับประกัน', 'กรอก "มี" หรือ "ไม่มี" — ถ้า "มี" ต้องกรอกระยะเวลารับประกัน'],
    ['หน่วยรับประกัน', 'กรอก "ปี" หรือ "วัน" — ระบบจะคำนวณวันหมดประกันให้อัตโนมัติ'],
    ['ค่าที่ระบบคำนวณให้', 'ค่าเสื่อม/ปี, มูลค่าปัจจุบัน, วันหมดประกัน — ไม่ต้องกรอก ระบบคำนวณจากข้อมูลข้างต้น'],
    ['รูปภาพ / เอกสาร PDF', 'ไม่รองรับผ่าน import — เพิ่มรูปและไฟล์เอกสาร PDF ได้ที่หน้าจอแก้ไขทรัพย์สินโดยตรง'],
  ]
  const instructionSheet = XLSX.utils.aoa_to_sheet(instructionRows)
  instructionSheet['!cols'] = [{ wch: 28 }, { wch: 80 }]
  XLSX.utils.book_append_sheet(workbook, instructionSheet, 'คู่มือการกรอก')

  XLSX.writeFile(workbook, 'template-ทะเบียนทรัพย์สิน.xlsx')
}

export default function AssetRegistry() {
  const [assets, setAssets] = useState<HRAsset[]>([])
  const [departments, setDepartments] = useState<HRDepartment[]>([])
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [departmentFilter, setDepartmentFilter] = useState<string>('')
  const [assignedFilter, setAssignedFilter] = useState<string>('')
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<AssetFormState>(EMPTY_FORM)
  const [newImageFiles, setNewImageFiles] = useState<File[]>([])
  const [newDocFiles, setNewDocFiles] = useState<File[]>([])
  // เก็บทรัพย์สินเดิมตอนเปิดแก้ไข เพื่อรู้ว่าไฟล์ใดถูกเอาออก จะได้ลบใน storage ตอนบันทึก
  const [editingAsset, setEditingAsset] = useState<HRAsset | null>(null)
  // รูปที่กำลังเปิดดูแบบขยาย (lightbox) — null = ไม่เปิด, ค่าอื่นคือ index ในแกลเลอรีรวม
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  // พรีวิวไฟล์ที่เพิ่งเลือกแต่ยังไม่อัปโหลด (object URL) + คืนหน่วยความจำเมื่อเลิกใช้
  const pendingPreviews = useMemo(() => newImageFiles.map((file) => URL.createObjectURL(file)), [newImageFiles])
  useEffect(() => {
    return () => pendingPreviews.forEach((url) => URL.revokeObjectURL(url))
  }, [pendingPreviews])

  // แกลเลอรีรวมสำหรับ lightbox: รูปที่อัปโหลดแล้ว + รูปที่รออัปโหลด (ลำดับตรงกับที่แสดงในกริด)
  const galleryUrls = useMemo(
    () => [...form.images.map((p) => getHRFileUrl(BUCKET, p)), ...pendingPreviews],
    [form.images, pendingPreviews]
  )
  const showPrevImage = useCallback(
    () => setPreviewIndex((i) => (i === null ? i : (i - 1 + galleryUrls.length) % galleryUrls.length)),
    [galleryUrls.length]
  )
  const showNextImage = useCallback(
    () => setPreviewIndex((i) => (i === null ? i : (i + 1) % galleryUrls.length)),
    [galleryUrls.length]
  )

  // คีย์ลัด: Esc ปิด, ←/→ เลื่อนดูรูป
  useEffect(() => {
    if (previewIndex === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewIndex(null)
      else if (e.key === 'ArrowLeft') showPrevImage()
      else if (e.key === 'ArrowRight') showNextImage()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewIndex, showPrevImage, showNextImage])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [assetList, deptList, empList] = await Promise.all([
        fetchAssets(),
        fetchDepartments(),
        fetchEmployees({ status: 'active' }),
      ])
      setAssets(assetList)
      setDepartments(deptList)
      setEmployees(empList)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดข้อมูลทะเบียนทรัพย์สินไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const filteredAssets = useMemo(() => {
    const q = search.trim().toLowerCase()
    return assets.filter((a) => {
      if (statusFilter && a.status !== statusFilter) return false
      if (departmentFilter && (a.department_id ?? '') !== departmentFilter) return false
      if (assignedFilter && (a.assigned_employee_id ?? '') !== assignedFilter) return false
      if (!q) return true
      const text = [
        a.asset_code,
        a.name,
        a.category,
        a.sub_type,
        a.serial_number,
        a.vendor_name,
        a.location,
        a.assigned_employee?.first_name,
        a.assigned_employee?.last_name,
      ].filter(Boolean).join(' ').toLowerCase()
      return text.includes(q)
    })
  }, [assets, search, statusFilter, departmentFilter, assignedFilter])

  const stats = useMemo(() => {
    const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<HRAsset['status'], number>
    for (const a of assets) {
      if (a.status in byStatus) byStatus[a.status] += 1
    }
    const totalValue = assets.reduce((sum, a) => sum + (Number(a.current_value) || 0), 0)
    return { byStatus, totalValue }
  }, [assets])

  const openCreate = async () => {
    setForm(EMPTY_FORM)
    setNewImageFiles([])
    setNewDocFiles([])
    setEditingAsset(null)
    setError(null)
    setFormOpen(true)
    try {
      // รหัสจริงออกตอน insert (trigger ฝั่ง DB) — ตัวนี้แสดงให้เห็นล่วงหน้าเฉยๆ
      const code = await peekNextAssetCode()
      setForm((p) => (p.id ? p : { ...p, asset_code: code }))
    } catch {
      /* ถ้าดึงรหัสตัวอย่างไม่ได้ ปล่อยว่างไว้ — DB จะรันให้เองตอนบันทึก */
    }
  }

  const openEdit = (asset: HRAsset) => {
    setForm(withDerived({
      id: asset.id,
      asset_code: asset.asset_code ?? '',
      name: asset.name ?? '',
      category: asset.category ?? '',
      sub_type: asset.sub_type ?? '',
      serial_number: asset.serial_number ?? '',
      vendor_name: asset.vendor_name ?? '',
      description: asset.description ?? '',
      department_id: asset.department_id ?? '',
      location: asset.location ?? '',
      purchase_date: asset.purchase_date ?? '',
      received_date: asset.received_date ?? '',
      has_warranty: asset.has_warranty ?? false,
      warranty_period: asset.warranty_period == null ? '' : String(asset.warranty_period),
      warranty_unit: asset.warranty_unit ?? 'year',
      warranty_expire_date: asset.warranty_expire_date ?? '',
      purchase_cost: asset.purchase_cost == null ? '' : String(asset.purchase_cost),
      useful_life_years: asset.useful_life_years == null ? '' : String(asset.useful_life_years),
      depreciation_per_year: asset.depreciation_per_year == null ? '' : String(asset.depreciation_per_year),
      current_value: asset.current_value == null ? '' : String(asset.current_value),
      status: asset.status ?? 'active',
      assigned_employee_id: asset.assigned_employee_id ?? '',
      images: Array.isArray(asset.images) ? [...asset.images] : [],
      documents: Array.isArray(asset.documents) ? [...asset.documents] : [],
      notes: asset.notes ?? '',
    }))
    setNewImageFiles([])
    setNewDocFiles([])
    setEditingAsset(asset)
    setError(null)
    setFormOpen(true)
  }

  const handleAddImageFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    setNewImageFiles((prev) => {
      // กันเลือกไฟล์เดิมซ้ำ (ชื่อ + ขนาดเดียวกัน) เพื่อไม่ให้อัปโหลดรูปซ้ำ
      const seen = new Set(prev.map((f) => `${f.name}_${f.size}`))
      const add = Array.from(files).filter((f) => !seen.has(`${f.name}_${f.size}`))
      return [...prev, ...add]
    })
  }

  const removeExistingImage = (index: number) => {
    setForm((prev) => ({
      ...prev,
      images: prev.images.filter((_, i) => i !== index),
    }))
  }

  const removePendingImage = (index: number) => {
    setNewImageFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleAddDocFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    const picked = Array.from(files)
    const pdfs = picked.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
    if (pdfs.length < picked.length) {
      setError('รองรับเฉพาะไฟล์ PDF เท่านั้น')
    }
    if (pdfs.length > 0) {
      setNewDocFiles((prev) => {
        // กันเลือกไฟล์เดิมซ้ำ (ชื่อ + ขนาดเดียวกัน)
        const seen = new Set(prev.map((f) => `${f.name}_${f.size}`))
        const add = pdfs.filter((f) => !seen.has(`${f.name}_${f.size}`))
        return [...prev, ...add]
      })
    }
  }

  const removeExistingDoc = (index: number) => {
    setForm((prev) => ({ ...prev, documents: prev.documents.filter((_, i) => i !== index) }))
  }

  const removePendingDoc = (index: number) => {
    setNewDocFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSave = async () => {
    const missing = missingRequiredLabels(form)
    if (missing.length > 0) {
      setError(`กรุณากรอกข้อมูลให้ครบ: ${missing.join(', ')}`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      // อัปโหลดไฟล์ที่รออยู่ แล้ว "ย้าย" เข้า form + เคลียร์ pending ทันที
      // เพื่อว่าหาก upsert ด้านล่างล้มเหลวแล้วผู้ใช้กดบันทึกใหม่ จะไม่อัปโหลดรูปซ้ำ
      const images = [...form.images]
      const documents = [...form.documents]
      if (newImageFiles.length > 0 || newDocFiles.length > 0) {
        for (const file of newImageFiles) {
          const path = createStoragePath('assets', file.name)
          await uploadHRFile(BUCKET, path, file)
          images.push(path)
        }
        for (const file of newDocFiles) {
          const path = createStoragePath('documents', file.name)
          await uploadHRFile(BUCKET, path, file)
          documents.push({ name: file.name, path, uploaded_at: new Date().toISOString() })
        }
        setForm((p) => ({ ...p, images, documents }))
        setNewImageFiles([])
        setNewDocFiles([])
      }
      await upsertAsset({
        id: form.id,
        // เว้นว่างตอนสร้างใหม่ = ให้ trigger ฝั่ง DB รันรหัส AST00001 ให้เอง
        asset_code: form.asset_code.trim() || undefined,
        name: form.name.trim(),
        category: form.category.trim() || undefined,
        sub_type: form.sub_type.trim() || undefined,
        serial_number: form.serial_number.trim() || undefined,
        vendor_name: form.vendor_name.trim() || undefined,
        description: form.description.trim() || undefined,
        department_id: form.department_id || undefined,
        location: form.location.trim() || undefined,
        purchase_date: form.purchase_date || undefined,
        received_date: form.received_date || undefined,
        has_warranty: form.has_warranty,
        warranty_period: form.has_warranty && form.warranty_period.trim() !== '' ? Number(form.warranty_period) : null,
        warranty_unit: form.has_warranty ? form.warranty_unit : null,
        warranty_expire_date: form.warranty_expire_date || undefined,
        purchase_cost: form.purchase_cost.trim() === '' ? undefined : Number(form.purchase_cost),
        useful_life_years: form.useful_life_years.trim() === '' ? undefined : Number(form.useful_life_years),
        depreciation_per_year: form.depreciation_per_year.trim() === '' ? undefined : Number(form.depreciation_per_year),
        current_value: form.current_value.trim() === '' ? undefined : Number(form.current_value),
        status: form.status,
        assigned_employee_id: form.assigned_employee_id || undefined,
        images,
        documents,
        notes: form.notes.trim() || undefined,
      })

      // ลบไฟล์เดิมที่ถูกเอาออกตอนแก้ไข (orphan) — best-effort ไม่ให้กระทบผลบันทึก
      if (editingAsset) {
        const keptImages = new Set(images)
        const keptDocs = new Set(documents.map((d) => d.path))
        const removed = [
          ...(editingAsset.images ?? []).filter((p) => !keptImages.has(p)),
          ...(editingAsset.documents ?? []).map((d) => d.path).filter((p) => !keptDocs.has(p)),
        ]
        if (removed.length > 0) {
          try { await removeHRFiles(BUCKET, removed) } catch { /* ยอมให้ orphan ตกค้างได้ ไม่ถือว่าบันทึกล้มเหลว */ }
        }
      }

      setFormOpen(false)
      setForm(EMPTY_FORM)
      setNewImageFiles([])
      setNewDocFiles([])
      setEditingAsset(null)
      await loadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกทรัพย์สินไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (asset: HRAsset) => {
    const yes = window.confirm(`ยืนยันลบทรัพย์สิน "${asset.name}" ?`)
    if (!yes) return
    try {
      await deleteAsset(asset.id)
      // ลบไฟล์รูป + เอกสารทั้งหมดของทรัพย์สินนี้ใน storage — best-effort
      const paths = [
        ...(asset.images ?? []),
        ...(asset.documents ?? []).map((d) => d.path),
      ]
      if (paths.length > 0) {
        try { await removeHRFiles(BUCKET, paths) } catch { /* ยอมให้ orphan ตกค้างได้ ลบ row สำเร็จแล้ว */ }
      }
      await loadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบทรัพย์สินไม่สำเร็จ')
    }
  }

  const handleDownloadTemplate = async () => {
    setDownloading(true)
    setError(null)
    try {
      // ดึงทรัพย์สินทั้งหมด (ไม่ผูกกับ filter หน้าจอ) เพื่อให้ได้ข้อมูลปัจจุบันครบทุกรายการ
      const allAssets = await fetchAssets()
      downloadAssetTemplate(allAssets)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ดาวน์โหลด Template ไม่สำเร็จ')
    } finally {
      setDownloading(false)
    }
  }

  const handleImportClick = () => importInputRef.current?.click()

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setImporting(true)
    setError(null)
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const worksheet = workbook.Sheets['ทะเบียนทรัพย์สิน'] ?? workbook.Sheets[workbook.SheetNames[0]]
      if (!worksheet) throw new Error('ไม่พบ sheet สำหรับนำเข้าข้อมูล')

      const rows = XLSX.utils.sheet_to_json<AssetTemplateRow>(worksheet, { defval: '' })
        .filter((row) => ASSET_TEMPLATE_HEADERS.some((header) => normalizeText(row[header])))
      if (rows.length === 0) {
        setError('ไม่พบข้อมูลทรัพย์สินในไฟล์ import')
        return
      }

      // ดึงข้อมูลอ้างอิงแบบครบ (พนักงานทุกสถานะ) เพื่อ map แผนก/ผู้รับผิดชอบ
      const [allAssets, allDepartments, allEmployees] = await Promise.all([
        fetchAssets(),
        fetchDepartments(),
        fetchEmployees(),
      ])
      const existingByCode = new Map(
        allAssets
          .filter((a) => a.asset_code)
          .map((a) => [normalizeLookup(a.asset_code), a])
      )
      const departmentNames = new Set(allDepartments.map((d) => normalizeLookup(d.name)))
      const employeeCodes = new Set(allEmployees.map((e) => normalizeLookup(e.employee_code)))

      const errors: string[] = []
      rows.forEach((row, index) => {
        const rowNumber = index + 2
        const req: [string, string][] = [
          ['ชื่อทรัพย์สิน', normalizeText(row['ชื่อทรัพย์สิน *'])],
          ['หมวดหมู่', normalizeText(row['หมวดหมู่ *'])],
          ['ประเภทย่อย', normalizeText(row['ประเภทย่อย *'])],
          ['S/N', normalizeText(row['S/N *'])],
          ['ชื่อผู้ขาย', normalizeText(row['ชื่อผู้ขาย *'])],
          ['สถานที่ใช้งาน', normalizeText(row['สถานที่ใช้งาน *'])],
          ['วันที่ซื้อ', normalizeText(row['วันที่ซื้อ *'])],
          ['วันที่รับเข้า', normalizeText(row['วันที่รับเข้า *'])],
          ['มูลค่าตอนซื้อ', normalizeText(row['มูลค่าตอนซื้อ *'])],
          ['อายุการใช้งาน (ปี)', normalizeText(row['อายุการใช้งาน (ปี) *'])],
          ['รายละเอียด', normalizeText(row['รายละเอียด *'])],
          ['หมายเหตุเพิ่มเติม', normalizeText(row['หมายเหตุเพิ่มเติม *'])],
        ]
        for (const [label, value] of req) {
          if (!value) errors.push(`แถว ${rowNumber}: กรุณากรอก${label}`)
        }

        const dept = normalizeLookup(row['แผนก *'])
        if (!dept) errors.push(`แถว ${rowNumber}: กรุณากรอกแผนก`)
        else if (!departmentNames.has(dept)) errors.push(`แถว ${rowNumber}: ไม่พบแผนก "${normalizeText(row['แผนก *'])}"`)

        const emp = normalizeLookup(row['ผู้รับผิดชอบ (รหัสพนักงาน) *'])
        if (!emp) errors.push(`แถว ${rowNumber}: กรุณากรอกผู้รับผิดชอบ (รหัสพนักงาน)`)
        else if (!employeeCodes.has(emp)) errors.push(`แถว ${rowNumber}: ไม่พบรหัสพนักงาน "${normalizeText(row['ผู้รับผิดชอบ (รหัสพนักงาน) *'])}"`)

        if (normalizeText(row['มีการรับประกัน']) === 'มี' && !normalizeText(row['ระยะเวลารับประกัน'])) {
          errors.push(`แถว ${rowNumber}: เลือก "มี" ประกันแล้วต้องกรอกระยะเวลารับประกัน`)
        }
      })

      if (errors.length > 0) {
        const more = errors.length > 8 ? `\n...และอีก ${errors.length - 8} รายการ` : ''
        setError(`นำเข้าไม่สำเร็จ:\n${errors.slice(0, 8).join('\n')}${more}`)
        return
      }

      if (!window.confirm(`ต้องการนำเข้าข้อมูลทะเบียนทรัพย์สิน ${rows.length} รายการใช่หรือไม่?\nหากรหัสทรัพย์สินซ้ำ ระบบจะอัปเดตข้อมูลเดิม`)) {
        return
      }

      let created = 0
      let updated = 0
      for (const row of rows) {
        const code = normalizeLookup(row['รหัสทรัพย์สิน'])
        const existing = code ? existingByCode.get(code) : undefined
        await upsertAsset(buildAssetPayloadFromRow(row, allDepartments, allEmployees, existing))
        if (existing) updated += 1
        else created += 1
      }

      await loadAll()
      window.alert(`นำเข้าสำเร็จ\nเพิ่มใหม่ ${created} รายการ\nอัปเดต ${updated} รายการ`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'เกิดข้อผิดพลาดระหว่างนำเข้า')
    } finally {
      setImporting(false)
    }
  }

  if (loading) {
    return (
      <div className="mt-4 flex justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" />
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-6">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
        {STATUS_ORDER.map((s) => {
          const meta = STATUS_META[s]
          const activeFilter = statusFilter === s
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(activeFilter ? '' : s)}
              title={`กรองเฉพาะ "${meta.label}"`}
              className={`rounded-xl border p-4 text-left transition ${meta.card} ${activeFilter ? `ring-2 ${meta.ring}` : 'hover:brightness-95'}`}
            >
              <p className="text-xs text-gray-600">{meta.label}</p>
              <p className={`mt-1 text-2xl font-bold ${meta.num}`}>{stats.byStatus[s]}</p>
            </button>
          )
        })}
        <div className="col-span-2 rounded-xl border border-surface-200 bg-white p-4">
          <p className="text-xs text-gray-500">มูลค่าปัจจุบันรวม</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{stats.totalValue.toLocaleString()} บาท</p>
        </div>
      </div>

      <div className="rounded-xl border border-surface-200 bg-white p-4 shadow-soft">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[240px] flex-1">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหารหัส / ชื่อ / หมวดหมู่ / ประเภทย่อย / S/N / ผู้ขาย / สถานที่"
              className="w-full rounded-xl border border-surface-200 py-2 pl-9 pr-3 text-sm"
            />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-xl border border-surface-200 px-3 py-2 text-sm">
            <option value="">ทุกสถานะ</option>
            {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)} className="rounded-xl border border-surface-200 px-3 py-2 text-sm">
            <option value="">ทุกแผนก</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={assignedFilter} onChange={(e) => setAssignedFilter(e.target.value)} className="rounded-xl border border-surface-200 px-3 py-2 text-sm">
            <option value="">ผู้รับผิดชอบทั้งหมด</option>
            {employees.map((emp) => <option key={emp.id} value={emp.id}>{employeeLabel(emp)}</option>)}
          </select>
          <button
            type="button"
            onClick={handleDownloadTemplate}
            disabled={downloading}
            className="ml-auto inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-white px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FiDownload /> {downloading ? 'กำลังสร้างไฟล์...' : 'Template ทรัพย์สิน'}
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="hidden"
            onChange={handleImportFile}
          />
          <button
            type="button"
            onClick={handleImportClick}
            disabled={importing}
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-white px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FiUpload /> {importing ? 'กำลัง Import...' : 'Import'}
          </button>
          <button onClick={openCreate} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
            <FiPlus /> เพิ่มทรัพย์สิน
          </button>
        </div>

        <div className="overflow-x-auto rounded-xl border border-surface-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-50">
              <tr className="border-b border-surface-200">
                <th className="px-4 py-3 font-semibold text-gray-700">รหัส</th>
                <th className="px-4 py-3 font-semibold text-gray-700">รายการทรัพย์สิน</th>
                <th className="px-4 py-3 font-semibold text-gray-700">แผนก</th>
                <th className="px-4 py-3 font-semibold text-gray-700">ผู้รับผิดชอบ</th>
                <th className="px-4 py-3 font-semibold text-gray-700">มูลค่าตอนซื้อ</th>
                <th className="px-4 py-3 font-semibold text-gray-700">มูลค่าปัจจุบัน</th>
                <th className="px-4 py-3 font-semibold text-gray-700">วันที่ซื้อ</th>
                <th className="px-4 py-3 font-semibold text-gray-700">วันหมดประกัน</th>
                <th className="px-4 py-3 font-semibold text-gray-700">สถานะ</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-700">จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {filteredAssets.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-500">ยังไม่มีข้อมูลทรัพย์สิน</td>
                </tr>
              ) : filteredAssets.map((asset) => (
                <tr key={asset.id} className="border-b border-surface-100 hover:bg-surface-50">
                  <td className="whitespace-nowrap px-4 py-3">{asset.asset_code ?? '-'}</td>
                  <td className="px-4 py-3">
                    <div className="max-w-[240px] break-words font-medium text-gray-900">{asset.name}</div>
                    <div className="text-xs text-gray-500">{asset.category ?? '-'} · {asset.location ?? '-'}</div>
                  </td>
                  <td className="px-4 py-3">{asset.department?.name ?? '-'}</td>
                  <td className="px-4 py-3">
                    {asset.assigned_employee
                      ? [asset.assigned_employee.first_name, asset.assigned_employee.last_name].filter(Boolean).join(' ')
                      : '-'}
                  </td>
                  <td className="px-4 py-3">{asset.purchase_cost != null ? `${Number(asset.purchase_cost).toLocaleString()} บาท` : '-'}</td>
                  <td className="px-4 py-3">{asset.current_value != null ? `${Number(asset.current_value).toLocaleString()} บาท` : '-'}</td>
                  <td className="whitespace-nowrap px-4 py-3">{thaiDate(asset.purchase_date)}</td>
                  <td className="whitespace-nowrap px-4 py-3">{asset.has_warranty && asset.warranty_expire_date ? thaiDate(asset.warranty_expire_date) : '-'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_META[asset.status].chip}`}>
                      {STATUS_META[asset.status].label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openEdit(asset)} className="rounded-lg p-2 text-blue-600 hover:bg-blue-50" title="แก้ไข">
                      <FiEdit2 />
                    </button>
                    <button onClick={() => handleDelete(asset)} className="rounded-lg p-2 text-red-600 hover:bg-red-50" title="ลบ">
                      <FiTrash2 />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={formOpen} onClose={() => setFormOpen(false)} contentClassName="max-w-4xl" closeOnBackdropClick>
        <div className="p-6">
          <h3 className="mb-4 text-lg font-semibold text-gray-900">{form.id ? 'แก้ไขทรัพย์สิน' : 'เพิ่มทรัพย์สิน'}</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="block text-sm">
              <span className="text-gray-600">รหัสทรัพย์สิน</span>
              <input
                value={form.asset_code}
                readOnly
                placeholder="AST-2026-0001"
                className="mt-1 w-full rounded-xl border border-surface-200 bg-surface-50 px-3 py-2 text-gray-600"
              />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">ชื่อทรัพย์สิน <span className="text-red-500">*</span></span>
              <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">หมวดหมู่ <span className="text-red-500">*</span></span>
              <select value={form.category} onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2">
                <option value="">-- เลือกหมวดหมู่ --</option>
                {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                {form.category && !CATEGORY_OPTIONS.includes(form.category) && (
                  <option value={form.category}>{form.category} (ค่าเดิม)</option>
                )}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">ประเภทย่อย <span className="text-red-500">*</span></span>
              <select value={form.sub_type} onChange={(e) => setForm((p) => ({ ...p, sub_type: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2">
                <option value="">-- เลือกประเภทย่อย --</option>
                {SUB_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                {form.sub_type && !SUB_TYPE_OPTIONS.includes(form.sub_type) && (
                  <option value={form.sub_type}>{form.sub_type} (ค่าเดิม)</option>
                )}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">S/N <span className="text-red-500">*</span></span>
              <input value={form.serial_number} onChange={(e) => setForm((p) => ({ ...p, serial_number: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">ชื่อผู้ขาย <span className="text-red-500">*</span></span>
              <input value={form.vendor_name} onChange={(e) => setForm((p) => ({ ...p, vendor_name: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">แผนก <span className="text-red-500">*</span></span>
              <select value={form.department_id} onChange={(e) => setForm((p) => ({ ...p, department_id: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2">
                <option value="">-- เลือกแผนก --</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">สถานที่ใช้งาน <span className="text-red-500">*</span></span>
              <input value={form.location} onChange={(e) => setForm((p) => ({ ...p, location: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">สถานะ <span className="text-red-500">*</span></span>
              <select value={form.status} onChange={(e) => setForm((p) => ({ ...p, status: e.target.value as HRAsset['status'] }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2">
                {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">วันที่ซื้อ <span className="text-red-500">*</span></span>
              <input type="date" value={form.purchase_date} onChange={(e) => setForm((p) => withDerived({ ...p, purchase_date: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">วันที่รับเข้า <span className="text-red-500">*</span></span>
              <input type="date" value={form.received_date} onChange={(e) => setForm((p) => ({ ...p, received_date: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <div className="block text-sm md:col-span-2">
              <div className="flex items-center justify-between">
                <span className="text-gray-600">การรับประกัน</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.has_warranty}
                  onClick={() => setForm((p) => withDerived({ ...p, has_warranty: !p.has_warranty }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.has_warranty ? 'bg-emerald-600' : 'bg-gray-300'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.has_warranty ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-3">
                <label className="block">
                  <span className="text-xs text-gray-500">ระยะเวลารับประกัน {form.has_warranty && <span className="text-red-500">*</span>}</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={form.warranty_period}
                    disabled={!form.has_warranty}
                    onChange={(e) => setForm((p) => withDerived({ ...p, warranty_period: e.target.value }))}
                    className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2 disabled:bg-surface-50 disabled:text-gray-400"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-500">หน่วย</span>
                  <select
                    value={form.warranty_unit}
                    disabled={!form.has_warranty}
                    onChange={(e) => setForm((p) => withDerived({ ...p, warranty_unit: e.target.value as 'day' | 'year' }))}
                    className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2 disabled:bg-surface-50 disabled:text-gray-400"
                  >
                    <option value="year">ปี</option>
                    <option value="day">วัน</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs text-gray-500">วันหมดประกัน</span>
                  <input type="date" value={form.warranty_expire_date} readOnly className="mt-1 w-full rounded-xl border border-surface-200 bg-surface-50 px-3 py-2 text-gray-600" />
                </label>
              </div>
              <span className="mt-1 block text-xs text-gray-400">
                {form.has_warranty ? 'คำนวณอัตโนมัติ: วันที่ซื้อ + ระยะเวลารับประกัน' : 'ไม่มีประกัน — วันหมดประกันเท่ากับวันที่ซื้อ'}
              </span>
            </div>
            <label className="block text-sm">
              <span className="text-gray-600">มูลค่าตอนซื้อ <span className="text-red-500">*</span></span>
              <input type="number" min={0} value={form.purchase_cost} onChange={(e) => setForm((p) => withDerived({ ...p, purchase_cost: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">อายุการใช้งาน (ปี) <span className="text-red-500">*</span></span>
              <input type="number" min={0} step="0.5" value={form.useful_life_years} onChange={(e) => setForm((p) => withDerived({ ...p, useful_life_years: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">ค่าเสื่อม/ปี</span>
              <input type="number" value={form.depreciation_per_year} readOnly className="mt-1 w-full rounded-xl border border-surface-200 bg-surface-50 px-3 py-2 text-gray-600" />
              <span className="mt-1 block text-xs text-gray-400">คำนวณอัตโนมัติ: มูลค่าตอนซื้อ ÷ อายุการใช้งาน</span>
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">มูลค่าปัจจุบัน</span>
              <input type="number" value={form.current_value} readOnly className="mt-1 w-full rounded-xl border border-surface-200 bg-surface-50 px-3 py-2 text-gray-600" />
              <span className="mt-1 block text-xs text-gray-400">คำนวณอัตโนมัติ: มูลค่าตอนซื้อ − (ค่าเสื่อม/ปี × ปีที่ใช้งานไปแล้ว) ไม่ต่ำกว่า 0</span>
            </label>
            <label className="block text-sm md:col-span-2">
              <span className="text-gray-600">ผู้รับผิดชอบทรัพย์สิน <span className="text-red-500">*</span></span>
              <select value={form.assigned_employee_id} onChange={(e) => setForm((p) => ({ ...p, assigned_employee_id: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2">
                <option value="">-- เลือกผู้รับผิดชอบ --</option>
                {employees.map((emp) => <option key={emp.id} value={emp.id}>{employeeLabel(emp)}</option>)}
              </select>
            </label>
            <label className="block text-sm md:col-span-2">
              <span className="text-gray-600">รายละเอียด <span className="text-red-500">*</span></span>
              <textarea value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} rows={3} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm md:col-span-2">
              <span className="text-gray-600">หมายเหตุเพิ่มเติม <span className="text-red-500">*</span></span>
              <textarea value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} rows={2} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
          </div>

          <div className="mt-5 rounded-xl border border-surface-200 bg-surface-50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-gray-700">รูปภาพทรัพย์สิน</p>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
                <FiUpload /> เพิ่มรูป
                <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => handleAddImageFiles(e.target.files)} />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {form.images.map((path, idx) => {
                const url = getHRFileUrl(BUCKET, path)
                return (
                  <div key={`${path}_${idx}`} className="group relative overflow-hidden rounded-lg border border-surface-200 bg-white">
                    <button type="button" onClick={() => setPreviewIndex(idx)} className="block h-40 w-full cursor-zoom-in" title="คลิกเพื่อดูรูปขนาดใหญ่">
                      <img src={url} alt="asset" className="h-40 w-full object-cover transition-transform group-hover:scale-105" />
                    </button>
                    <button type="button" onClick={() => removeExistingImage(idx)} title="ลบรูป" className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white hover:bg-red-600">
                      <FiX className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )
              })}
              {newImageFiles.map((file, idx) => {
                const url = pendingPreviews[idx]
                return (
                  <div key={`${file.name}_${idx}`} className="group relative overflow-hidden rounded-lg border border-dashed border-surface-300 bg-white">
                    <button type="button" onClick={() => setPreviewIndex(form.images.length + idx)} className="block h-40 w-full cursor-zoom-in" title="คลิกเพื่อดูรูปขนาดใหญ่">
                      <img src={url} alt={file.name} className="h-40 w-full object-cover transition-transform group-hover:scale-105" />
                    </button>
                    <span className="absolute bottom-0 left-0 right-0 bg-black/50 px-1.5 py-0.5 text-[10px] text-white line-clamp-1">รออัปโหลด · {file.name}</span>
                    <button type="button" onClick={() => removePendingImage(idx)} title="เอาออก" className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white hover:bg-red-600">
                      <FiX className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-surface-200 bg-surface-50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-gray-700">เอกสารแนบ (PDF)</p>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
                <FiUpload /> เพิ่มเอกสาร
                <input type="file" accept="application/pdf,.pdf" multiple className="hidden" onChange={(e) => handleAddDocFiles(e.target.files)} />
              </label>
            </div>

            {form.documents.length === 0 && newDocFiles.length === 0 ? (
              <p className="py-4 text-center text-sm text-gray-500">ยังไม่มีเอกสารแนบ</p>
            ) : (
              <ul className="divide-y divide-surface-200 overflow-hidden rounded-lg border border-surface-200 bg-white">
                {form.documents.map((doc, idx) => (
                  <li key={`${doc.path}_${idx}`} className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-surface-50">
                    <a
                      href={getHRFileUrl(BUCKET, doc.path)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex min-w-0 items-center gap-2 text-sm font-medium text-emerald-700 hover:underline"
                      title="เปิด/ดาวน์โหลดเอกสาร"
                    >
                      <FiDownload className="shrink-0" />
                      <span className="truncate">{doc.name}</span>
                    </a>
                    <button type="button" onClick={() => removeExistingDoc(idx)} title="ลบเอกสาร" className="shrink-0 rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600">
                      <FiTrash2 />
                    </button>
                  </li>
                ))}
                {newDocFiles.map((file, idx) => (
                  <li key={`${file.name}_${idx}`} className="flex items-center justify-between gap-2 px-4 py-3">
                    <div className="flex min-w-0 items-center gap-2 text-sm text-gray-600">
                      <FiUpload className="shrink-0" />
                      <span className="truncate">{file.name}</span>
                      <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">รออัปโหลด</span>
                    </div>
                    <button type="button" onClick={() => removePendingDoc(idx)} title="เอาออก" className="shrink-0 rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600">
                      <FiX />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setFormOpen(false)} className="rounded-xl border border-surface-200 px-4 py-2 hover:bg-surface-100">ยกเลิก</button>
            <button onClick={handleSave} disabled={saving} className="rounded-xl bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              {saving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
        </div>
      </Modal>

      {previewIndex !== null && galleryUrls[previewIndex] && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreviewIndex(null)}
        >
          <button
            type="button"
            onClick={() => setPreviewIndex(null)}
            title="ปิด"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/25"
          >
            <FiX className="h-6 w-6" />
          </button>

          {galleryUrls.length > 1 && (
            <>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); showPrevImage() }}
                title="รูปก่อนหน้า (←)"
                className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/25"
              >
                <FiChevronLeft className="h-7 w-7" />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); showNextImage() }}
                title="รูปถัดไป (→)"
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/25"
              >
                <FiChevronRight className="h-7 w-7" />
              </button>
              <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-sm text-white">
                {previewIndex + 1} / {galleryUrls.length}
              </span>
            </>
          )}

          <img
            src={galleryUrls[previewIndex]}
            alt="ดูรูปขนาดใหญ่"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[70vh] w-auto max-w-[90vw] object-contain rounded-lg shadow-2xl sm:max-w-md"
          />
        </div>,
        document.body
      )}
    </div>
  )
}
