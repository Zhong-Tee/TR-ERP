import { useCallback, useEffect, useState } from 'react'
import { fetchEmployeeOpeningData, fetchLeaveTypes, saveEmployeeOpeningData } from '../../lib/hrApi'
import type { HRLeaveType } from '../../types'

const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/30'
const currentYear = new Date().getFullYear()

type Props = { employeeId: string }
type AttendanceForm = {
  absence_days: string
  late_count: string
  late_minutes: string
  early_leave_count: string
  early_leave_minutes: string
  note: string
}

const emptyAttendance: AttendanceForm = {
  absence_days: '0', late_count: '0', late_minutes: '0',
  early_leave_count: '0', early_leave_minutes: '0', note: '',
}

export default function EmployeeOpeningBalances({ employeeId }: Props) {
  const [year, setYear] = useState(currentYear)
  const [effectiveDate, setEffectiveDate] = useState(`${currentYear}-01-01`)
  const [leaveTypes, setLeaveTypes] = useState<HRLeaveType[]>([])
  const [balances, setBalances] = useState<Record<string, { days: string; note: string }>>({})
  const [attendance, setAttendance] = useState<AttendanceForm>(emptyAttendance)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [types, data] = await Promise.all([fetchLeaveTypes(), fetchEmployeeOpeningData(employeeId, year)])
      setLeaveTypes(types)
      const mapped: Record<string, { days: string; note: string }> = {}
      types.forEach((type) => { mapped[type.id] = { days: '0', note: '' } })
      data.balances.forEach((row) => {
        mapped[row.leave_type_id] = { days: String(row.opening_remaining_days ?? 0), note: row.note ?? '' }
      })
      setBalances(mapped)
      const firstDate = data.balances[0]?.effective_date || data.attendance?.effective_date
      setEffectiveDate(firstDate || `${year}-01-01`)
      setAttendance(data.attendance ? {
        absence_days: String(data.attendance.absence_days ?? 0),
        late_count: String(data.attendance.late_count ?? 0),
        late_minutes: String(data.attendance.late_minutes ?? 0),
        early_leave_count: String(data.attendance.early_leave_count ?? 0),
        early_leave_minutes: String(data.attendance.early_leave_minutes ?? 0),
        note: data.attendance.note ?? '',
      } : emptyAttendance)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดยอดยกมาไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [employeeId, year])

  useEffect(() => { load() }, [load])

  const save = async () => {
    if (!effectiveDate || Number(effectiveDate.slice(0, 4)) !== year) {
      setError('วันที่เริ่มใช้ระบบต้องอยู่ในปีที่เลือก')
      return
    }
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      await saveEmployeeOpeningData({
        employeeId, year, effectiveDate,
        balances: leaveTypes.map((type) => ({
          leave_type_id: type.id,
          opening_remaining_days: Math.max(0, Number(balances[type.id]?.days) || 0),
          note: balances[type.id]?.note.trim() || undefined,
        })),
        attendance: {
          absence_days: Math.max(0, Number(attendance.absence_days) || 0),
          late_count: Math.max(0, Math.floor(Number(attendance.late_count) || 0)),
          late_minutes: Math.max(0, Math.floor(Number(attendance.late_minutes) || 0)),
          early_leave_count: Math.max(0, Math.floor(Number(attendance.early_leave_count) || 0)),
          early_leave_minutes: Math.max(0, Math.floor(Number(attendance.early_leave_minutes) || 0)),
          note: attendance.note.trim() || undefined,
        },
      })
      setMessage('บันทึกยอดยกมาเรียบร้อย')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกยอดยกมาไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="py-8 text-center text-sm text-gray-500">กำลังโหลดยอดยกมา...</p>

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        กรอกยอดคงเหลือจากระบบเดิม ณ วันที่เริ่มใช้ ERP ระบบจะหักเฉพาะใบลาที่อนุมัติตั้งแต่วันที่นี้เป็นต้นไป
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {message && <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm"><span className="mb-1 block font-medium text-gray-700">ปี</span><input type="number" value={year} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => setYear(Number(e.target.value) || currentYear)} className={inputClass} /></label>
        <label className="text-sm"><span className="mb-1 block font-medium text-gray-700">วันที่เริ่มใช้ระบบจริง</span><input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={inputClass} /></label>
      </div>
      <section>
        <h3 className="mb-2 font-semibold text-gray-900">ยอดวันลาคงเหลือ</h3>
        <div className="overflow-hidden rounded-xl border border-gray-200">
          <table className="w-full text-sm"><thead className="bg-gray-50"><tr><th className="px-3 py-2 text-left">ประเภทลา</th><th className="w-36 px-3 py-2 text-left">คงเหลือ (วัน)</th><th className="px-3 py-2 text-left">หมายเหตุ</th></tr></thead>
            <tbody>{leaveTypes.map((type) => <tr key={type.id} className="border-t border-gray-100"><td className="px-3 py-2 font-medium">{type.name}</td><td className="px-3 py-2"><input type="number" min={0} step="0.5" value={balances[type.id]?.days ?? '0'} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => setBalances((p) => ({ ...p, [type.id]: { ...p[type.id], days: e.target.value } }))} className={inputClass} /></td><td className="px-3 py-2"><input value={balances[type.id]?.note ?? ''} onChange={(e) => setBalances((p) => ({ ...p, [type.id]: { ...p[type.id], note: e.target.value } }))} className={inputClass} /></td></tr>)}</tbody>
          </table>
        </div>
      </section>
      <section>
        <h3 className="mb-2 font-semibold text-gray-900">สถิติการทำงานยกมา</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {([['absence_days', 'ขาดงาน (วัน)', '0.5'], ['late_count', 'มาสาย (ครั้ง)', '1'], ['late_minutes', 'มาสาย (นาที)', '1'], ['early_leave_count', 'กลับก่อน (ครั้ง)', '1'], ['early_leave_minutes', 'กลับก่อน (นาที)', '1']] as const).map(([key, label, step]) => <label key={key} className="text-sm"><span className="mb-1 block font-medium text-gray-700">{label}</span><input type="number" min={0} step={step} value={attendance[key]} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => setAttendance((p) => ({ ...p, [key]: e.target.value }))} className={inputClass} /></label>)}
          <label className="text-sm sm:col-span-3"><span className="mb-1 block font-medium text-gray-700">หมายเหตุ</span><textarea value={attendance.note} onChange={(e) => setAttendance((p) => ({ ...p, note: e.target.value }))} className={inputClass} /></label>
        </div>
      </section>
      <div className="flex justify-end"><button type="button" onClick={save} disabled={saving} className="rounded-lg bg-emerald-600 px-5 py-2 text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? 'กำลังบันทึก...' : 'บันทึกยอดยกมา'}</button></div>
    </div>
  )
}
