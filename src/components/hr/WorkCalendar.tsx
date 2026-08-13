import { useCallback, useEffect, useMemo, useState } from 'react'
import { FiCalendar, FiChevronLeft, FiChevronRight, FiCopy, FiRefreshCw, FiSave, FiTrash2 } from 'react-icons/fi'
import { useAuthContext } from '../../contexts/AuthContext'
import Modal from '../ui/Modal'
import {
  deleteCompanyHoliday, deleteWorkCalendarDays, fetchCompanyHolidays, fetchEmployees,
  fetchWorkCalendar, fetchWorkSchedules, resolveEmployeeDayType, upsertCompanyHoliday,
  upsertWorkCalendarDays,
} from '../../lib/hrApi'
import type { HRCompanyHoliday, HREmployee, HREmployeeWorkCalendar, HRWorkCalendarDayType, HRWorkSchedule } from '../../types'

const thDays = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']
const pad = (n: number) => String(n).padStart(2, '0')
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
const addDays = (date: string, count: number) => {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + count)
  return dateKey(d)
}

export default function WorkCalendar() {
  const { user } = useAuthContext()
  const [month, setMonth] = useState(() => monthKey(new Date()))
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [schedules, setSchedules] = useState<HRWorkSchedule[]>([])
  const [entries, setEntries] = useState<HREmployeeWorkCalendar[]>([])
  const [holidays, setHolidays] = useState<HRCompanyHoliday[]>([])
  const [department, setDepartment] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set())
  const [dateSelectionEnabled, setDateSelectionEnabled] = useState(false)
  const [dayType, setDayType] = useState<HRWorkCalendarDayType>('weekly_off')
  const [note, setNote] = useState('')
  const [holidayDate, setHolidayDate] = useState(`${month}-01`)
  const [holidayName, setHolidayName] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [confirmAction, setConfirmAction] = useState<{ type: 'restore' } | { type: 'delete-holiday'; id: string } | null>(null)

  const [year, mon] = month.split('-').map(Number)
  const lastDay = new Date(year, mon, 0).getDate()
  const monthStart = `${month}-01`
  const monthEnd = `${month}-${pad(lastDay)}`
  const dates = useMemo(() => Array.from({ length: lastDay }, (_, i) => `${month}-${pad(i + 1)}`), [lastDay, month])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [emps, scheds, calendar, companyDays] = await Promise.all([
        fetchEmployees(), fetchWorkSchedules(true), fetchWorkCalendar(monthStart, monthEnd), fetchCompanyHolidays(monthStart, monthEnd),
      ])
      setEmployees(emps.filter((e) => ['active', 'probation'].includes(e.employment_status)))
      setSchedules(scheds)
      setEntries(calendar)
      setHolidays(companyDays)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
    } finally { setLoading(false) }
  }, [monthEnd, monthStart])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    setHolidayDate(monthStart); setSelected(new Set()); setSelectedDates(new Set()); setDateSelectionEnabled(false)
  }, [monthStart])

  const departments = useMemo(() => [...new Map(employees.filter(e => e.department).map(e => [e.department!.id, e.department!])).values()], [employees])
  const visibleEmployees = useMemo(() => employees.filter((e) => {
    const q = search.trim().toLowerCase()
    return (!department || e.department_id === department) && (!q || `${e.employee_code} ${e.first_name} ${e.last_name} ${e.nickname ?? ''}`.toLowerCase().includes(q))
  }), [department, employees, search])
  const entryMap = useMemo(() => new Map(entries.map(e => [`${e.employee_id}|${e.work_date}`, e])), [entries])
  const holidayMap = useMemo(() => new Map(holidays.map(h => [h.holiday_date, h])), [holidays])
  const defaultSchedule = schedules.find(s => s.is_default) ?? schedules[0]
  const scheduleMap = useMemo(() => new Map(schedules.map(s => [s.id, s])), [schedules])

  const toggleEmployee = (id: string) => {
    setSelected(cur => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const selectVisible = () => {
    setSelected(cur => visibleEmployees.every(e => cur.has(e.id)) ? new Set() : new Set(visibleEmployees.map(e => e.id)))
  }

  const toggleDate = (date: string) => {
    if (!dateSelectionEnabled) {
      setSelectedDates(new Set([date]))
      return
    }
    setSelectedDates(cur => {
      const next = new Set(cur)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  async function applyRange() {
    if (!selected.size) return setMessage('กรุณาเลือกพนักงานอย่างน้อย 1 คน')
    const targetDates = [...selectedDates].sort()
    if (!targetDates.length) return setMessage('กรุณาเลือกวันที่อย่างน้อย 1 วัน')
    setSaving(true); setMessage('')
    try {
      const rows: Partial<HREmployeeWorkCalendar>[] = []
      for (const employee_id of selected) {
        for (const d of targetDates) {
          rows.push({ employee_id, work_date: d, day_type: dayType, source: 'manual', note: note || undefined, updated_by: user?.id, created_by: user?.id })
        }
      }
      await upsertWorkCalendarDays(rows)
      setMessage(`บันทึก ${rows.length} รายการแล้ว`); await load()
    } catch (e) { setMessage(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  async function restoreRange() {
    if (!selected.size) return setMessage('กรุณาเลือกพนักงานอย่างน้อย 1 คน')
    if (!selectedDates.size) return setMessage('กรุณาเลือกวันที่อย่างน้อย 1 วัน')
    setConfirmAction({ type: 'restore' })
  }

  async function confirmRestoreRange() {
    setConfirmAction(null)
    setSaving(true)
    try {
      await Promise.all([...selectedDates].map(date => deleteWorkCalendarDays([...selected], date, date)))
      setMessage('กลับไปใช้ตารางมาตรฐานแล้ว'); await load()
    }
    catch (e) { setMessage(e instanceof Error ? e.message : 'ดำเนินการไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  async function copyPreviousWeek() {
    if (!selected.size) return setMessage('กรุณาเลือกพนักงานอย่างน้อย 1 คน')
    const targetStart = [...selectedDates].sort()[0]
    if (!targetStart) return setMessage('กรุณาเลือกวันที่เริ่มต้นอย่างน้อย 1 วัน')
    const targetEnd = addDays(targetStart, 6)
    const sourceStart = addDays(targetStart, -7)
    const sourceEnd = addDays(targetStart, -1)
    setSaving(true)
    try {
      const source = await fetchWorkCalendar(sourceStart, sourceEnd, [...selected])
      const rows = source.map(({ employee_id, work_date, day_type, work_schedule_id, work_start, work_end, note }) => ({
        employee_id, work_date: addDays(work_date, 7), day_type, work_schedule_id, work_start, work_end,
        note, source: 'pattern' as const, created_by: user?.id, updated_by: user?.id,
      })).filter(r => r.work_date <= targetEnd)
      if (!rows.length) setMessage('สัปดาห์ก่อนไม่มีรายการกำหนดพิเศษให้คัดลอก')
      else { await upsertWorkCalendarDays(rows); setMessage(`คัดลอก ${rows.length} รายการแล้ว`); await load() }
    } catch (e) { setMessage(e instanceof Error ? e.message : 'คัดลอกไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  async function saveHoliday() {
    if (!holidayName.trim()) return setMessage('กรุณาระบุชื่อวันหยุดบริษัท')
    setSaving(true)
    try { await upsertCompanyHoliday({ holiday_date: holidayDate, name: holidayName.trim(), is_paid: true, created_by: user?.id }); setHolidayName(''); setMessage('บันทึกวันหยุดบริษัทแล้ว'); await load() }
    catch (e) { setMessage(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  async function removeHoliday(id: string) {
    setConfirmAction({ type: 'delete-holiday', id })
  }

  async function confirmRemoveHoliday(id: string) {
    setConfirmAction(null)
    await deleteCompanyHoliday(id); await load()
  }

  const moveMonth = (delta: number) => setMonth(monthKey(new Date(year, mon - 1 + delta, 1)))
  const statusFor = (emp: HREmployee, date: string) => {
    const schedule = (emp.work_schedule_id && scheduleMap.get(emp.work_schedule_id)) || defaultSchedule
    if (!schedule) return 'work'
    return resolveEmployeeDayType(date, schedule, entryMap.get(`${emp.id}|${date}`), holidayMap.get(date))
  }
  const saveTargetCount = selected.size

  return <div className="space-y-5 p-1">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-bold text-gray-900">ตารางวันทำงานและวันหยุด</h1><p className="text-sm text-gray-500">รายการรายวันจะมีสิทธิ์เหนือกว่าตารางเวลามาตรฐานของพนักงาน</p></div>
      <div className="flex items-center gap-2"><button onClick={() => moveMonth(-1)} className="p-2 border rounded-lg"><FiChevronLeft /></button><input type="month" value={month} onChange={e => setMonth(e.target.value)} className="border rounded-lg px-3 py-2"/><button onClick={() => moveMonth(1)} className="p-2 border rounded-lg"><FiChevronRight /></button><button onClick={load} className="p-2 border rounded-lg" title="รีเฟรช"><FiRefreshCw /></button></div>
    </div>

    {message && <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">{message}</div>}

    <div className="grid xl:grid-cols-[2fr_1fr] gap-4">
      <section className="bg-white border rounded-xl p-4 space-y-3">
        <h2 className="font-bold">กำหนดแบบกลุ่ม</h2>
        <div className="flex flex-wrap xl:flex-nowrap items-end gap-3">
          <label className="text-sm min-w-40 flex-1">สถานะ<select value={dayType} onChange={e => setDayType(e.target.value as HRWorkCalendarDayType)} className="mt-1 w-full border rounded-lg px-3 py-2"><option value="weekly_off">วันหยุด</option><option value="work">วันทำงาน</option></select></label>
          <label className="text-sm min-w-56 flex-[1.5]">หมายเหตุ<input value={note} onChange={e => setNote(e.target.value)} className="mt-1 w-full border rounded-lg px-3 py-2" placeholder="เช่น สลับวันหยุด"/></label>
          <button disabled={saving || saveTargetCount === 0 || selectedDates.size === 0} onClick={applyRange} className="h-[42px] shrink-0 flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg disabled:opacity-50"><FiSave/>บันทึกให้ {saveTargetCount} คน</button>
          <button disabled={saving || selectedDates.size === 0} onClick={copyPreviousWeek} className="h-[42px] shrink-0 flex items-center gap-2 px-4 py-2 border rounded-lg disabled:opacity-50"><FiCopy/>คัดลอกสัปดาห์ก่อน</button>
          <button disabled={saving || selectedDates.size === 0} onClick={restoreRange} className="h-[42px] shrink-0 flex items-center gap-2 px-4 py-2 border rounded-lg text-gray-600 disabled:opacity-50"><FiRefreshCw/>ล้างค่าที่กำหนดพิเศษ</button>
        </div>
      </section>
      <section className="bg-white border rounded-xl p-4 space-y-3">
        <h2 className="font-bold flex items-center gap-2"><FiCalendar/>วันหยุดบริษัท</h2>
        <div className="flex gap-2"><input type="date" value={holidayDate} onChange={e => setHolidayDate(e.target.value)} className="min-w-0 border rounded-lg px-2 py-2"/><input value={holidayName} onChange={e => setHolidayName(e.target.value)} placeholder="ชื่อวันหยุด" className="min-w-0 flex-1 border rounded-lg px-3 py-2"/><button onClick={saveHoliday} className="px-3 bg-blue-600 text-white rounded-lg">เพิ่ม</button></div>
        <div className="max-h-28 overflow-auto space-y-1">{holidays.map(h => <div key={h.id} className="flex justify-between text-sm bg-blue-50 rounded px-2 py-1"><span>{new Date(`${h.holiday_date}T12:00:00`).toLocaleDateString('th-TH')} · {h.name}</span><button onClick={() => removeHoliday(h.id)} className="text-red-500"><FiTrash2/></button></div>)}</div>
      </section>
    </div>

    <section className="bg-white border rounded-xl overflow-hidden">
      <div className="p-3 border-b flex flex-wrap items-center gap-2">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหาชื่อหรือรหัสพนักงาน" className="border rounded-lg px-3 py-2 w-64"/>
        <select value={department} onChange={e => setDepartment(e.target.value)} className="border rounded-lg px-3 py-2"><option value="">ทุกแผนก</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <label className={`flex items-center gap-2 px-3 py-2 border rounded-lg cursor-pointer ${dateSelectionEnabled ? 'border-blue-500 bg-blue-50 text-blue-700' : 'text-gray-700'}`}>
          <input type="checkbox" checked={dateSelectionEnabled} onChange={e => {
            const enabled = e.target.checked
            setDateSelectionEnabled(enabled)
            if (!enabled) setSelectedDates(cur => new Set([...cur].sort().slice(0, 1)))
          }}/>
          เลือกวัน
        </label>
        <button type="button" disabled={selectedDates.size === 0} onClick={() => setSelectedDates(new Set())} className="flex items-center gap-2 px-3 py-2 border rounded-lg text-gray-600 disabled:opacity-40"><FiRefreshCw/>ล้างวันที่ที่เลือก ({selectedDates.size})</button>
        <div className="ml-auto flex items-center gap-3 text-xs"><span className="text-emerald-700">● ทำงาน</span><span className="text-gray-500">● หยุด</span><span className="text-blue-600">● วันหยุดบริษัท</span><span className="text-amber-600">● กำหนดพิเศษ</span></div>
      </div>
      <div className="overflow-auto max-h-[60vh]">
        <table className="border-collapse text-xs min-w-max w-full select-none">
          <thead className="sticky top-0 z-20 bg-gray-50"><tr><th className="sticky left-0 z-30 bg-gray-50 border p-2 min-w-56 text-left"><label className="flex gap-2"><input type="checkbox" checked={visibleEmployees.length > 0 && visibleEmployees.every(e => selected.has(e.id))} onChange={selectVisible}/>พนักงาน ({visibleEmployees.length})</label></th>{dates.map(d => { const dt = new Date(`${d}T12:00:00`); const isDateSelected = selectedDates.has(d); return <th key={d} onMouseDown={() => toggleDate(d)} title={dateSelectionEnabled ? 'คลิกเพื่อเลือกหรือยกเลิกวันนี้' : 'คลิกเพื่อเลือกวันนี้ (เลือกได้ 1 วัน)'} className={`border p-1 min-w-10 cursor-pointer hover:bg-blue-50 ${isDateSelected ? 'bg-blue-100 ring-2 ring-inset ring-blue-400' : ''} ${dt.getDay() === 0 ? 'text-red-600' : ''}`}><div>{thDays[dt.getDay()]}</div><div className="text-sm">{dt.getDate()}</div></th> })}</tr></thead>
          <tbody>{visibleEmployees.map(emp => <tr key={emp.id} className="hover:bg-gray-50"><td className="sticky left-0 z-10 bg-white border p-2"><label className="flex items-center gap-2"><input type="checkbox" checked={selected.has(emp.id)} onChange={() => toggleEmployee(emp.id)}/><span><b>{emp.first_name} {emp.last_name}{emp.nickname ? ` (${emp.nickname})` : ''}</b><small className="block text-gray-400">{emp.employee_code} · {emp.department?.name ?? '-'}</small></span></label></td>{dates.map(date => { const status = statusFor(emp, date); const special = entryMap.get(`${emp.id}|${date}`); const holiday = holidayMap.get(date); const cls = status === 'work' ? 'bg-emerald-100' : status === 'company_holiday' ? 'bg-blue-100' : 'bg-gray-100'; const label = special?.note || holiday?.name || (status === 'work' ? 'วันทำงาน' : 'วันหยุด'); const isSelected = selected.has(emp.id) && selectedDates.has(date); return <td key={date} title={label} aria-label={label} className={`h-12 border ${cls} ${isSelected ? 'ring-2 ring-inset ring-violet-500' : ''} ${special ? 'border-b-4 !border-b-amber-400' : ''}`} />})}</tr>)}</tbody>
        </table>
        {!loading && visibleEmployees.length === 0 && <div className="p-12 text-center text-gray-400">ไม่พบพนักงาน</div>}
        {loading && <div className="p-12 text-center text-gray-500">กำลังโหลด...</div>}
      </div>
    </section>
    <Modal open={confirmAction !== null} onClose={() => setConfirmAction(null)} closeOnBackdropClick contentClassName="max-w-md">
      <div className="p-6">
        <h3 className="text-lg font-bold text-gray-900">
          {confirmAction?.type === 'restore' ? 'ล้างค่าที่กำหนดพิเศษ' : 'ลบวันหยุดบริษัท'}
        </h3>
        <p className="mt-2 text-sm leading-6 text-gray-600">
          {confirmAction?.type === 'restore'
            ? `ต้องการล้างสถานะที่ตั้งเองในวันที่เลือก ${selectedDates.size} วัน ของพนักงาน ${selected.size} คนหรือไม่? หลังล้างแล้ว ระบบจะใช้วันทำงานและวันหยุดประจำตามตารางของพนักงานโดยอัตโนมัติ`
            : 'ต้องการลบวันหยุดบริษัทนี้ใช่หรือไม่?'}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={() => setConfirmAction(null)} className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">ยกเลิก</button>
          <button
            type="button"
            onClick={() => confirmAction?.type === 'restore' ? confirmRestoreRange() : confirmAction && confirmRemoveHoliday(confirmAction.id)}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
          >ยืนยัน</button>
        </div>
      </div>
    </Modal>
  </div>
}
