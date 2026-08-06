import { useCallback, useEffect, useState } from 'react'
import { FiHome, FiCalendar, FiCheckCircle, FiXCircle, FiClock } from 'react-icons/fi'
import { useAuthContext } from '../../../contexts/AuthContext'
import { createWFHRequest, fetchEmployeeByUserId, fetchWFHRequests, fetchWorkSchedules } from '../../../lib/hrApi'
import type { HREmployee, HRWFHRequest, HRWorkSchedule } from '../../../types'

function todayStr() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 'HH:mm:ss' | 'HH:mm' → 'HH:mm' (ค่าที่ input type=time รับได้) */
function toTimeInput(value?: string | null) {
  return value ? value.slice(0, 5) : ''
}

function statusView(status: HRWFHRequest['status']) {
  if (status === 'approved') return { label: 'อนุมัติ', cls: 'bg-emerald-100 text-emerald-700', Icon: FiCheckCircle }
  if (status === 'rejected') return { label: 'ปฏิเสธ', cls: 'bg-red-100 text-red-700', Icon: FiXCircle }
  if (status === 'cancelled') return { label: 'ยกเลิก', cls: 'bg-gray-100 text-gray-600', Icon: FiXCircle }
  return { label: 'รออนุมัติ', cls: 'bg-amber-100 text-amber-700', Icon: FiClock }
}

export default function EmployeeWFH() {
  const { user } = useAuthContext()
  const [employee, setEmployee] = useState<HREmployee | null>(null)
  const [requests, setRequests] = useState<HRWFHRequest[]>([])
  const [form, setForm] = useState({
    start_date: todayStr(),
    end_date: todayStr(),
    start_time: '',
    end_time: '',
    reason: '',
  })
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const emp = await fetchEmployeeByUserId(user.id)
      setEmployee(emp)
      if (emp) {
        const [reqs, scheds] = await Promise.all([
          fetchWFHRequests({ employee_id: emp.id }),
          fetchWorkSchedules(true).catch(() => [] as HRWorkSchedule[]),
        ])
        setRequests(reqs)
        // ค่าเริ่มต้นของช่วงเวลา = ตารางเวลาของพนักงาน (ถ้าไม่ได้กำหนด → ชุดค่าเริ่มต้น)
        const mySched =
          (emp.work_schedule_id ? scheds.find((s) => s.id === emp.work_schedule_id) : undefined) ??
          scheds.find((s) => s.is_default) ??
          scheds[0] ??
          null
        setForm((f) => ({
          ...f,
          start_time: f.start_time || toTimeInput(mySched?.work_start) || '08:00',
          end_time: f.end_time || toTimeInput(mySched?.work_end) || '17:00',
        }))
      }
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ' })
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => { load() }, [load])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!employee || !form.reason.trim()) return
    if (form.end_date < form.start_date) {
      setMessage({ type: 'error', text: 'วันที่สิ้นสุดต้องไม่น้อยกว่าวันที่เริ่มต้น' })
      return
    }
    if (!form.start_time || !form.end_time) {
      setMessage({ type: 'error', text: 'กรุณาระบุช่วงเวลาที่ขอ WFH' })
      return
    }
    if (form.end_time <= form.start_time) {
      setMessage({ type: 'error', text: 'เวลาเลิกงานต้องมากกว่าเวลาเริ่มงาน' })
      return
    }
    const range = `${form.start_time} – ${form.end_time} น.`
    if (!window.confirm(`ยืนยันส่งคำขอ WFH วันที่ ${form.start_date} ถึง ${form.end_date} เวลา ${range} ใช่หรือไม่?`)) return
    setSubmitting(true)
    try {
      await createWFHRequest({
        employee_id: employee.id,
        start_date: form.start_date,
        end_date: form.end_date,
        start_time: form.start_time,
        end_time: form.end_time,
        reason: form.reason.trim(),
        status: 'pending',
      })
      setMessage({ type: 'success', text: 'ส่งคำขอ WFH แล้ว กรุณารอการอนุมัติ' })
      setForm((current) => ({ ...current, reason: '' }))
      await load()
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'ส่งคำขอไม่สำเร็จ' })
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="py-16 text-center text-sm text-gray-500">กำลังโหลด…</div>
  if (!employee || employee.work_mode !== 'hybrid') {
    return <div className="rounded-2xl bg-white p-6 text-center text-sm text-gray-500">บัญชีนี้ไม่มีสิทธิ์ส่งคำขอ WFH</div>
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900"><FiHome className="text-emerald-600" /> คำขอ WFH</h2>
        <p className="mt-1 text-xs text-gray-500">ต้องได้รับอนุมัติก่อน จึงจะลงเวลานอกพิกัดสำนักงานได้</p>
        {message && <div className={`mt-3 rounded-xl px-3 py-2 text-sm ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>{message.text}</div>}
        <form onSubmit={submit} className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-gray-600">วันที่เริ่มต้น<input type="date" min={todayStr()} value={form.start_date} onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value, end_date: e.target.value > f.end_date ? e.target.value : f.end_date }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm" required /></label>
            <label className="text-xs text-gray-600">วันที่สิ้นสุด<input type="date" min={form.start_date} value={form.end_date} onChange={(e) => setForm((f) => ({ ...f, end_date: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm" required /></label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-gray-600">เวลาเริ่มงาน<input type="time" value={form.start_time} onChange={(e) => setForm((f) => ({ ...f, start_time: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm" required /></label>
            <label className="text-xs text-gray-600">เวลาเลิกงาน<input type="time" value={form.end_time} onChange={(e) => setForm((f) => ({ ...f, end_time: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm" required /></label>
          </div>
          <p className="text-[11px] text-gray-500">ช่วงเวลานี้จะถูกใช้เป็นเวลาเข้า-ออกงานของวันที่ WFH หลังได้รับอนุมัติ</p>
          <label className="block text-xs text-gray-600">เหตุผล<textarea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} rows={3} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm" placeholder="ระบุเหตุผลที่ขอ WFH" required /></label>
          <button type="submit" disabled={submitting} className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white disabled:opacity-50">{submitting ? 'กำลังส่ง…' : 'ส่งคำขอ WFH'}</button>
        </form>
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-2 font-semibold text-gray-900"><FiCalendar className="text-emerald-600" /> ประวัติคำขอ</h3>
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          {requests.length === 0 ? <p className="p-5 text-center text-sm text-gray-500">ยังไม่มีคำขอ WFH</p> : (
            <ul className="divide-y divide-gray-100">{requests.map((request) => {
              const view = statusView(request.status)
              const StatusIcon = view.Icon
              return <li key={request.id} className="p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-gray-800">{request.start_date} – {request.end_date}</p>{request.start_time && request.end_time && <p className="mt-0.5 text-xs text-gray-600">เวลา {toTimeInput(request.start_time)} – {toTimeInput(request.end_time)} น.</p>}<p className="mt-1 text-xs text-gray-500">{request.reason}</p>{request.reject_reason && <p className="mt-1 text-xs text-red-600">เหตุผล: {request.reject_reason}</p>}</div><span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${view.cls}`}><StatusIcon className="h-3.5 w-3.5" />{view.label}</span></div></li>
            })}</ul>
          )}
        </div>
      </section>
    </div>
  )
}
