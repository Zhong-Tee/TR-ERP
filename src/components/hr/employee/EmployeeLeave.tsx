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
import { supabase } from '../../../lib/supabase'
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
  leave_mode?: 'full_day' | 'hourly'
  start_time?: string | null
  end_time?: string | null
  total_hours?: number | null
  status: string
  reason?: string
  medical_cert_url?: string | null
  created_at: string
}

/** ชั่วโมงต่อวันทำงานมาตรฐาน — ใช้แปลงลาเป็นชั่วโมง → สัดส่วนวัน */
const HOURS_PER_DAY = 8

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
    <span className={`inline-flex items-center shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${map[status] ?? 'bg-gray-100 text-gray-600'}`}>
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
  const docInputRef = useRef<HTMLInputElement>(null)
  const [docFile, setDocFile] = useState<File | null>(null)
  const [docError, setDocError] = useState<string | null>(null)
  const [showBalance, setShowBalance] = useState(false)

  const [form, setForm] = useState({
    leave_type_id: '',
    leave_mode: 'full_day' as 'full_day' | 'hourly',
    start_date: '',
    end_date: '',
    start_time: '09:00',
    end_time: '12:00',
    reason: '',
  })

  /** ชั่วโมงลา (โหมดชั่วโมง) — รองรับข้ามเที่ยงคืนไม่ได้ (ลาในวันเดียว) */
  const totalHours = (() => {
    if (form.leave_mode !== 'hourly' || !form.start_time || !form.end_time) return 0
    const [sh, sm] = form.start_time.split(':').map(Number)
    const [eh, em] = form.end_time.split(':').map(Number)
    const mins = eh * 60 + em - (sh * 60 + sm)
    return mins > 0 ? Math.round((mins / 60) * 100) / 100 : 0
  })()

  const totalDays =
    form.leave_mode === 'hourly'
      ? Math.round((totalHours / HOURS_PER_DAY) * 100) / 100
      : form.start_date && form.end_date
        ? diffDays(form.start_date, form.end_date)
        : 0

  const selectedType = leaveTypes.find((t) => t.id === form.leave_type_id)
  const requiresDoc = !!selectedType?.requires_doc
  const docLabel = selectedType?.doc_label || 'เอกสารประกอบการลา'

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
    if (!employee || !form.leave_type_id || !form.start_date) return
    const isHourly = form.leave_mode === 'hourly'
    if (!isHourly && !form.end_date) return
    if (!form.reason.trim()) {
      setDocError('กรุณากรอกเหตุผลการลา')
      return
    }
    if (isHourly && totalHours <= 0) {
      setDocError('เวลาสิ้นสุดต้องมากกว่าเวลาเริ่ม')
      return
    }
    if (requiresDoc && !docFile) {
      setDocError(`กรุณาแนบ${docLabel}`)
      return
    }
    setSubmitting(true)
    try {
      const createdLeave = await createLeaveRequest({
        employee_id: employee.id,
        leave_type_id: form.leave_type_id,
        leave_mode: form.leave_mode,
        start_date: form.start_date,
        end_date: isHourly ? form.start_date : form.end_date,
        start_time: isHourly ? form.start_time : undefined,
        end_time: isHourly ? form.end_time : undefined,
        total_hours: isHourly ? totalHours : undefined,
        total_days: totalDays,
        reason: form.reason || undefined,
        status: 'pending',
        notified_before: false,
        notified_morning: false,
      })
      // แนบเอกสารตอนขอลา (ถ้าประเภทนั้นบังคับ)
      if (docFile) {
        const path = `${employee.id}/${createdLeave.id}_${Date.now()}_${docFile.name}`
        await uploadHRFile(BUCKET_MEDICAL, path, docFile)
        await updateLeaveRequest(createdLeave.id, { medical_cert_url: path })
      }
      // แจ้งใบลาใหม่เข้ากลุ่ม HR (fire-and-forget)
      supabase.functions.invoke('hr-leave-request-notify', { body: { leave_id: createdLeave.id } }).catch(() => {})
      setForm({
        leave_type_id: leaveTypes[0]?.id ?? '',
        leave_mode: 'full_day',
        start_date: '',
        end_date: '',
        start_time: '09:00',
        end_time: '12:00',
        reason: '',
      })
      setDocFile(null)
      setDocError(null)
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
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-semibold text-gray-900">วันลาคงเหลือ</h2>
          {(summary?.balances?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => setShowBalance((v) => !v)}
              className="text-sm text-emerald-600 font-medium underline"
            >
              {showBalance ? 'ซ่อน' : 'ดูทั้งหมด'}
            </button>
          )}
        </div>
        <div className="space-y-3">
          {!summary?.balances?.length ? (
            <p className="text-gray-500 text-sm">ไม่มีข้อมูลวันลาในปีนี้</p>
          ) : showBalance ? (
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
          ) : null}
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
              {/* เลือกช่วงลา: เต็มวัน / ชั่วโมง */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">ช่วงลา</label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['full_day', 'เต็มวัน'],
                    ['hourly', 'เป็นชั่วโมง'],
                  ] as ['full_day' | 'hourly', string][]).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, leave_mode: mode }))}
                      className={`py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                        form.leave_mode === mode
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white text-gray-600 border-gray-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {form.leave_mode === 'full_day' ? (
                <>
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
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">วันที่ลา</label>
                    <input
                      type="date"
                      value={form.start_date}
                      onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))}
                      className="w-full rounded-xl border border-gray-300 px-4 py-3"
                      required
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">เวลาเริ่ม</label>
                      <input
                        type="time"
                        value={form.start_time}
                        onChange={(e) => setForm((f) => ({ ...f, start_time: e.target.value }))}
                        className="w-full rounded-xl border border-gray-300 px-4 py-3"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">เวลาสิ้นสุด</label>
                      <input
                        type="time"
                        value={form.end_time}
                        onChange={(e) => setForm((f) => ({ ...f, end_time: e.target.value }))}
                        className="w-full rounded-xl border border-gray-300 px-4 py-3"
                        required
                      />
                    </div>
                  </div>
                  <p className="text-sm text-gray-600">รวม {totalHours} ชั่วโมง</p>
                </>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  เหตุผล <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={form.reason}
                  onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 min-h-[80px]"
                  placeholder="ระบุเหตุผล..."
                  required
                />
              </div>
              {requiresDoc && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {docLabel} <span className="text-red-500">*</span>
                  </label>
                  <input
                    ref={docInputRef}
                    type="file"
                    accept="image/*,.pdf"
                    className="hidden"
                    onChange={(e) => {
                      setDocFile(e.target.files?.[0] ?? null)
                      setDocError(null)
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => docInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-emerald-300 text-emerald-700 py-3 active:bg-emerald-50"
                  >
                    <FiUpload className="w-5 h-5" />
                    {docFile ? 'เปลี่ยนไฟล์' : `แนบ${docLabel}`}
                  </button>
                  {docFile && (
                    <p className="text-xs text-gray-600 mt-1.5 truncate">📎 {docFile.name}</p>
                  )}
                  {docError && <p className="text-xs text-red-500 mt-1.5">{docError}</p>}
                </div>
              )}
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
                      <p className="text-sm text-gray-600">
                        {r.leave_mode === 'hourly'
                          ? `${r.start_date} ${(r.start_time ?? '').slice(0, 5)}–${(r.end_time ?? '').slice(0, 5)} น. (${r.total_hours ?? 0} ชม.)`
                          : `${r.start_date} – ${r.end_date} (${r.total_days} วัน)`}
                      </p>
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
