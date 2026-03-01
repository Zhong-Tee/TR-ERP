import { useCallback, useEffect, useMemo, useState } from 'react'
import { FiEdit2, FiImage, FiPlus, FiSearch, FiTrash2, FiUpload, FiX } from 'react-icons/fi'
import {
  deleteAsset,
  fetchAssets,
  fetchDepartments,
  fetchEmployees,
  getHRFileUrl,
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
  description: string
  department_id: string
  location: string
  purchase_date: string
  purchase_cost: string
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
  description: '',
  department_id: '',
  location: '',
  purchase_date: '',
  purchase_cost: '',
  current_value: '',
  status: 'active',
  assigned_employee_id: '',
  images: [],
  notes: '',
}

const STATUS_META: Record<HRAsset['status'], { label: string; chip: string }> = {
  active: { label: 'ใช้งาน', chip: 'bg-emerald-100 text-emerald-700' },
  maintenance: { label: 'ซ่อมบำรุง', chip: 'bg-amber-100 text-amber-700' },
  retired: { label: 'ปลดระวาง', chip: 'bg-gray-100 text-gray-700' },
  lost: { label: 'สูญหาย', chip: 'bg-red-100 text-red-700' },
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
        a.location,
        a.assigned_employee?.first_name,
        a.assigned_employee?.last_name,
      ].filter(Boolean).join(' ').toLowerCase()
      return text.includes(q)
    })
  }, [assets, search, statusFilter, departmentFilter, assignedFilter])

  const stats = useMemo(() => {
    const active = assets.filter((a) => a.status === 'active').length
    const maintenance = assets.filter((a) => a.status === 'maintenance').length
    const assigned = assets.filter((a) => !!a.assigned_employee_id).length
    const totalValue = assets.reduce((sum, a) => sum + (Number(a.current_value) || 0), 0)
    return { active, maintenance, assigned, totalValue }
  }, [assets])

  const openCreate = () => {
    setForm(EMPTY_FORM)
    setNewImageFiles([])
    setError(null)
    setFormOpen(true)
  }

  const openEdit = (asset: HRAsset) => {
    setForm({
      id: asset.id,
      asset_code: asset.asset_code ?? '',
      name: asset.name ?? '',
      category: asset.category ?? '',
      description: asset.description ?? '',
      department_id: asset.department_id ?? '',
      location: asset.location ?? '',
      purchase_date: asset.purchase_date ?? '',
      purchase_cost: asset.purchase_cost == null ? '' : String(asset.purchase_cost),
      current_value: asset.current_value == null ? '' : String(asset.current_value),
      status: asset.status ?? 'active',
      assigned_employee_id: asset.assigned_employee_id ?? '',
      images: Array.isArray(asset.images) ? [...asset.images] : [],
      notes: asset.notes ?? '',
    })
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
    if (!form.name.trim()) {
      setError('กรุณาระบุชื่อทรัพย์สิน')
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
        asset_code: form.asset_code.trim() || undefined,
        name: form.name.trim(),
        category: form.category.trim() || undefined,
        description: form.description.trim() || undefined,
        department_id: form.department_id || undefined,
        location: form.location.trim() || undefined,
        purchase_date: form.purchase_date || undefined,
        purchase_cost: form.purchase_cost.trim() === '' ? undefined : Number(form.purchase_cost),
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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs text-emerald-700">ใช้งานอยู่</p>
          <p className="mt-1 text-2xl font-bold text-emerald-800">{stats.active}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs text-amber-700">ซ่อมบำรุง</p>
          <p className="mt-1 text-2xl font-bold text-amber-800">{stats.maintenance}</p>
        </div>
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-xs text-blue-700">มอบหมายแล้ว</p>
          <p className="mt-1 text-2xl font-bold text-blue-800">{stats.assigned}</p>
        </div>
        <div className="rounded-xl border border-surface-200 bg-white p-4">
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
              placeholder="ค้นหาโค้ดทรัพย์สิน / ชื่อ / หมวดหมู่ / สถานที่"
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
            <option value="">ผู้ดูแลทั้งหมด</option>
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
                <th className="px-4 py-3 font-semibold text-gray-700">ผู้ดูแล</th>
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
              <input value={form.asset_code} onChange={(e) => setForm((p) => ({ ...p, asset_code: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">ชื่อทรัพย์สิน *</span>
              <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">หมวดหมู่</span>
              <input value={form.category} onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">แผนก</span>
              <select value={form.department_id} onChange={(e) => setForm((p) => ({ ...p, department_id: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2">
                <option value="">-- เลือกแผนก --</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">สถานที่จัดเก็บ</span>
              <input value={form.location} onChange={(e) => setForm((p) => ({ ...p, location: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">สถานะ</span>
              <select value={form.status} onChange={(e) => setForm((p) => ({ ...p, status: e.target.value as HRAsset['status'] }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2">
                {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">วันที่ซื้อ</span>
              <input type="date" value={form.purchase_date} onChange={(e) => setForm((p) => ({ ...p, purchase_date: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">มูลค่าตอนซื้อ</span>
              <input type="number" min={0} value={form.purchase_cost} onChange={(e) => setForm((p) => ({ ...p, purchase_cost: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">มูลค่าปัจจุบัน</span>
              <input type="number" min={0} value={form.current_value} onChange={(e) => setForm((p) => ({ ...p, current_value: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm md:col-span-2">
              <span className="text-gray-600">มอบหมายผู้ดูแลทรัพย์สิน</span>
              <select value={form.assigned_employee_id} onChange={(e) => setForm((p) => ({ ...p, assigned_employee_id: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2">
                <option value="">-- ไม่ระบุ --</option>
                {employees.map((emp) => <option key={emp.id} value={emp.id}>{employeeLabel(emp)}</option>)}
              </select>
            </label>
            <label className="block text-sm md:col-span-2">
              <span className="text-gray-600">รายละเอียด</span>
              <textarea value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} rows={3} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm md:col-span-2">
              <span className="text-gray-600">หมายเหตุเพิ่มเติม</span>
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
              {form.images.map((path, idx) => (
                <div key={`${path}_${idx}`} className="relative overflow-hidden rounded-lg border border-surface-200 bg-white">
                  <img src={getHRFileUrl(BUCKET, path)} alt="asset" className="h-28 w-full object-cover" />
                  <button type="button" onClick={() => removeExistingImage(idx)} className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white hover:bg-black/80">
                    <FiX className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {newImageFiles.map((file, idx) => (
                <div key={`${file.name}_${idx}`} className="relative flex h-28 items-center justify-center rounded-lg border border-dashed border-surface-300 bg-white text-xs text-gray-600">
                  <div className="px-2 text-center">
                    <FiImage className="mx-auto mb-1 h-4 w-4" />
                    <p className="line-clamp-2">{file.name}</p>
                  </div>
                  <button type="button" onClick={() => removePendingImage(idx)} className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white hover:bg-black/80">
                    <FiX className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
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
    </div>
  )
}
