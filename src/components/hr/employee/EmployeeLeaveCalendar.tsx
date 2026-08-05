import { useCallback, useEffect, useMemo, useState } from 'react'
import { FiChevronLeft, FiChevronRight } from 'react-icons/fi'
import { fetchLeaveCalendar } from '../../../lib/hrApi'
import type { LeaveCalendarEntry } from '../../../lib/hrApi'

const pad = (n: number) => String(n).padStart(2, '0')
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
const dateKey = (d: Date) => `${monthKey(d)}-${pad(d.getDate())}`
const WEEKDAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'] as const

/** ช่วงเวลาลารายชั่วโมง — คืน null เมื่อลาเต็มวัน */
function timeRange(entry: LeaveCalendarEntry): string | null {
  if (entry.leave_mode !== 'hourly' || !entry.start_time || !entry.end_time) return null
  return `${entry.start_time.slice(0, 5)} – ${entry.end_time.slice(0, 5)} น.`
}

export default function EmployeeLeaveCalendar() {
  const [month, setMonth] = useState(() => monthKey(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => dateKey(new Date()))
  const [entries, setEntries] = useState<LeaveCalendarEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [year, mon] = month.split('-').map(Number)
  const lastDay = new Date(year, mon, 0).getDate()
  const start = `${month}-01`
  const end = `${month}-${pad(lastDay)}`
  const todayKey = dateKey(new Date())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setEntries(await fetchLeaveCalendar(start, end))
    } catch (e) {
      setEntries([])
      setError(e instanceof Error ? e.message : 'โหลดปฏิทินลาไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [start, end])

  useEffect(() => {
    load()
  }, [load])

  /** วันที่ (YYYY-MM-DD) → รายการลาของวันนั้น (กระจายใบลาตามช่วงวัน) */
  const leavesByDate = useMemo(() => {
    const map = new Map<string, LeaveCalendarEntry[]>()
    for (const entry of entries) {
      const from = new Date(`${entry.start_date}T00:00:00`)
      const to = new Date(`${entry.end_date}T00:00:00`)
      for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        const key = dateKey(d)
        const list = map.get(key)
        if (list) list.push(entry)
        else map.set(key, [entry])
      }
    }
    return map
  }, [entries])

  const firstWeekday = new Date(year, mon - 1, 1).getDay()
  const cells = [...Array(firstWeekday).fill(null), ...Array.from({ length: lastDay }, (_, i) => i + 1)]
  const move = (delta: number) => {
    const next = new Date(year, mon - 1 + delta, 1)
    setMonth(monthKey(next))
  }

  const selectedLeaves = leavesByDate.get(selectedDate) ?? []
  const selectedLabel = new Date(`${selectedDate}T00:00:00`).toLocaleDateString('th-TH', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  return (
    <div className="p-4 space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">ปฏิทินลา</h2>
        <p className="text-xs text-gray-500">ดูว่าใครลาวันไหนบ้าง</p>
      </div>

      <div className="flex items-center gap-2">
        <button type="button" onClick={() => move(-1)} aria-label="เดือนก่อน" className="p-2 rounded-lg border border-gray-300 text-gray-600 active:bg-gray-100">
          <FiChevronLeft />
        </button>
        <input
          type="month"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
          className="flex-1 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <button type="button" onClick={() => move(1)} aria-label="เดือนถัดไป" className="p-2 rounded-lg border border-gray-300 text-gray-600 active:bg-gray-100">
          <FiChevronRight />
        </button>
      </div>

      <div className="flex items-center gap-4 text-[11px] text-gray-600">
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-300" /> อนุมัติ
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-amber-200 border border-amber-400" /> รออนุมัติ
        </span>
        <button
          type="button"
          onClick={() => {
            const now = new Date()
            setMonth(monthKey(now))
            setSelectedDate(dateKey(now))
          }}
          className="ml-auto rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 active:bg-emerald-100"
        >
          วันนี้
        </button>
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      ) : loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-500 border-t-transparent" />
        </div>
      ) : (
        <>
          <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
            <div className="grid grid-cols-7 bg-gray-50 text-center text-xs font-bold text-gray-500">
              {WEEKDAYS.map((d) => (
                <div key={d} className="py-2">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((day, i) => {
                if (!day) return <div key={`blank-${i}`} className="min-h-14 border-t border-r border-gray-100 bg-gray-50/40" />
                const key = `${month}-${pad(day)}`
                const leaves = leavesByDate.get(key) ?? []
                const hasPending = leaves.some((l) => l.status === 'pending')
                const isSelected = key === selectedDate
                return (
                  <button
                    type="button"
                    key={key}
                    onClick={() => setSelectedDate(key)}
                    aria-pressed={isSelected}
                    aria-label={`ดูรายการลาวันที่ ${day}`}
                    className={`relative min-h-14 border-t border-r border-gray-100 p-1.5 text-left transition-colors ${
                      leaves.length ? (hasPending ? 'bg-amber-50' : 'bg-emerald-50') : 'bg-white'
                    } ${isSelected ? 'ring-2 ring-inset ring-emerald-500' : ''}`}
                  >
                    <span
                      className={`text-sm font-semibold ${
                        key === todayKey ? 'text-emerald-600 underline' : 'text-gray-700'
                      }`}
                    >
                      {day}
                    </span>
                    {leaves.length > 0 && (
                      <span
                        className={`absolute bottom-1 right-1 rounded-full px-1.5 text-[10px] font-bold ${
                          hasPending ? 'bg-amber-200 text-amber-900' : 'bg-emerald-200 text-emerald-900'
                        }`}
                      >
                        {leaves.length}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <section>
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="font-semibold text-gray-900">รายการลา</h3>
                <p className="text-xs text-gray-500">{selectedLabel}</p>
              </div>
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                {selectedLeaves.length} คนลา
              </span>
            </div>
            <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
              {selectedLeaves.length === 0 ? (
                <p className="p-4 text-center text-gray-500 text-sm">ไม่มีผู้ลาในวันนี้</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {selectedLeaves.map((l) => (
                    <li key={`${selectedDate}-${l.id}`} className="flex items-start justify-between gap-2 p-4">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900 truncate">{l.employee_name}</p>
                        <p className="text-xs text-gray-500 truncate">
                          {[l.position_name, l.department_name].filter(Boolean).join(' · ') || '-'}
                        </p>
                        <p className="text-xs text-gray-600 mt-0.5">
                          {timeRange(l) ?? (l.start_date === l.end_date ? 'ลาเต็มวัน' : `${l.start_date} – ${l.end_date}`)}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          l.status === 'approved' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {l.status === 'approved' ? 'อนุมัติ' : 'รออนุมัติ'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
