import { useState, useEffect, useCallback, useRef } from 'react'
import { FiCalendar, FiPlus, FiCamera, FiUpload } from 'react-icons/fi'
import {
  fetchEmployeeByUserId,
  getEmployeeLeaveSummary,
  createLeaveRequest,
  fetchLeaveTypes,
  updateLeaveRequest,
  uploadHRFile,
} from '../../../lib/hrApi'
import { useAuthContext } from '../../../contexts/AuthContext'
import type { HRLeaveType } from '../../../types'

const BUCKET_MEDICAL = 'hr-medical-certs'
const CURRENT_YEAR = new Date().getFullYear()

type LeaveSummaryBalance = {
  leave_type_id: string
  leave_type_name: string
  entitled_days: number
  used_days: number
  remaining: number
}

type RecentRequest = {
  id: string
  leave_type_name: string
  start_date: string
  end_date: string
  total_days: number
  status: string
  reason?: string
  medical_cert_url?: string | null
  created_at: string
}

function diffDays(start: string, end: string): number {
  const a = new Date(start)
  const b = new Date(end)
  const diff = Math.round((b.getTime() - a.getTime()) / 86400000)
  return Math.max(0, diff) + 1
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-800',
    approved: 'bg-emerald-100 text-emerald-800',
    rejected: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-600',
  }
  const labels: Record<string, string> = {
    pending: 'รอดำเนินการ',
    approved: 'อนุมัติ',
    rejected: 'ไม่อนุมัติ',
    cancelled: 'ยกเลิก',
  }
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${map[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {labels[status] ?? status}
    </span>
  )
}

export default function EmployeeLeave() {
  const { user } = useAuthContext()
  const [employee, setEmployee] = useState<{ id: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<{
    balances: LeaveSummaryBalance[]
    recent_requests: RecentRequest[]
  } | null>(null)
  const [leaveTypes, setLeaveTypes] = useState<HRLeaveType[]>([])
  const [formOpen, setFormOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [uploadingCert, setUploadingCert] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [form, setForm] = useState({
    leave_type_id: '',
    start_date: '',
    end_date: '',
    reason: '',
  })

  const totalDays = form.start_date && form.end_date ? diffDays(form.start_date, form.end_date) : 0

  const load = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const emp = await fetchEmployeeByUserId(user.id)
      setEmployee(emp)
      if (!emp) {
        setLoading(false)
        return
      }
      const [sum, types] = await Promise.all([
        getEmployeeLeaveSummary(emp.id, CURRENT_YEAR),
        fetchLeaveTypes(),
      ])
      setSummary(sum)
      setLeaveTypes(types)
      if (types.length && !form.leave_type_id) setForm((f) => ({ ...f, leave_type_id: types[0].id }))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    load()
  }, [load])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!employee || !form.leave_type_id || !form.start_date || !form.end_date) return
    setSubmitting(true)
    try {
      await createLeaveRequest({
        employee_id: employee.id,
        leave_type_id: form.leave_type_id,
        start_date: form.start_date,
        end_date: form.end_date,
        total_days: totalDays,
        reason: form.reason || undefined,
        status: 'pending',
        notified_before: false,
        notified_morning: false,
      })
      setForm({ leave_type_id: leaveTypes[0]?.id ?? '', start_date: '', end_date: '', reason: '' })
      setFormOpen(false)
      await load()
    } catch (err) {
      console.error(err)
    } finally {
      setSubmitting(false)
    }
  }

  const needsMedicalCert = (r: RecentRequest): boolean => {
    if (r.status !== 'approved') return false
    const typeName = (r.leave_type_name || '').toLowerCase()
    if (!typeName.includes(' sick') && !typeName.includes('ป่วย')) return false
    if (Number(r.total_days) <= 1) return false
    return !r.medical_cert_url
  }

  const handleMedicalUpload = async (requestId: string, file: File) => {
    if (!employee) return
    setUploadingCert(requestId)
    try {
      const path = `${employee.id}/${requestId}_${Date.now()}_${file.name}`
      await uploadHRFile(BUCKET_MEDICAL, path, file)
      const publicPath = path
      await updateLeaveRequest(requestId, { medical_cert_url: publicPath })
      await load()
    } catch (err) {
      console.error(err)
    } finally {
      setUploadingCert(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-500 border-t-transparent" />
      </div>
    )
  }

  if (!employee) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm text-center text-gray-500">
        ไม่พบข้อมูลพนักงาน
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-3">วันลาคงเหลือ</h2>
        <div className="space-y-3">
          {summary?.balances?.length ? (
            summary.balances.map((b) => {
              const max = Math.max(b.entitled_days ?? 1, 1)
              const pct = ((b.remaining ?? 0) / max) * 100
              return (
                <div key={b.leave_type_id} className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-medium text-gray-900">{b.leave_type_name}</span>
                    <span className="text-emerald-600 font-bold">
                      {b.remaining ?? 0} / {b.entitled_days ?? 0} วัน
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${pct > 30 ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-red-400'}`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                </div>
              )
            })
          ) : (
            <p className="text-gray-500 text-sm">ไม่มีข้อมูลวันลาในปีนี้</p>
          )}
        </div>
      </section>

      <section>
        <button
          type="button"
          onClick={() => setFormOpen(!formOpen)}
          className="flex items-center justify-center gap-2 w-full rounded-2xl bg-emerald-600 text-white py-4 px-4 shadow-md active:bg-emerald-700"
        >
          <FiPlus className="w-5 h-5" />
          <span className="font-medium">ขอลางาน</span>
        </button>

        {formOpen && (
          <div className="mt-4 rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">ประเภทการลา</label>
                <select
                  value={form.leave_type_id}
                  onChange={(e) => setForm((f) => ({ ...f, leave_type_id: e.target.value }))}
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 text-base"
                  required
                >
                  {leaveTypes.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">วันเริ่ม</label>
                  <input
                    type="date"
                    value={form.start_date}
                    onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))}
                    className="w-full rounded-xl border border-gray-300 px-4 py-3"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">วันสิ้นสุด</label>
                  <input
                    type="date"
                    value={form.end_date}
                    onChange={(e) => setForm((f) => ({ ...f, end_date: e.target.value }))}
                    className="w-full rounded-xl border border-gray-300 px-4 py-3"
                    required
                  />
                </div>
              </div>
              <p className="text-sm text-gray-600">รวม {totalDays} วัน</p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">เหตุผล (ถ้ามี)</label>
                <textarea
                  value={form.reason}
                  onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 min-h-[80px]"
                  placeholder="ระบุเหตุผล..."
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="flex-1 py-3 rounded-xl border border-gray-300 text-gray-700 font-medium"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 py-3 rounded-xl bg-emerald-600 text-white font-medium disabled:opacity-60"
                >
                  {submitting ? 'กำลังส่ง...' : 'ส่งคำขอ'}
                </button>
              </div>
            </form>
          </div>
        )}
      </section>

      {summary?.recent_requests?.some(needsMedicalCert) && (
        <section className="rounded-2xl border-2 border-amber-200 bg-amber-50 p-4">
          <h3 className="font-semibold text-amber-900 mb-2 flex items-center gap-2">
            <FiCamera className="w-5 h-5" />
            อัปโหลดใบรับรองแพทย์
          </h3>
          <p className="text-sm text-amber-800 mb-3">การลาป่วยมากกว่า 1 วันที่อนุมัติแล้ว กรุณาอัปโหลดใบรับรองแพทย์</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              const reqId = (e.target as HTMLInputElement).dataset.requestId
              if (file && reqId) handleMedicalUpload(reqId, file)
            }}
          />
          {summary.recent_requests.filter(needsMedicalCert).map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 py-2 border-b border-amber-200 last:border-0">
              <span className="text-sm text-amber-900">{r.leave_type_name} ({r.start_date} – {r.end_date})</span>
              <button
                type="button"
                onClick={() => {
                  fileInputRef.current?.setAttribute('data-request-id', r.id)
                  fileInputRef.current?.click()
                }}
                disabled={uploadingCert === r.id}
                className="flex items-center gap-1 rounded-lg bg-amber-600 text-white px-3 py-2 text-sm font-medium active:bg-amber-700 disabled:opacity-60"
              >
                <FiUpload className="w-4 h-4" />
                {uploadingCert === r.id ? 'กำลังอัปโหลด...' : 'อัปโหลด'}
              </button>
            </div>
          ))}
        </section>
      )}

      <section>
        <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <FiCalendar className="w-5 h-5 text-emerald-600" />
          ประวัติการขอลา
        </h3>
        <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
          {!summary?.recent_requests?.length ? (
            <p className="p-4 text-center text-gray-500 text-sm">ยังไม่มีรายการขอลา</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {summary.recent_requests.map((r) => (
                <li key={r.id} className="p-4">
                  <div className="flex justify-between items-start gap-2">
                    <div>
                      <p className="font-medium text-gray-900">{r.leave_type_name}</p>
                      <p className="text-sm text-gray-600">{r.start_date} – {r.end_date} ({r.total_days} วัน)</p>
                      {r.reason && <p className="text-xs text-gray-500 mt-1">{r.reason}</p>}
                    </div>
                    {statusBadge(r.status)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
