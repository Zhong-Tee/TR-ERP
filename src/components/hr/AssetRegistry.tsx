import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { FiChevronLeft, FiChevronRight, FiEdit2, FiPlus, FiSearch, FiTrash2, FiUpload, FiX } from 'react-icons/fi'
import {
  deleteAsset,
  fetchAssets,
  fetchDepartments,
  fetchEmployees,
  getHRFileUrl,
  peekNextAssetCode,
  uploadHRFile,
  upsertAsset,
} from '../../lib/hrApi'
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
  notes: string
}

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
  // รูปที่กำลังเปิดดูแบบขยาย (lightbox) — null = ไม่เปิด, ค่าอื่นคือ index ในแกลเลอรีรวม
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)

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
      notes: asset.notes ?? '',
    }))
    setNewImageFiles([])
    setError(null)
    setFormOpen(true)
  }

  const handleAddImageFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    setNewImageFiles((prev) => [...prev, ...Array.from(files)])
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

  const handleSave = async () => {
    const missing = missingRequiredLabels(form)
    if (missing.length > 0) {
      setError(`กรุณากรอกข้อมูลให้ครบ: ${missing.join(', ')}`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const uploadedPaths: string[] = []
      for (const file of newImageFiles) {
        const path = `assets/${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${file.name}`
        await uploadHRFile(BUCKET, path, file)
        uploadedPaths.push(path)
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
        images: [...form.images, ...uploadedPaths],
        notes: form.notes.trim() || undefined,
      })
      setFormOpen(false)
      setForm(EMPTY_FORM)
      setNewImageFiles([])
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
      await loadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบทรัพย์สินไม่สำเร็จ')
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
          <button onClick={openCreate} className="ml-auto inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
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
                <th className="px-4 py-3 font-semibold text-gray-700">มูลค่าปัจจุบัน</th>
                <th className="px-4 py-3 font-semibold text-gray-700">สถานะ</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-700">จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {filteredAssets.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-500">ยังไม่มีข้อมูลทรัพย์สิน</td>
                </tr>
              ) : filteredAssets.map((asset) => (
                <tr key={asset.id} className="border-b border-surface-100 hover:bg-surface-50">
                  <td className="px-4 py-3 font-mono text-xs">{asset.asset_code ?? '-'}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{asset.name}</div>
                    <div className="text-xs text-gray-500">{asset.category ?? '-'} · {asset.location ?? '-'}</div>
                  </td>
                  <td className="px-4 py-3">{asset.department?.name ?? '-'}</td>
                  <td className="px-4 py-3">
                    {asset.assigned_employee
                      ? [asset.assigned_employee.first_name, asset.assigned_employee.last_name].filter(Boolean).join(' ')
                      : '-'}
                  </td>
                  <td className="px-4 py-3">{asset.current_value != null ? `${Number(asset.current_value).toLocaleString()} บาท` : '-'}</td>
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
