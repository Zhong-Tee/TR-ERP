import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FiRefreshCw, FiSearch } from 'react-icons/fi'
import Modal from '../ui/Modal'
import { supabase } from '../../lib/supabase'
import {
  createLateWarning, fetchLateAccumulation, lateLevelLabels, LATE_CHANGED_EVENT,
  saveLateStartDate, setLateException,
  type LateAccumulationData, type LateAccumulationRow, type LateIncident,
} from '../../lib/lateAccumulationApi'

const inputClass = 'rounded-lg border border-surface-300 px-3 py-2 text-sm'
const dateText = (date: string | null) => date ? new Date(`${date}T00:00:00+07:00`).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' }) : '—'
const clock = (min: number) => `${Math.floor(min / 60).toString().padStart(2, '0')}:${(min % 60).toString().padStart(2, '0')}`
const statuses: Record<string, string> = {
  draft: 'ร่าง', pending_review: 'รอตรวจ', changes_requested: 'รอแก้ไข', pending_approval: 'รออนุมัติ',
  approved: 'อนุมัติแล้ว', pending_acknowledgement: 'รอรับทราบ', termination_review: 'รอพิจารณาทางวินัย',
}

export default function LateAccumulation() {
  const navigate = useNavigate()
  const [data, setData] = useState<LateAccumulationData | null>(null)
  const [startDate, setStartDate] = useState('')
  const lastServerDate = useRef('')
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [confirmRow, setConfirmRow] = useState<LateAccumulationRow | null>(null)
  const [confirmSettings, setConfirmSettings] = useState(false)
  const [exception, setException] = useState<{ incident: LateIncident; exempt: boolean; reason: string } | null>(null)
  const load = useCallback(async () => {
    try {
      const result = await fetchLateAccumulation()
      setData(result)
      const previousServerDate = lastServerDate.current
      setStartDate(previous => !previous || previous === previousServerDate ? result.start_date : previous)
      lastServerDate.current = result.start_date
      setError('')
    } catch (e) { setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => {
    void load()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { void load() }, 400) }
    const interval = setInterval(refresh, 60_000)
    window.addEventListener(LATE_CHANGED_EVENT, refresh)
    window.addEventListener('focus', refresh)
    const channel = supabase.channel('late-accumulation-table')
    for (const table of ['hr_warnings', 'hr_time_entries', 'hr_time_certifications', 'hr_leave_requests',
      'hr_late_settings', 'hr_late_exceptions', 'hr_employee_work_calendar', 'hr_work_schedules', 'hr_wfh_requests']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, refresh)
    }
    channel.subscribe()
    return () => {
      clearTimeout(timer); clearInterval(interval)
      window.removeEventListener(LATE_CHANGED_EVENT, refresh); window.removeEventListener('focus', refresh)
      void supabase.removeChannel(channel)
    }
  }, [load])
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action(); await load() }
    catch (e) { setError(e instanceof Error ? e.message : 'ดำเนินการไม่สำเร็จ') }
    finally { setBusy(false) }
  }
  const detail = data?.rows.find(row => row.employee_id === detailId)
  const rows = (data?.rows ?? []).filter(row => `${row.employee_code} ${row.employee_name} ${row.department_name ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))
  return <div className="space-y-4 rounded-xl bg-white p-4 shadow">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h2 className="text-lg font-semibold">สะสมการมาสาย</h2><p className="text-sm text-gray-500">ครบ 3 ครั้ง หรือ 120 นาที · ไม่สายครบ 120 วัน รีเซ็ตเฉพาะยอดสะสม</p></div>
      <button disabled={busy} onClick={() => { setLoading(true); void load() }} className={`${inputClass} flex items-center gap-2`}><FiRefreshCw />รีเฟรช</button>
    </div>
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</div>}
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">วันเริ่มใช้กฎ<input type="date" value={startDate} disabled={busy || data?.settings_locked} onChange={e => setStartDate(e.target.value)} className={`${inputClass} ml-2`} /></label>
      {startDate && <span className="text-xs text-gray-500">{dateText(startDate)}</span>}
      <button disabled={busy || !data || data.settings_locked || !startDate || startDate === data.start_date} onClick={() => setConfirmSettings(true)} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-40">บันทึกวันเริ่ม</button>
      <label className="flex items-center gap-2"><FiSearch /><input placeholder="ค้นหาพนักงาน / แผนก" value={search} onChange={e => setSearch(e.target.value)} className={inputClass} /></label>
      <span className="text-sm text-amber-700">รอสร้างใบเตือน {data?.ready_count ?? 0} คน</span>
    </div>
    {data?.settings_locked && <p className="text-xs text-gray-500">ล็อกวันเริ่มหลังสร้างเคส เพื่อรักษายอดและประวัติที่ใช้เตือน</p>}
    <div className="overflow-x-auto"><table className="w-full whitespace-nowrap text-sm"><thead className="bg-surface-50"><tr>{['พนักงาน / แผนก', 'สายสะสม', 'นาทีสะสม', 'สายล่าสุด', 'ไม่สายต่อเนื่อง', 'ขั้นปัจจุบัน / หมดผล', 'ดำเนินการ'].map(label => <th key={label} className="p-3 text-left">{label}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.employee_id} className={`border-t ${row.eligible ? 'bg-amber-50' : ''}`}>
        <td className="p-3"><button className="text-left text-blue-700 hover:underline" onClick={() => setDetailId(row.employee_id)}>{row.employee_code} · {row.employee_name}</button><div className="text-xs text-gray-500">{row.department_name ?? '—'}</div></td>
        <td className="p-3">{row.late_count} / 3 ครั้ง</td><td className="p-3">{row.late_minutes} / 120 นาที</td>
        <td className="p-3">{dateText(row.last_late_date)}</td><td className="p-3">{row.clean_days} วัน{row.clean_days >= 120 && <div className="text-xs text-emerald-700">รีเซ็ตยอดแล้ว</div>}</td>
        <td className="p-3">{row.current_level ? lateLevelLabels[row.current_level] : 'ยังไม่มีคำเตือนที่มีผล'}<div className="text-xs text-gray-500">{row.effective_until ? `หมดผล ${dateText(row.effective_until)}` : '—'}</div></td>
        <td className="p-3">{row.pending_warning_id ? <button className="text-blue-700 hover:underline" onClick={() => navigate(`/hr/warnings?case=${row.pending_warning_id}`)}>{row.pending_case_number} · {statuses[row.pending_status ?? ''] ?? row.pending_status}</button> : row.eligible ? <button disabled={busy} onClick={() => setConfirmRow(row)} className="rounded-lg bg-amber-600 px-3 py-2 text-white disabled:opacity-50">สร้างร่าง: {lateLevelLabels[row.next_level]}</button> : <span className="text-gray-400">{row.current_level === 'termination_review' ? 'อยู่ในขั้นพิจารณาทางวินัย' : 'ยังไม่ถึงเกณฑ์'}</span>}
          {row.pending_emergency_count > 0 && <div className="text-xs text-amber-700">รอพิจารณาลาฉุกเฉิน {row.pending_emergency_count} เหตุ</div>}
          {row.review_required && <div className="text-xs text-red-700">ข้อมูลเปลี่ยนแปลง ต้องทบทวนเคส</div>}
        </td>
      </tr>)}{!rows.length && <tr><td colSpan={7} className="p-10 text-center text-gray-400">{loading ? 'กำลังโหลด...' : 'ไม่มีรายการมาสายตั้งแต่วันเริ่มใช้กฎ'}</td></tr>}</tbody>
    </table></div>
    <Modal open={!!confirmRow} onClose={() => { if (!busy) setConfirmRow(null) }} contentClassName="max-w-lg"><div className="space-y-4 p-6"><h3 className="text-lg font-semibold">สร้างร่างใบเตือน</h3><p>{confirmRow?.employee_name} · {confirmRow ? lateLevelLabels[confirmRow.next_level] : ''}</p><p className="text-sm">สายสะสม {confirmRow?.late_count} ครั้ง รวม {confirmRow?.late_minutes} นาที ร่างจะเข้าสู่ระบบใบเตือนเพื่อให้ HR ตรวจและส่งอนุมัติ</p><button disabled={busy} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50" onClick={() => { if (confirmRow) void perform(async () => { const id = await createLateWarning(confirmRow.employee_id); setConfirmRow(null); navigate(`/hr/warnings?case=${id}`) }) }}>{busy ? 'กำลังสร้าง...' : 'ยืนยันสร้างร่าง'}</button>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}</div></Modal>
    <Modal open={confirmSettings} onClose={() => { if (!busy) setConfirmSettings(false) }} contentClassName="max-w-lg"><div className="space-y-4 p-6"><h3 className="text-lg font-semibold">เปลี่ยนวันเริ่มใช้กฎ</h3><p>เริ่มนับเหตุวันที่ {dateText(startDate)} โดยจะคำนวณยอดใหม่ตามวันที่นี้</p><button disabled={busy} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50" onClick={() => { void perform(async () => { await saveLateStartDate(startDate); setConfirmSettings(false) }) }}>ยืนยันบันทึก</button>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}</div></Modal>
    <Modal open={!!detail} onClose={() => setDetailId(null)} contentClassName="max-w-4xl">{detail && <div className="space-y-4 p-6"><h3 className="text-lg font-semibold">ประวัติการมาสาย · {detail.employee_name}</h3><p className="text-sm text-gray-500">ยอดรอบปัจจุบัน {detail.late_count} ครั้ง · {detail.late_minutes} นาที — ประวัติเก่ายังคงอยู่หลังรีเซ็ต</p><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['วันที่', 'เริ่มงาน', 'เข้างาน', 'นาทีสาย', 'สถานะ / เหตุผล', 'ข้อยกเว้น'].map(x => <th key={x} className="p-2 text-left">{x}</th>)}</tr></thead><tbody>{detail.history.map(incident => <tr key={incident.work_date} className="border-t"><td className="p-2">{dateText(incident.work_date)}</td><td className="p-2">{clock(incident.expected_min)}</td><td className="p-2">{clock(incident.actual_min)}</td><td className="p-2">{incident.late_min}</td><td className="p-2">{incident.status === 'exempt' ? 'ยกเว้น' : incident.status === 'pending' ? 'รออนุมัติลาฉุกเฉิน' : detail.incidents.some(x => x.work_date === incident.work_date) ? 'สะสมรอบปัจจุบัน' : 'ประวัติรอบก่อน'}<div className="text-xs text-gray-500">{incident.reason}</div></td><td className="p-2"><button disabled={busy || incident.status === 'pending'} className="text-blue-700 disabled:opacity-40" onClick={() => setException({ incident, exempt: incident.status !== 'exempt', reason: '' })}>{incident.status === 'exempt' ? 'ทบทวนการยกเว้น' : 'ยกเว้นเหตุ'}</button></td></tr>)}</tbody></table></div></div>}</Modal>
    <Modal open={!!exception} onClose={() => { if (!busy) setException(null) }} contentClassName="max-w-lg"><div className="space-y-4 p-6"><h3 className="text-lg font-semibold">{exception?.exempt ? 'ยกเว้นเหตุการมาสาย' : 'ยกเลิกข้อยกเว้นที่ HR บันทึก'}</h3><p className="text-sm">ต้องระบุเหตุผล ระบบจะคำนวณยอดใหม่และให้ทบทวนเคสที่ได้รับผลกระทบ การลาที่อนุมัติแล้วต้องแก้ไขผ่านระบบลา</p><textarea className={`${inputClass} w-full`} rows={3} value={exception?.reason ?? ''} onChange={e => setException(previous => previous ? { ...previous, reason: e.target.value } : null)} placeholder="เหตุผล / หลักฐานประกอบ" /><button disabled={busy || !exception?.reason.trim()} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50" onClick={() => { if (exception) void perform(async () => { await setLateException(exception.incident.employee_id, exception.incident.work_date, exception.exempt, exception.reason); setException(null) }) }}>บันทึกผลพิจารณา</button>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}</div></Modal>
  </div>
}
