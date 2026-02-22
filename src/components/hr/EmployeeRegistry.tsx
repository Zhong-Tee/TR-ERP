import { useState, useEffect, useCallback } from 'react'
import { FiSearch, FiPlus, FiEdit2, FiTrash2, FiUsers } from 'react-icons/fi'
import {
  fetchEmployees,
  fetchDepartments,
  deleteEmployee,
  getHRFileUrl,
} from '../../lib/hrApi'
import type { HREmployee, HRDepartment } from '../../types'
import Modal from '../ui/Modal'
import EmployeeForm from './EmployeeForm'

const BUCKET_PHOTOS = 'hr-photos'

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
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">รหัส</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">ชื่อ-นามสกุล</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">ชื่อเล่น</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">แผนก</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">ตำแหน่ง</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">สถานะ</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">วันที่เข้างาน</th>
                  <th className="text-right py-3 px-4 text-sm font-semibold text-gray-700 w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-gray-500">
                      ไม่พบพนักงาน
                    </td>
                  </tr>
                ) : (
                  filtered.map((emp) => (
                    <tr
                      key={emp.id}
                      className="border-b border-gray-100 hover:bg-emerald-50/50 transition"
                    >
                      <td className="py-3 px-4 text-sm text-gray-900">{emp.employee_code}</td>
                      <td className="py-3 px-4">
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
                      <td className="py-3 px-4 text-sm text-gray-600">{emp.nickname ?? '-'}</td>
                      <td className="py-3 px-4 text-sm text-gray-600">
                        {(emp.department as HRDepartment)?.name ?? '-'}
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-600">
                        {(emp.position as { name?: string })?.name ?? '-'}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${getStatusBadgeClass(
                            emp.employment_status
                          )}`}
                        >
                          {getStatusLabel(emp.employment_status)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-600">
                        {emp.hire_date
                          ? new Date(emp.hire_date).toLocaleDateString('th-TH')
                          : '-'}
                      </td>
                      <td className="py-3 px-4 text-right">
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

      <Modal open={modalOpen} onClose={handleCloseModal} contentClassName="max-w-4xl">
        <EmployeeForm
          employee={editingEmployee}
          onSave={handleSave}
          onClose={handleCloseModal}
        />
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
    </div>
  )
}
