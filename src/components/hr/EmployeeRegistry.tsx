import { useState, useEffect, useCallback, useRef } from 'react'
import type { ChangeEvent } from 'react'
import { FiSearch, FiPlus, FiEdit2, FiTrash2, FiUsers, FiDownload, FiUpload, FiX } from 'react-icons/fi'
import * as XLSX from 'xlsx'
import {
  fetchEmployees,
  fetchDepartments,
  fetchPositions,
  upsertEmployee,
  deleteEmployee,
  getHRFileUrl,
} from '../../lib/hrApi'
import { supabase } from '../../lib/supabase'
import type { HREmployee, HRDepartment, HRPosition } from '../../types'
import Modal from '../ui/Modal'
import EmployeeForm from './EmployeeForm'
import SalaryHistoryPanel from './SalaryHistoryPanel'
import { useWmsModal } from '../wms/useWmsModal'

const BUCKET_PHOTOS = 'hr-photos'

type EmployeeTemplateRow = Record<string, unknown>
type AddressField = 'house_no' | 'moo' | 'trok' | 'soi' | 'road' | 'tambon' | 'amphoe' | 'province' | 'postal_code'

const EMPLOYEE_TEMPLATE_HEADERS = [
  'รหัสพนักงาน',
  'คำนำหน้า',
  'ชื่อ *',
  'นามสกุล *',
  'ชื่อ (อังกฤษ)',
  'นามสกุล (อังกฤษ)',
  'ชื่อเล่น',
  'เลขบัตรประชาชน',
  'วันเกิด',
  'เพศ',
  'ศาสนา',
  'สัญชาติ',
  'โทรศัพท์',
  'แผนก',
  'ตำแหน่ง',
  'วันที่เข้างาน',
  'วันสิ้นสุดทดลองงาน',
  'ฐานเงินเดือน',
  'เงินพิเศษ/ประจำตำแหน่ง',
  'สถานะการจ้าง',
  'ประเภทสัญญาจ้าง',
  'Telegram Chat ID',
  'ชื่อผู้ติดต่อฉุกเฉิน',
  'โทรศัพท์ผู้ติดต่อฉุกเฉิน',
  'ความสัมพันธ์ผู้ติดต่อฉุกเฉิน',
  'ชื่อผู้ติดต่อฉุกเฉิน 2',
  'โทรศัพท์ผู้ติดต่อฉุกเฉิน 2',
  'ความสัมพันธ์ผู้ติดต่อฉุกเฉิน 2',
  'บ้านเลขที่ (ตามบัตร)',
  'หมู่ (ตามบัตร)',
  'ตรอก (ตามบัตร)',
  'ซอย (ตามบัตร)',
  'ถนน (ตามบัตร)',
  'ตำบล/แขวง (ตามบัตร)',
  'อำเภอ/เขต (ตามบัตร)',
  'จังหวัด (ตามบัตร)',
  'รหัสไปรษณีย์ (ตามบัตร)',
  'บ้านเลขที่ (ปัจจุบัน)',
  'หมู่ (ปัจจุบัน)',
  'ตรอก (ปัจจุบัน)',
  'ซอย (ปัจจุบัน)',
  'ถนน (ปัจจุบัน)',
  'ตำบล/แขวง (ปัจจุบัน)',
  'อำเภอ/เขต (ปัจจุบัน)',
  'จังหวัด (ปัจจุบัน)',
  'รหัสไปรษณีย์ (ปัจจุบัน)',
] as const

const EMPLOYEE_TEMPLATE_SAMPLE_ROW = [
  'EMP001',
  'นาย',
  'สมชาย',
  'ใจดี',
  'Somchai',
  'Jaidee',
  'ตี๋',
  '1234567890123',
  '1990-01-31',
  'ชาย',
  'พุทธ',
  'ไทย',
  '0812345678',
  'คลังสินค้า',
  'พนักงานคลัง',
  '2026-01-01',
  '2026-04-01',
  15000,
  2000,
  'active',
  'permanent',
  '',
  'สมศรี ใจดี',
  '0899999999',
  'มารดา',
  'สมปอง ใจดี',
  '0888888888',
  'บิดา',
  '99/9',
  '1',
  '',
  '',
  'สุขุมวิท',
  'บางนา',
  'บางนา',
  'กรุงเทพมหานคร',
  '10260',
  '88/8',
  '',
  '',
  '5',
  'เพชรเกษม',
  'หลักสอง',
  'บางแค',
  'กรุงเทพมหานคร',
  '10160',
] as const

function photoDisplayUrl(photoUrl: string | undefined): string | null {
  if (!photoUrl) return null
  if (photoUrl.startsWith('http')) return photoUrl
  return getHRFileUrl(BUCKET_PHOTOS, photoUrl)
}

function getStatusBadgeClass(status: HREmployee['employment_status']): string {
  switch (status) {
    case 'active':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    case 'probation':
      return 'bg-amber-100 text-amber-800 border-amber-200'
    case 'resigned':
      return 'bg-gray-100 text-gray-700 border-gray-200'
    case 'terminated':
      return 'bg-red-100 text-red-800 border-red-200'
    default:
      return 'bg-gray-100 text-gray-600 border-gray-200'
  }
}

function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: 'ปฏิบัติงาน',
    probation: 'ทดลองงาน',
    resigned: 'ลาออก',
    terminated: 'ถูกเลิกจ้าง',
  }
  return labels[status] ?? status
}

function getContractTypeLabel(t: HREmployee['contract_type']): string {
  if (t === 'daily') return 'รายวัน'
  return 'ประจำ'
}

function getTenureLabel(hireDate?: string): string {
  if (!hireDate) return '-'
  const start = new Date(`${hireDate}T00:00:00`)
  if (Number.isNaN(start.getTime())) return '-'

  const now = new Date()
  if (start > now) return 'ยังไม่เริ่มงาน'

  let years = now.getFullYear() - start.getFullYear()
  let months = now.getMonth() - start.getMonth()
  let days = now.getDate() - start.getDate()

  if (days < 0) {
    months -= 1
    const prevMonthDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate()
    days += prevMonthDays
  }

  if (months < 0) {
    years -= 1
    months += 12
  }

  const parts: string[] = []
  if (years > 0) parts.push(`${years} ปี`)
  if (months > 0) parts.push(`${months} เดือน`)
  if (days > 0 || parts.length === 0) parts.push(`${days} วัน`)
  return parts.join(' ')
}

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

function formatExcelDate(value: unknown): string | undefined {
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
  const normalized = text.replace(/\//g, '-')
  const date = new Date(`${normalized}T00:00:00`)
  if (!Number.isNaN(date.getTime()) && /^\d{4}-\d{1,2}-\d{1,2}$/.test(normalized)) {
    return date.toISOString().slice(0, 10)
  }
  return text
}

function getEmploymentStatus(value: unknown): HREmployee['employment_status'] {
  const text = normalizeLookup(value)
  if (text === 'ทดลองงาน' || text === 'probation') return 'probation'
  if (text === 'ลาออก' || text === 'resigned') return 'resigned'
  if (text === 'ถูกเลิกจ้าง' || text === 'terminated') return 'terminated'
  return 'active'
}

function getContractType(value: unknown): HREmployee['contract_type'] {
  const text = normalizeLookup(value)
  if (text === 'รายวัน' || text === 'daily') return 'daily'
  return 'permanent'
}

function findDepartmentId(row: EmployeeTemplateRow, departments: HRDepartment[]): string | undefined {
  const departmentName = normalizeLookup(row['แผนก'])
  if (!departmentName) return undefined
  return departments.find((department) => normalizeLookup(department.name) === departmentName)?.id
}

function findPositionId(row: EmployeeTemplateRow, positions: HRPosition[], departmentId?: string): string | undefined {
  const positionName = normalizeLookup(row['ตำแหน่ง'])
  if (!positionName) return undefined
  const candidates = positions.filter((position) => normalizeLookup(position.name) === positionName)
  return candidates.find((position) => !departmentId || position.department_id === departmentId)?.id ?? candidates[0]?.id
}

const ADDRESS_FIELD_KEYS: readonly AddressField[] = [
  'house_no',
  'moo',
  'trok',
  'soi',
  'road',
  'tambon',
  'amphoe',
  'province',
  'postal_code',
]

const ADDRESS_FIELD_LABELS: Record<AddressField, string> = {
  house_no: 'บ้านเลขที่',
  moo: 'หมู่',
  trok: 'ตรอก',
  soi: 'ซอย',
  road: 'ถนน',
  tambon: 'ตำบล/แขวง',
  amphoe: 'อำเภอ/เขต',
  province: 'จังหวัด',
  postal_code: 'รหัสไปรษณีย์',
}

/** อ่านที่อยู่จากแถว โดย suffix = ' (ตามบัตร)' หรือ ' (ปัจจุบัน)' */
function buildAddressWithSuffix(
  row: EmployeeTemplateRow,
  suffix: string
): Record<string, string> | undefined {
  const address = ADDRESS_FIELD_KEYS.reduce<Record<string, string>>((acc, key) => {
    const value = normalizeText(row[`${ADDRESS_FIELD_LABELS[key]}${suffix}`])
    if (value) acc[key] = value
    return acc
  }, {})

  return Object.keys(address).length ? address : undefined
}

function buildEmployeePayload(
  row: EmployeeTemplateRow,
  departments: HRDepartment[],
  positions: HRPosition[],
  existingEmployee?: HREmployee
): Partial<HREmployee> {
  const departmentId = findDepartmentId(row, departments)
  const positionId = findPositionId(row, positions, departmentId)
  const emergencyName = normalizeText(row['ชื่อผู้ติดต่อฉุกเฉิน'])
  const emergencyPhone = normalizeText(row['โทรศัพท์ผู้ติดต่อฉุกเฉิน'])
  const emergencyRelationship = normalizeText(row['ความสัมพันธ์ผู้ติดต่อฉุกเฉิน'])
  const emergencyName2 = normalizeText(row['ชื่อผู้ติดต่อฉุกเฉิน 2'])
  const emergencyPhone2 = normalizeText(row['โทรศัพท์ผู้ติดต่อฉุกเฉิน 2'])
  const emergencyRelationship2 = normalizeText(row['ความสัมพันธ์ผู้ติดต่อฉุกเฉิน 2'])
  // รองรับทั้งหัวคอลัมน์ใหม่ 'ฐานเงินเดือน' และ template เก่าที่ใช้ 'เงินเดือน'
  const salaryText = normalizeText(row['ฐานเงินเดือน'] ?? row['เงินเดือน']).replace(/,/g, '')
  const salary = salaryText ? Number(salaryText) : undefined
  const allowanceText = normalizeText(row['เงินพิเศษ/ประจำตำแหน่ง']).replace(/,/g, '')
  const positionAllowance = allowanceText ? Number(allowanceText) : undefined

  return {
    id: existingEmployee?.id,
    employee_code: optionalText(row['รหัสพนักงาน']),
    prefix: optionalText(row['คำนำหน้า']),
    first_name: normalizeText(row['ชื่อ *']),
    last_name: normalizeText(row['นามสกุล *']),
    first_name_en: optionalText(row['ชื่อ (อังกฤษ)']),
    last_name_en: optionalText(row['นามสกุล (อังกฤษ)']),
    nickname: optionalText(row['ชื่อเล่น']),
    citizen_id: optionalText(row['เลขบัตรประชาชน']),
    birth_date: formatExcelDate(row['วันเกิด']),
    gender: optionalText(row['เพศ']),
    religion: optionalText(row['ศาสนา']),
    nationality: optionalText(row['สัญชาติ']),
    phone: optionalText(row['โทรศัพท์']),
    emergency_contact:
      emergencyName || emergencyPhone || emergencyRelationship
        ? { name: emergencyName, phone: emergencyPhone, relationship: emergencyRelationship }
        : undefined,
    emergency_contact_2:
      emergencyName2 || emergencyPhone2 || emergencyRelationship2
        ? { name: emergencyName2, phone: emergencyPhone2, relationship: emergencyRelationship2 }
        : undefined,
    address: buildAddressWithSuffix(row, ' (ตามบัตร)'),
    current_address: buildAddressWithSuffix(row, ' (ปัจจุบัน)'),
    department_id: departmentId,
    position_id: positionId,
    hire_date: formatExcelDate(row['วันที่เข้างาน']),
    probation_end_date: formatExcelDate(row['วันสิ้นสุดทดลองงาน']),
    salary: Number.isFinite(salary) ? salary : undefined,
    position_allowance: Number.isFinite(positionAllowance) ? positionAllowance : undefined,
    employment_status: getEmploymentStatus(row['สถานะการจ้าง']),
    contract_type: getContractType(row['ประเภทสัญญาจ้าง']),
    telegram_chat_id: optionalText(row['Telegram Chat ID']),
  }
}

function downloadEmployeeRegistryTemplate() {
  const workbook = XLSX.utils.book_new()

  const employeeRows = [Array.from(EMPLOYEE_TEMPLATE_HEADERS)]

  const employeeSheet = XLSX.utils.aoa_to_sheet(employeeRows)
  employeeSheet['!cols'] = employeeRows[0].map((header) => ({
    wch: Math.max(String(header).length + 4, 16),
  }))
  XLSX.utils.book_append_sheet(workbook, employeeSheet, 'ทะเบียนพนักงาน')

  const sampleSheet = XLSX.utils.aoa_to_sheet([
    Array.from(EMPLOYEE_TEMPLATE_HEADERS),
    Array.from(EMPLOYEE_TEMPLATE_SAMPLE_ROW),
  ])
  sampleSheet['!cols'] = employeeRows[0].map((header) => ({
    wch: Math.max(String(header).length + 4, 16),
  }))
  XLSX.utils.book_append_sheet(workbook, sampleSheet, 'ตัวอย่าง')

  const instructionRows = [
    ['หัวข้อ', 'รายละเอียด'],
    ['ช่องที่มี *', 'ต้องกรอกข้อมูลก่อน import'],
    ['รูปแบบวันที่', 'ใช้รูปแบบ YYYY-MM-DD เช่น 2026-01-31'],
    ['สถานะการจ้าง', 'active = ปฏิบัติงาน, probation = ทดลองงาน, resigned = ลาออก, terminated = ถูกเลิกจ้าง'],
    ['ประเภทสัญญาจ้าง', 'permanent = ประจำ, daily = รายวัน'],
    ['ฐานเงินเดือน / เงินพิเศษ', 'กรอกเป็นตัวเลข เช่น 15000 — ระบบจะนำ 2 ช่องนี้บวกกันแสดงในหน้ารายการ (template เก่าที่ใช้หัวคอลัมน์ "เงินเดือน" ยังนำเข้าได้ โดยถือเป็นฐานเงินเดือน)'],
    ['แผนก/ตำแหน่ง', 'กรอกชื่อให้ตรงกับข้อมูลในระบบ หรือเว้นว่างไว้หากยังไม่ระบุ'],
    ['ที่อยู่', 'มี 2 ชุด: (ตามบัตร) = ที่อยู่ตามบัตรประชาชน, (ปัจจุบัน) = ที่อยู่ที่พักอาศัยจริง'],
    ['ผู้ติดต่อฉุกเฉิน', 'กรอกได้สูงสุด 2 คน (ชุดที่ 2 ลงท้ายด้วย " 2")'],
    ['รหัสพนักงาน', 'กรอกเมื่อต้องการกำหนดเอง หากเว้นว่างระบบ import อาจสร้างตามลำดับที่กำหนดไว้'],
    ['Sheet ที่นำเข้า', 'ระบบจะอ่านเฉพาะ sheet ชื่อ ทะเบียนพนักงาน'],
  ]
  const instructionSheet = XLSX.utils.aoa_to_sheet(instructionRows)
  instructionSheet['!cols'] = [{ wch: 24 }, { wch: 90 }]
  XLSX.utils.book_append_sheet(workbook, instructionSheet, 'คำอธิบาย')

  XLSX.writeFile(workbook, 'Template_ทะเบียนพนักงาน.xlsx')
}

export default function EmployeeRegistry() {
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [departments, setDepartments] = useState<HRDepartment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filterDept, setFilterDept] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingEmployee, setEditingEmployee] = useState<HREmployee | undefined>(undefined)
  const [deleteConfirm, setDeleteConfirm] = useState<HREmployee | null>(null)
  const [salaryHistoryEmp, setSalaryHistoryEmp] = useState<HREmployee | null>(null)
  const [importing, setImporting] = useState(false)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const { showConfirm, showMessage, ConfirmModal, MessageModal } = useWmsModal()

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [empRes, deptRes] = await Promise.all([
        fetchEmployees({
          ...(filterDept && { department_id: filterDept }),
          ...(filterStatus && { status: filterStatus }),
        }),
        fetchDepartments(),
      ])
      setEmployees(empRes)
      setDepartments(deptRes)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [filterDept, filterStatus])

  useEffect(() => {
    loadData()
  }, [loadData])

  const filtered = employees.filter((emp) => {
    if (!search.trim()) return true
    const q = search.toLowerCase().trim()
    const name = `${emp.first_name} ${emp.last_name}`.toLowerCase()
    const nickname = (emp.nickname ?? '').toLowerCase()
    const code = (emp.employee_code ?? '').toLowerCase()
    return name.includes(q) || nickname.includes(q) || code.includes(q)
  })

  const stats = {
    total: employees.length,
    active: employees.filter((e) => e.employment_status === 'active').length,
    probation: employees.filter((e) => e.employment_status === 'probation').length,
    resigned: employees.filter((e) => e.employment_status === 'resigned').length,
  }

  const handleAdd = () => {
    setEditingEmployee(undefined)
    setModalOpen(true)
  }

  const handleEdit = (emp: HREmployee) => {
    setEditingEmployee(emp)
    setModalOpen(true)
  }

  const handleSave = () => {
    setModalOpen(false)
    setEditingEmployee(undefined)
    loadData()
  }

  const handleCloseModal = () => {
    setModalOpen(false)
    setEditingEmployee(undefined)
    loadData()
  }

  const handleDeleteClick = (emp: HREmployee) => setDeleteConfirm(emp)
  const handleDeleteCancel = () => setDeleteConfirm(null)

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return
    try {
      await deleteEmployee(deleteConfirm.id)
      setDeleteConfirm(null)
      loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบไม่สำเร็จ')
    }
  }

  const handleImportClick = () => {
    importInputRef.current?.click()
  }

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setImporting(true)
    setError(null)
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const worksheet = workbook.Sheets['ทะเบียนพนักงาน'] ?? workbook.Sheets[workbook.SheetNames[0]]
      if (!worksheet) throw new Error('ไม่พบ sheet สำหรับนำเข้าข้อมูล')

      const rows = XLSX.utils.sheet_to_json<EmployeeTemplateRow>(worksheet, { defval: '' })
        .filter((row) => EMPLOYEE_TEMPLATE_HEADERS.some((header) => normalizeText(row[header])))

      if (rows.length === 0) {
        showMessage({ message: 'ไม่พบข้อมูลพนักงานในไฟล์ import' })
        return
      }

      const [allEmployees, allDepartments, allPositions] = await Promise.all([
        fetchEmployees(),
        fetchDepartments(),
        fetchPositions(),
      ])
      const existingByCode = new Map(
        allEmployees
          .filter((employee) => employee.employee_code)
          .map((employee) => [normalizeLookup(employee.employee_code), employee])
      )
      const departmentNames = new Set(allDepartments.map((department) => normalizeLookup(department.name)))
      const positionNames = new Set(allPositions.map((position) => normalizeLookup(position.name)))
      const errors: string[] = []

      rows.forEach((row, index) => {
        const rowNumber = index + 2
        if (!normalizeText(row['ชื่อ *'])) errors.push(`แถว ${rowNumber}: กรุณากรอกชื่อ`)
        if (!normalizeText(row['นามสกุล *'])) errors.push(`แถว ${rowNumber}: กรุณากรอกนามสกุล`)

        const departmentName = normalizeLookup(row['แผนก'])
        if (departmentName && !departmentNames.has(departmentName)) {
          errors.push(`แถว ${rowNumber}: ไม่พบแผนก "${normalizeText(row['แผนก'])}"`)
        }

        const positionName = normalizeLookup(row['ตำแหน่ง'])
        if (positionName && !positionNames.has(positionName)) {
          errors.push(`แถว ${rowNumber}: ไม่พบตำแหน่ง "${normalizeText(row['ตำแหน่ง'])}"`)
        }
      })

      if (errors.length > 0) {
        const more = errors.length > 8 ? `\n...และอีก ${errors.length - 8} รายการ` : ''
        showMessage({ title: 'นำเข้าไม่สำเร็จ', message: `${errors.slice(0, 8).join('\n')}${more}` })
        return
      }

      const confirmed = await showConfirm({
        title: 'ยืนยันการนำเข้า',
        message: `ต้องการนำเข้าข้อมูลทะเบียนพนักงาน ${rows.length} รายการใช่หรือไม่?\nหากรหัสพนักงานซ้ำ ระบบจะอัปเดตข้อมูลเดิม`,
        confirmText: 'นำเข้า',
      })
      if (!confirmed) return

      let created = 0
      let updated = 0
      const createdIds: string[] = []
      for (const row of rows) {
        const code = normalizeLookup(row['รหัสพนักงาน'])
        const existingEmployee = code ? existingByCode.get(code) : undefined
        const savedEmp = await upsertEmployee(buildEmployeePayload(row, allDepartments, allPositions, existingEmployee))
        if (existingEmployee) {
          updated += 1
        } else {
          created += 1
          if (savedEmp?.id) createdIds.push(savedEmp.id)
        }
      }

      // พนักงานเข้าใหม่จากการ Import → แจ้ง Telegram กลุ่ม HR เป็นข้อความสรุปฉบับเดียว
      if (createdIds.length > 0) {
        supabase.functions.invoke('hr-employee-notify', { body: { employee_ids: createdIds } }).catch(() => {})
      }

      await loadData()
      showMessage({
        title: 'นำเข้าสำเร็จ',
        message: `เพิ่มใหม่ ${created} รายการ\nอัปเดต ${updated} รายการ`,
      })
    } catch (e) {
      showMessage({ title: 'นำเข้าไม่สำเร็จ', message: e instanceof Error ? e.message : 'เกิดข้อผิดพลาดระหว่างนำเข้า' })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-6 mt-4">
      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-soft border border-gray-100 p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <FiUsers className="text-emerald-600" />
            <span>ทั้งหมด</span>
          </div>
          <div className="text-2xl font-bold text-emerald-700">{stats.total}</div>
        </div>
        <div className="bg-white rounded-xl shadow-soft border border-gray-100 p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>ปฏิบัติงาน</span>
          </div>
          <div className="text-2xl font-bold text-emerald-700">{stats.active}</div>
        </div>
        <div className="bg-white rounded-xl shadow-soft border border-gray-100 p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            <span>ทดลองงาน</span>
          </div>
          <div className="text-2xl font-bold text-amber-700">{stats.probation}</div>
        </div>
        <div className="bg-white rounded-xl shadow-soft border border-gray-100 p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <span className="w-2 h-2 rounded-full bg-gray-400" />
            <span>ลาออก</span>
          </div>
          <div className="text-2xl font-bold text-gray-600">{stats.resigned}</div>
        </div>
      </div>

      {/* Filters + Table card */}
      <div className="bg-white rounded-xl shadow-soft border border-gray-100 overflow-hidden">
        <div className="p-4 border-b border-gray-100 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="ค้นหาชื่อ, รหัส, ชื่อเล่น..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
            />
          </div>
          <select
            value={filterDept}
            onChange={(e) => setFilterDept(e.target.value)}
            className="px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
          >
            <option value="">ทุกแผนก</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
          >
            <option value="">ทุกสถานะ</option>
            <option value="active">ปฏิบัติงาน</option>
            <option value="probation">ทดลองงาน</option>
            <option value="resigned">ลาออก</option>
            <option value="terminated">ถูกเลิกจ้าง</option>
          </select>
          <button
            type="button"
            onClick={downloadEmployeeRegistryTemplate}
            className="inline-flex items-center gap-2 px-4 py-2 border border-emerald-200 bg-white text-emerald-700 rounded-lg font-medium hover:bg-emerald-50 transition"
          >
            <FiDownload />
            Template ทะเบียนพนักงาน
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
            className="inline-flex items-center gap-2 px-4 py-2 border border-emerald-200 bg-white text-emerald-700 rounded-lg font-medium hover:bg-emerald-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FiUpload />
            {importing ? 'กำลัง Import...' : 'Import'}
          </button>
          <button
            type="button"
            onClick={handleAdd}
            className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition"
          >
            <FiPlus />
            เพิ่มพนักงาน
          </button>
        </div>

        {error && (
          <div className="mx-4 mt-2 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-600 border-t-transparent" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">รหัส</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">ชื่อ-นามสกุล</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">เบอร์โทร</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">ชื่อเล่น</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">วันเกิด</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">แผนก</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">ตำแหน่ง</th>
                  <th className="text-right py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">เงินเดือน</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">ประเภทสัญญาจ้าง</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">สถานะ</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">วันที่เข้างาน</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap">อายุงาน</th>
                  <th className="text-right py-3 px-3 text-xs font-semibold text-gray-700 whitespace-nowrap w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={13} className="py-12 text-center text-gray-500">
                      ไม่พบพนักงาน
                    </td>
                  </tr>
                ) : (
                  filtered.map((emp) => (
                    <tr
                      key={emp.id}
                      className="border-b border-gray-100 hover:bg-emerald-50/50 transition"
                    >
                      <td className="py-3 px-3 text-sm text-gray-900">{emp.employee_code}</td>
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-2">
                          {photoDisplayUrl(emp.photo_url) ? (
                            <img
                              src={photoDisplayUrl(emp.photo_url)!}
                              alt=""
                              className="w-8 h-8 rounded-full object-cover border border-gray-200"
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-xs">
                              {(emp.first_name?.[0] ?? '?')}
                            </div>
                          )}
                          <span className="text-sm text-gray-900">
                            {emp.prefix} {emp.first_name} {emp.last_name}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-3 text-sm text-gray-600">{emp.phone ?? '-'}</td>
                      <td className="py-3 px-3 text-sm text-gray-600">{emp.nickname ?? '-'}</td>
                      <td className="py-3 px-3 text-sm text-gray-600">
                        {emp.birth_date
                          ? new Date(emp.birth_date).toLocaleDateString('th-TH')
                          : '-'}
                      </td>
                      <td className="py-3 px-3 text-sm text-gray-600">
                        {(emp.department as HRDepartment)?.name ?? '-'}
                      </td>
                      <td className="py-3 px-3 text-sm text-gray-600">
                        {(emp.position as { name?: string })?.name ?? '-'}
                      </td>
                      <td className="py-3 px-3 text-sm text-right tabular-nums">
                        {emp.salary != null || emp.position_allowance != null ? (
                          <button
                            type="button"
                            onClick={() => setSalaryHistoryEmp(emp)}
                            className="font-medium text-emerald-700 hover:text-emerald-800 hover:underline"
                            title={`ฐานเงินเดือน ${Number(emp.salary ?? 0).toLocaleString('th-TH')} + เงินพิเศษ/ประจำตำแหน่ง ${Number(emp.position_allowance ?? 0).toLocaleString('th-TH')} — คลิกดูรายละเอียด`}
                          >
                            {(Number(emp.salary ?? 0) + Number(emp.position_allowance ?? 0)).toLocaleString('th-TH')}
                          </button>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-sm text-gray-600">
                        {getContractTypeLabel(emp.contract_type)}
                      </td>
                      <td className="py-3 px-3">
                        <span
                          className={`inline-flex whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium border ${getStatusBadgeClass(
                            emp.employment_status
                          )}`}
                        >
                          {getStatusLabel(emp.employment_status)}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-sm text-gray-600">
                        {emp.hire_date
                          ? new Date(emp.hire_date).toLocaleDateString('th-TH')
                          : '-'}
                      </td>
                      <td className="py-3 px-3 text-sm text-gray-600">
                        {getTenureLabel(emp.hire_date)}
                      </td>
                      <td className="py-3 px-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => handleEdit(emp)}
                            className="p-2 text-gray-500 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition"
                            title="แก้ไข"
                          >
                            <FiEdit2 />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteClick(emp)}
                            className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                            title="ลบ"
                          >
                            <FiTrash2 />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={handleCloseModal}
        contentClassName="max-w-4xl overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        <EmployeeForm
          employee={editingEmployee}
          onSave={handleSave}
          onClose={handleCloseModal}
        />
      </Modal>

      {/* ประวัติเงินเดือน popup */}
      <Modal
        open={!!salaryHistoryEmp}
        onClose={() => {
          setSalaryHistoryEmp(null)
          loadData()
        }}
        contentClassName="max-w-3xl"
        closeOnBackdropClick
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">
              ประวัติเงินเดือน
              {salaryHistoryEmp && (
                <span className="text-gray-500 font-normal">
                  {' '}— {salaryHistoryEmp.prefix} {salaryHistoryEmp.first_name} {salaryHistoryEmp.last_name}
                </span>
              )}
            </h3>
            <button
              type="button"
              onClick={() => {
                setSalaryHistoryEmp(null)
                loadData()
              }}
              className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              <FiX className="w-5 h-5" />
            </button>
          </div>
          {salaryHistoryEmp && (
            <div className="mb-4 grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                <div className="text-xs text-gray-500 mb-1">ฐานเงินเดือน</div>
                <div className="text-lg font-semibold text-gray-900 tabular-nums">
                  {Number(salaryHistoryEmp.salary ?? 0).toLocaleString('th-TH')}
                </div>
              </div>
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                <div className="text-xs text-gray-500 mb-1">เงินพิเศษ/ประจำตำแหน่ง</div>
                <div className="text-lg font-semibold text-gray-900 tabular-nums">
                  {Number(salaryHistoryEmp.position_allowance ?? 0).toLocaleString('th-TH')}
                </div>
              </div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <div className="text-xs text-emerald-700 mb-1">รวม</div>
                <div className="text-lg font-semibold text-emerald-800 tabular-nums">
                  {(
                    Number(salaryHistoryEmp.salary ?? 0) +
                    Number(salaryHistoryEmp.position_allowance ?? 0)
                  ).toLocaleString('th-TH')}
                </div>
              </div>
            </div>
          )}
          {salaryHistoryEmp && <SalaryHistoryPanel employeeId={salaryHistoryEmp.id} />}
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal
        open={!!deleteConfirm}
        onClose={handleDeleteCancel}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">ยืนยันการลบ</h3>
          <p className="text-gray-600 mb-4">
            คุณต้องการลบพนักงาน{' '}
            <strong>
              {deleteConfirm?.first_name} {deleteConfirm?.last_name}
            </strong>{' '}
            (รหัส {deleteConfirm?.employee_code}) ใช่หรือไม่?
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleDeleteCancel}
              className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={handleDeleteConfirm}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              ลบ
            </button>
          </div>
        </div>
      </Modal>
      {ConfirmModal}
      {MessageModal}
    </div>
  )
}
