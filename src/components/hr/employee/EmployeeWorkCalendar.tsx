import { useEffect, useMemo, useState } from 'react'
import { FiChevronLeft, FiChevronRight } from 'react-icons/fi'
import { useAuthContext } from '../../../contexts/AuthContext'
import { fetchCompanyHolidays, fetchEmployeeByUserId, fetchWorkCalendar, fetchWorkSchedules, resolveEmployeeDayType } from '../../../lib/hrApi'
import type { HRCompanyHoliday, HREmployee, HREmployeeWorkCalendar, HRWorkSchedule } from '../../../types'

const pad = (n: number) => String(n).padStart(2, '0')
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`

export default function EmployeeWorkCalendar() {
  const { user } = useAuthContext()
  const [month, setMonth] = useState(() => monthKey(new Date()))
  const [employee, setEmployee] = useState<HREmployee | null>(null)
  const [schedules, setSchedules] = useState<HRWorkSchedule[]>([])
  const [entries, setEntries] = useState<HREmployeeWorkCalendar[]>([])
  const [holidays, setHolidays] = useState<HRCompanyHoliday[]>([])
  const [loading, setLoading] = useState(true)
  const [year, mon] = month.split('-').map(Number)
  const lastDay = new Date(year, mon, 0).getDate()
  const start = `${month}-01`, end = `${month}-${pad(lastDay)}`

  useEffect(() => {
    if (!user?.id) return
    setLoading(true)
    fetchEmployeeByUserId(user.id).then(async emp => {
      setEmployee(emp)
      if (!emp) return
      const [scheds, days, companyDays] = await Promise.all([fetchWorkSchedules(true), fetchWorkCalendar(start, end, [emp.id]), fetchCompanyHolidays(start, end)])
      setSchedules(scheds); setEntries(days); setHolidays(companyDays)
    }).finally(() => setLoading(false))
  }, [end, start, user?.id])

  const entryMap = useMemo(() => new Map(entries.map(e => [e.work_date, e])), [entries])
  const holidayMap = useMemo(() => new Map(holidays.map(h => [h.holiday_date, h])), [holidays])
  const schedule = (employee?.work_schedule_id && schedules.find(s => s.id === employee.work_schedule_id)) || schedules.find(s => s.is_default) || schedules[0]
  const firstWeekday = new Date(year, mon - 1, 1).getDay()
  const cells = [...Array(firstWeekday).fill(null), ...Array.from({ length: lastDay }, (_, i) => i + 1)]
  const move = (delta: number) => setMonth(monthKey(new Date(year, mon - 1 + delta, 1)))

  return <div className="p-4 space-y-4">
    <div className="flex items-center justify-between"><div><h2 className="text-xl font-black text-gray-800">ตารางงานของฉัน</h2><p className="text-xs text-gray-500">ตรวจสอบวันทำงานและวันหยุดล่าสุด</p></div><div className="flex items-center gap-1"><button onClick={() => move(-1)} className="p-2 border rounded-lg"><FiChevronLeft/></button><input type="month" value={month} onChange={e => setMonth(e.target.value)} className="w-36 border rounded-lg px-2 py-2 text-sm"/><button onClick={() => move(1)} className="p-2 border rounded-lg"><FiChevronRight/></button></div></div>
    <div className="flex gap-3 text-xs"><span className="text-emerald-700">● วันทำงาน</span><span className="text-gray-500">● วันหยุด</span><span className="text-blue-600">● วันหยุดบริษัท</span><span className="text-amber-600">▬ มีการปรับพิเศษ</span></div>
    {loading ? <div className="py-16 text-center text-gray-400">กำลังโหลด...</div> : !employee || !schedule ? <div className="py-16 text-center text-gray-400">ไม่พบข้อมูลตารางงาน กรุณาติดต่อ HR</div> : <div className="bg-white border rounded-2xl overflow-hidden shadow-sm">
      <div className="grid grid-cols-7 bg-gray-50 text-center text-xs font-bold text-gray-500">{['อา.','จ.','อ.','พ.','พฤ.','ศ.','ส.'].map(d => <div key={d} className="py-2">{d}</div>)}</div>
      <div className="grid grid-cols-7">{cells.map((day, i) => {
        if (!day) return <div key={`blank-${i}`} className="min-h-20 border-t border-r bg-gray-50/40"/>
        const date = `${month}-${pad(day)}`; const override = entryMap.get(date); const holiday = holidayMap.get(date); const status = resolveEmployeeDayType(date, schedule, override, holiday)
        const style = status === 'work' ? 'bg-emerald-50 text-emerald-800' : status === 'company_holiday' ? 'bg-blue-50 text-blue-800' : 'bg-gray-50 text-gray-500'
        return <div key={date} className={`relative min-h-20 border-t border-r p-2 ${style} ${override ? 'border-b-4 !border-b-amber-400' : ''}`}><b>{day}</b><div className="mt-2 text-[11px] font-bold">{status === 'work' ? 'ทำงาน' : status === 'company_holiday' ? holiday?.name : 'วันหยุด'}</div>{override?.note && <div className="text-[9px] mt-1 truncate">{override.note}</div>}</div>
      })}</div>
    </div>}
  </div>
}
