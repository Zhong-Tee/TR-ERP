import { useCallback, useEffect, useMemo, useState } from 'react'
import { FiAlertCircle, FiChevronLeft, FiChevronRight, FiMessageSquare, FiX } from 'react-icons/fi'
import { useAuthContext } from '../../../contexts/AuthContext'
import {
  createScoreAppeal,
  fetchAttendanceFacts,
  fetchEmployeeByUserId,
  fetchScoreAppeals,
  fetchScoreCategories,
  fetchScoreEvents,
  fetchScorePeriods,
  fetchScoreRules,
  fetchScoreSettings,
} from '../../../lib/hrApi'
import {
  ABSENCE_GROUP,
  buildMonthlyScores,
  minutesToClock,
  scoringEndDate,
  splitAbsenceGroup,
  type AttendanceFact,
  type ScoreCategory,
  type ScoreEventDraft,
  type ScoreRule,
} from '../../../lib/workScore'
import { localISODate } from '../../../lib/localDate'
import type { HREmployee, HRScoreAppeal, HRScoreEvent, HRScoreSettings } from '../../../types'

const GROUP_LABELS: Record<string, string> = {
  attendance: 'การมาทำงาน',
  attendance_cumulative: 'ทำผิดซ้ำ',
  time_entry: 'การลงเวลา',
  leave: 'การลา',
  [ABSENCE_GROUP]: 'ขาดงาน',
  ot: 'OT',
}

/** เหตุการณ์ในหน้านี้ต้องมี id ของ DB ด้วย เพื่อให้กดทักท้วงได้ */
type PortalEvent = ScoreEventDraft & { dbId?: string }

function monthStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  return monthStr(new Date(y, m - 1 + delta, 1))
}

function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number)
  return { from: `${month}-01`, to: `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` }
}

const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })

const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' })

/** อธิบายเหตุผลของเหตุการณ์จาก detail ที่ engine ใส่ไว้ */
function explain(ev: ScoreEventDraft): string {
  const d = ev.detail as Record<string, unknown>
  const parts: string[] = []
  if (typeof d.late_min === 'number') parts.push(`สาย ${d.late_min} นาที`)
  if (typeof d.early_min === 'number') parts.push(`กลับก่อน ${d.early_min} นาที`)
  if (typeof d.clock_in_min === 'number') parts.push(`เข้า ${minutesToClock(d.clock_in_min)}`)
  if (typeof d.clock_out_min === 'number') parts.push(`ออก ${minutesToClock(d.clock_out_min)}`)
  if (typeof d.certified_min === 'number') parts.push(`หัวหน้ารับรอง ${minutesToClock(d.certified_min)}`)
  if (typeof d.ot_in_min === 'number') parts.push(`เริ่ม OT ${minutesToClock(d.ot_in_min)}`)
  if (typeof d.leave_type === 'string') parts.push(String(d.leave_type))
  if (typeof d.occurrence === 'number') parts.push(`ครั้งที่ ${d.occurrence} (โควตา ${d.allowance})`)
  return parts.join(' · ')
}

export default function EmployeeWorkScore() {
  const { user } = useAuthContext()
  const [me, setMe] = useState<HREmployee | null>(null)
  const [month, setMonth] = useState(monthStr())
  const [category, setCategory] = useState<ScoreCategory | null>(null)
  const [rules, setRules] = useState<ScoreRule[]>([])
  const [settings, setSettings] = useState<HRScoreSettings | null>(null)
  const [events, setEvents] = useState<PortalEvent[]>([])
  const [total, setTotal] = useState(0)
  const [locked, setLocked] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [appeals, setAppeals] = useState<HRScoreAppeal[]>([])
  const [appealFor, setAppealFor] = useState<PortalEvent | null>(null)
  const [appealReason, setAppealReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    Promise.all([
      fetchEmployeeByUserId(user.id),
      fetchScoreCategories(true),
      fetchScoreSettings(),
    ])
      .then(async ([employee, cats, s]) => {
        setMe(employee)
        setSettings(s)
        const first = cats[0] ?? null
        setCategory(first)
        if (first) setRules(await fetchScoreRules(first.id))
      })
      .catch((e) => setError(e.message))
  }, [user?.id])

  const load = useCallback(async () => {
    if (!me || !category || rules.length === 0) return
    setLoading(true)
    setError('')
    try {
      const { from, to } = monthRange(month)
      // ไม่คิดวันในอนาคต/วันนี้ที่ยังไม่จบ — ไม่งั้นจะขึ้นว่าขาดงานทั้งเดือน
      const scoreUntil = scoringEndDate(month, localISODate())
      const [facts, periods, saved, myAppeals] = await Promise.all([
        scoreUntil ? fetchAttendanceFacts(from, scoreUntil, me.id) : Promise.resolve([]),
        fetchScorePeriods(`${month}-01`, category.id),
        fetchScoreEvents({ date_from: from, date_to: to, employee_id: me.id, category_id: category.id }),
        fetchScoreAppeals({ employee_id: me.id }),
      ])
      setAppeals(myAppeals)

      const period = periods.find((p) => p.employee_id === me.id)
      const isLocked = period?.status === 'locked'
      setLocked(isLocked)

      const ruleByCode = new Map(rules.map((r) => [r.event_code, r]))
      const savedById = new Map<string, HRScoreEvent>()
      saved.forEach((ev) => savedById.set(`${ev.event_date}|${ev.event_code}`, ev))

      if (isLocked && period) {
        // รอบปิดแล้ว — ใช้ตัวเลขที่บันทึกไว้ ไม่คำนวณสด
        setTotal(Number(period.total_points))
        setEvents(saved.map((ev) => ({
          employee_id: ev.employee_id,
          event_date: ev.event_date,
          event_code: ev.event_code,
          rule_id: ev.rule_id ?? '',
          category_id: ev.category_id,
          group_code: ruleByCode.get(ev.event_code)?.group_code ?? 'manual',
          label: ruleByCode.get(ev.event_code)?.name ?? ev.note ?? ev.event_code,
          points: Number(ev.points),
          ref_table: ev.ref_table ?? null,
          ref_id: ev.ref_id ?? null,
          detail: ev.detail ?? {},
          dbId: ev.id,
        })))
        return
      }

      const computed = buildMonthlyScores(facts as AttendanceFact[], category, rules).get(me.id)
      const manual = saved.filter((ev) => ev.source === 'manual')
      const all: PortalEvent[] = [
        ...(computed?.events ?? []).map((e) => ({ ...e, dbId: savedById.get(`${e.event_date}|${e.event_code}`)?.id })),
        ...manual.map((ev) => ({
          employee_id: ev.employee_id,
          event_date: ev.event_date,
          event_code: ev.event_code,
          rule_id: ev.rule_id ?? '',
          category_id: ev.category_id,
          group_code: ruleByCode.get(ev.event_code)?.group_code ?? 'manual',
          label: ruleByCode.get(ev.event_code)?.name ?? ev.note ?? ev.event_code,
          points: Number(ev.points),
          ref_table: ev.ref_table ?? null,
          ref_id: ev.ref_id ?? null,
          detail: ev.detail ?? {},
          dbId: ev.id,
        })),
      ]
      const deduction = all.reduce((s, e) => s + e.points, 0)
      setTotal(Math.max(category.min_points, category.base_points + deduction))
      setEvents(all)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดคะแนนไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [me, category, rules, month])

  useEffect(() => { void load() }, [load])

  const byGroup = useMemo(() => {
    const map: Record<string, number> = {}
    events.forEach((e) => { map[e.group_code] = (map[e.group_code] ?? 0) + e.points })
    // ขาดงานต้องแยกจากการลา ให้ตรงกับหน้าคะแนนฝั่ง HR
    return Object.entries(splitAbsenceGroup(map, events))
      .filter(([, v]) => v !== 0)
      .sort((a, b) => a[1] - b[1])
  }, [events])

  const byDate = useMemo(() => {
    const map = new Map<string, PortalEvent[]>()
    events.forEach((e) => {
      const list = map.get(e.event_date) ?? []
      list.push(e)
      map.set(e.event_date, list)
    })
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [events])

  /** คีย์ของเหตุการณ์ที่คำทักท้วงอ้างถึง — ใช้ได้กับคะแนนที่ยังคำนวณสด */
  const appealKey = (date: string, code: string) => `${date}|${code}`

  const appealByEvent = useMemo(
    () => new Map(appeals.map((a) => [appealKey(a.event_date, a.event_code), a])),
    [appeals],
  )

  /** ทักท้วงได้ถ้าเป็นรายการที่หักคะแนน ยังไม่เคยยื่น ยังไม่เกินกำหนด และรอบยังไม่ปิด */
  const canAppeal = (ev: PortalEvent): boolean => {
    if (locked || ev.points >= 0) return false
    const existing = appealByEvent.get(appealKey(ev.event_date, ev.event_code))
    // ที่ถูกปฏิเสธไปแล้วยื่นใหม่ได้ (ตรงกับ unique index ฝั่ง DB)
    if (existing && existing.status !== 'rejected') return false
    const days = settings?.appeal_days ?? 7
    const deadline = new Date(`${ev.event_date}T00:00:00`)
    deadline.setDate(deadline.getDate() + days)
    return new Date() <= deadline
  }

  const submitAppeal = async () => {
    if (!appealFor || !me || !category || !appealReason.trim()) return
    setBusy(true)
    try {
      await createScoreAppeal({
        employee_id: me.id,
        event_date: appealFor.event_date,
        event_code: appealFor.event_code,
        points: appealFor.points,
        category_id: category.id,
        reason: appealReason.trim(),
        score_event_id: appealFor.dbId ?? null,
      })
      setAppealFor(null)
      setAppealReason('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ส่งคำทักท้วงไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  const base = category?.base_points ?? 100
  const ratio = base > 0 ? Math.max(0, Math.min(1, total / base)) : 0
  const tone = ratio >= 0.9 ? 'text-emerald-600' : ratio >= 0.7 ? 'text-amber-500' : 'text-red-500'
  const ring = ratio >= 0.9 ? 'stroke-emerald-500' : ratio >= 0.7 ? 'stroke-amber-400' : 'stroke-red-500'

  return (
    <div className="p-4 space-y-4">
      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 px-3 py-2 text-sm">{error}</div>
      )}

      {/* เลือกเดือน */}
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setMonth(shiftMonth(month, -1))}
          className="p-2 rounded-lg bg-white shadow-sm text-gray-500 active:bg-gray-100">
          <FiChevronLeft className="w-5 h-5" />
        </button>
        <span className="font-semibold text-gray-800">{monthLabel(month)}</span>
        <button type="button" onClick={() => setMonth(shiftMonth(month, 1))}
          disabled={month >= monthStr()}
          className="p-2 rounded-lg bg-white shadow-sm text-gray-500 active:bg-gray-100 disabled:opacity-30">
          <FiChevronRight className="w-5 h-5" />
        </button>
      </div>

      {/* คะแนนรวม */}
      <div className="bg-white rounded-2xl shadow-sm p-5 flex flex-col items-center">
        <div className="relative w-36 h-36">
          <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
            <circle cx="50" cy="50" r="44" className="stroke-gray-100" strokeWidth="9" fill="none" />
            <circle
              cx="50" cy="50" r="44"
              className={ring}
              strokeWidth="9"
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${ratio * 276.5} 276.5`}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={`text-4xl font-bold tabular-nums ${tone}`}>{loading ? '—' : total}</span>
            <span className="text-xs text-gray-400">จาก {base}</span>
          </div>
        </div>
        <div className="mt-2 text-sm text-gray-500">{category?.name ?? 'คะแนนวินัย'}</div>
        {locked && (
          <span className="mt-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs">ปิดรอบแล้ว</span>
        )}
      </div>

      {/* แยกตามหัวข้อ */}
      {byGroup.length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm p-4 space-y-2">
          <div className="text-sm font-medium text-gray-700">หักตามหัวข้อ</div>
          {byGroup.map(([group, points]) => (
            <div key={group} className="flex items-center justify-between text-sm">
              <span className="text-gray-600">{GROUP_LABELS[group] ?? group}</span>
              <span className={`tabular-nums font-medium ${points < 0 ? 'text-red-600' : 'text-gray-400'}`}>{points}</span>
            </div>
          ))}
        </div>
      )}

      {/* รายการเหตุการณ์ */}
      <div className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-10">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
          </div>
        ) : byDate.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm p-8 text-center text-gray-400">
            เดือนนี้ยังไม่มีรายการหักคะแนน 🎉
          </div>
        ) : (
          byDate.map(([date, list]) => (
            <div key={date} className="bg-white rounded-2xl shadow-sm overflow-hidden">
              <div className="px-4 py-2 bg-surface-50 text-sm font-medium text-gray-600">{dayLabel(date)}</div>
              <div className="divide-y divide-surface-100">
                {list.map((ev, i) => {
                  const appeal = appealByEvent.get(appealKey(ev.event_date, ev.event_code))
                  return (
                    <div key={`${ev.event_code}-${i}`} className="px-4 py-3 flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-800">{ev.label}</div>
                        {explain(ev) && <div className="text-xs text-gray-400 mt-0.5">{explain(ev)}</div>}
                        {appeal && (
                          <div className="mt-1 text-xs">
                            {appeal.status === 'pending' && <span className="text-amber-600">ทักท้วงแล้ว รอตรวจสอบ</span>}
                            {appeal.status === 'accepted' && <span className="text-emerald-600">ทักท้วงได้รับการยอมรับ</span>}
                            {appeal.status === 'rejected' && <span className="text-red-500">ทักท้วงถูกปฏิเสธ{appeal.decision_note ? ` — ${appeal.decision_note}` : ''}</span>}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className={`tabular-nums font-semibold ${ev.points < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                          {ev.points}
                        </span>
                        {canAppeal(ev) && (
                          <button type="button" onClick={() => { setAppealFor(ev); setAppealReason('') }}
                            className="flex items-center gap-1 text-xs text-sky-600 active:text-sky-800">
                            <FiMessageSquare className="w-3 h-3" /> ทักท้วง
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {!locked && (
        <div className="flex items-start gap-2 text-xs text-gray-400 px-1">
          <FiAlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            คะแนนของเดือนที่ยังไม่ปิดรอบเป็นการคำนวณสด อาจเปลี่ยนได้ถ้าหัวหน้ารับรองเวลาย้อนหลัง
            {settings ? ` · ทักท้วงได้ภายใน ${settings.appeal_days} วันนับจากวันเกิดเหตุ` : ''}
          </span>
        </div>
      )}

      {/* ฟอร์มทักท้วง */}
      {appealFor && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={() => setAppealFor(null)}>
          <div className="w-full bg-white rounded-t-2xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-gray-800">ทักท้วงคะแนน</span>
              <button type="button" onClick={() => setAppealFor(null)} aria-label="ปิด">
                <FiX className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="text-sm text-gray-600">
              {appealFor.label} · {dayLabel(appealFor.event_date)} · {appealFor.points} คะแนน
            </div>
            <textarea
              rows={4}
              value={appealReason}
              onChange={(e) => setAppealReason(e.target.value)}
              placeholder="อธิบายเหตุผล เช่น วันนั้นได้รับอนุมัติให้เข้าสายจากหัวหน้าแล้ว"
              className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={submitAppeal}
              disabled={busy || !appealReason.trim()}
              className="w-full py-3 rounded-xl bg-emerald-600 text-white font-medium disabled:opacity-40"
            >
              {busy ? 'กำลังส่ง...' : 'ส่งคำทักท้วง'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
