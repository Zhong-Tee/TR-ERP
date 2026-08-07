import { useCallback, useEffect, useMemo, useState } from 'react'
import { FiRefreshCw, FiDownload, FiLock, FiSearch, FiPlus, FiTrash2, FiX, FiAlertCircle } from 'react-icons/fi'
import * as XLSX from 'xlsx'
import Modal from '../ui/Modal'
import PhotoLightbox from './PhotoLightbox'
import { useWmsModal } from '../wms/useWmsModal'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  fetchEmployees,
  getHRFileUrl,
  fetchScoreCategories,
  fetchScoreRules,
  fetchScoreSettings,
  fetchAttendanceFacts,
  fetchScoreEvents,
  fetchScorePeriods,
  fetchEmployeeByUserId,
  commitScorePeriod,
  addManualScoreEvent,
  deleteScoreEvent,
  fetchScoreAppeals,
  acceptScoreAppeal,
  rejectScoreAppeal,
} from '../../lib/hrApi'
import {
  ABSENCE_GROUP,
  buildMonthlyScores,
  indexRules,
  minutesToClock,
  scoringEndDate,
  splitAbsenceGroup,
  summarizeMonth,
  type AttendanceFact,
  type ScoreCategory,
  type ScoreEventDraft,
  type ScoreRule,
  type ScoreSummary,
} from '../../lib/workScore'
import { localISODate } from '../../lib/localDate'
import type { HRScoreAppeal, HRScoreEvent, HRScorePeriod, HRScoreSettings } from '../../types'

const GROUP_LABELS: Record<string, string> = {
  attendance: 'การมาทำงาน',
  attendance_cumulative: 'สะสม',
  time_entry: 'การลงเวลา',
  leave: 'การลา',
  [ABSENCE_GROUP]: 'ขาดงาน',
  ot: 'OT',
}

const inputClass = 'px-3 py-2 rounded-lg border border-surface-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500'

const BUCKET_PHOTOS = 'hr-photos'

/** photo_url อาจเป็น URL เต็ม หรือเป็น path ใน storage — คืน URL ที่แสดงได้ */
function photoDisplayUrl(photoUrl?: string | null): string | null {
  if (!photoUrl) return null
  if (photoUrl.startsWith('http')) return photoUrl
  return getHRFileUrl(BUCKET_PHOTOS, photoUrl)
}

const Loading = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" />
  </div>
)

function monthStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** วันแรก/วันสุดท้ายของเดือน 'YYYY-MM' */
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

/** สีของคะแนน — เขียว/เหลือง/แดง ตามระยะห่างจากคะแนนเต็ม */
function scoreTone(total: number, base: number): string {
  const ratio = base > 0 ? total / base : 1
  if (ratio >= 0.9) return 'text-emerald-600'
  if (ratio >= 0.7) return 'text-amber-600'
  return 'text-red-600'
}

/** id ของแถวใน hr_score_events ที่ฝากไว้ใน detail เพื่อให้ลบเหตุการณ์ที่เพิ่มเองได้จากตาราง */
const EVENT_ID_KEY = '_event_id'

/** เหตุการณ์ที่บันทึกไว้แล้วใน DB → รูปแบบเดียวกับที่ engine คำนวณสด (ใช้แสดงผลร่วมกัน) */
function toDraft(ev: HRScoreEvent, ruleByCode: Map<string, ScoreRule>): ScoreEventDraft {
  const rule = ruleByCode.get(ev.event_code)
  return {
    employee_id: ev.employee_id,
    event_date: ev.event_date,
    event_code: ev.event_code,
    rule_id: ev.rule_id ?? '',
    category_id: ev.category_id,
    group_code: rule?.group_code ?? 'manual',
    label: rule?.name ?? ev.note ?? ev.event_code,
    points: Number(ev.points),
    ref_table: ev.ref_table ?? null,
    ref_id: ev.ref_id ?? null,
    detail: ev.source === 'manual' ? { ...ev.detail, [EVENT_ID_KEY]: ev.id } : (ev.detail ?? {}),
  }
}

/** id ของเหตุการณ์ที่ HR เพิ่มเอง (ลบได้) — null = เหตุการณ์ที่ระบบคำนวณให้ */
const manualEventId = (ev: ScoreEventDraft): string | null => {
  const id = (ev.detail as Record<string, unknown>)[EVENT_ID_KEY]
  return typeof id === 'string' ? id : null
}

/** อธิบายเหตุผลของเหตุการณ์แบบอ่านง่าย จาก detail ที่ engine ใส่ไว้ */
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
  if (typeof d.filed_date === 'string') parts.push(`ยื่นใบลา ${d.filed_date}`)
  if (typeof d.occurrence === 'number') parts.push(`ครั้งที่ ${d.occurrence} (โควตา ${d.allowance})`)
  return parts.join(' · ')
}

interface ScoreRow {
  employeeId: string
  code: string
  /** ชื่อ-สกุล (พร้อมคำนำหน้าถ้ามี) */
  name: string
  nickname: string
  photoUrl: string | null
  locked: boolean
  base: number
  deduction: number
  total: number
  byGroup: Record<string, number>
  events: ScoreEventDraft[]
}

type TabKey = 'summary' | 'appeals'

export default function WorkScore() {
  const { user } = useAuthContext()
  const { showConfirm, ConfirmModal } = useWmsModal()
  const [activeTab, setActiveTab] = useState<TabKey>('summary')
  const [month, setMonth] = useState(monthStr())
  const [categories, setCategories] = useState<ScoreCategory[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [rules, setRules] = useState<ScoreRule[]>([])
  const [settings, setSettings] = useState<HRScoreSettings | null>(null)
  const [rows, setRows] = useState<ScoreRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [detailRow, setDetailRow] = useState<ScoreRow | null>(null)
  const [photoView, setPhotoView] = useState<{ url: string; name: string } | null>(null)
  /** วันสุดท้ายที่คิดคะแนนไปถึง — null = เดือนนี้ยังไม่มีวันที่คิดได้ */
  const [scoredUntil, setScoredUntil] = useState<string | null>(null)
  const [myEmployeeId, setMyEmployeeId] = useState('')

  // ─── ฟอร์มเพิ่มเหตุการณ์เอง ───
  const [manualForm, setManualForm] = useState({ date: '', ruleId: '', points: '', note: '' })

  // ─── แท็บคำทักท้วง ───
  const [appeals, setAppeals] = useState<HRScoreAppeal[]>([])
  const [appealsLoading, setAppealsLoading] = useState(false)
  const [reviewForm, setReviewForm] = useState<{ appeal: HRScoreAppeal; accept: boolean; note: string } | null>(null)
  const [reviewError, setReviewError] = useState('')

  const category = useMemo(() => categories.find((c) => c.id === categoryId) ?? null, [categories, categoryId])
  const ruleByCode = useMemo(() => new Map(rules.map((r) => [r.event_code, r])), [rules])

  useEffect(() => {
    fetchScoreCategories(true)
      .then((list) => {
        setCategories(list)
        setCategoryId((prev) => prev || list[0]?.id || '')
      })
      .catch((e) => setError(e.message))
    fetchScoreSettings().then(setSettings).catch(() => {})
    if (user?.id) fetchEmployeeByUserId(user.id).then((e) => setMyEmployeeId(e?.id ?? '')).catch(() => {})
  }, [user?.id])

  useEffect(() => {
    if (!categoryId) return
    fetchScoreRules(categoryId).then(setRules).catch((e) => setError(e.message))
  }, [categoryId])

  const load = useCallback(async () => {
    if (!category || rules.length === 0) return
    setLoading(true)
    setError('')
    try {
      const { from, to: monthEnd } = monthRange(month)
      // ไม่คิดวันในอนาคต/วันนี้ที่ยังไม่จบ — ไม่งั้นทุกคนจะกลายเป็น "ขาดงาน" ทั้งเดือน
      const scoreUntil = scoringEndDate(month, localISODate())
      setScoredUntil(scoreUntil)
      const [facts, periods, savedEvents, employees] = await Promise.all([
        scoreUntil ? fetchAttendanceFacts(from, scoreUntil) : Promise.resolve([]),
        fetchScorePeriods(`${month}-01`, category.id),
        // เหตุการณ์ที่บันทึกไว้แล้วอ่านทั้งเดือน (HR อาจเพิ่มเองในวันที่ยังไม่ถึงรอบคิด)
        fetchScoreEvents({ date_from: from, date_to: monthEnd, category_id: category.id }),
        // RPC ไม่ได้คืนชื่อเล่น/รูป จึงต้อง join จากทะเบียนพนักงานฝั่ง client
        fetchEmployees(),
      ])
      const employeeById = new Map(employees.map((e) => [e.id, e]))

      const lockedByEmployee = new Map<string, HRScorePeriod>()
      periods.forEach((p) => { if (p.status === 'locked') lockedByEmployee.set(p.employee_id, p) })

      // เหตุการณ์ที่ HR เพิ่มเอง ต้องรวมเข้ากับผลคำนวณสดของรอบที่ยังไม่ปิด
      const manualByEmployee = new Map<string, ScoreEventDraft[]>()
      const savedByEmployee = new Map<string, ScoreEventDraft[]>()
      savedEvents.forEach((ev) => {
        const draft = toDraft(ev, ruleByCode)
        const target = savedByEmployee.get(ev.employee_id) ?? []
        target.push(draft)
        savedByEmployee.set(ev.employee_id, target)
        if (ev.source === 'manual') {
          const list = manualByEmployee.get(ev.employee_id) ?? []
          list.push(draft)
          manualByEmployee.set(ev.employee_id, list)
        }
      })

      const index = indexRules(rules)
      const computed = buildMonthlyScores(facts as AttendanceFact[], category, rules)
      /** ข้อมูลแสดงผลของพนักงาน — เอาจากทะเบียนก่อน ถ้าไม่เจอค่อยใช้ชื่อจาก RPC/รอบคะแนน */
      const whoOf = (employeeId: string, fallbackCode: string, fallbackName: string) => {
        const e = employeeById.get(employeeId)
        return {
          code: e?.employee_code ?? fallbackCode,
          name: e ? `${e.prefix ?? ''} ${e.first_name} ${e.last_name}`.trim() : fallbackName,
          nickname: e?.nickname ?? '',
          photoUrl: photoDisplayUrl(e?.photo_url),
        }
      }

      const nameByEmployee = new Map<string, ReturnType<typeof whoOf>>()
      facts.forEach((f) => nameByEmployee.set(f.employee_id, whoOf(f.employee_id, f.employee_code, f.employee_name)))
      periods.forEach((p) => {
        if (!nameByEmployee.has(p.employee_id) && p.employee) {
          nameByEmployee.set(p.employee_id, whoOf(
            p.employee_id,
            p.employee.employee_code,
            `${p.employee.first_name} ${p.employee.last_name}`,
          ))
        }
      })

      const result: ScoreRow[] = []
      for (const [employeeId, who] of nameByEmployee) {
        const locked = lockedByEmployee.get(employeeId)
        if (locked) {
          // รอบปิดแล้ว — ใช้ตัวเลขที่บันทึกไว้ ไม่คำนวณสด (คะแนนต้องไม่ขยับหลังปิดรอบ)
          const events = savedByEmployee.get(employeeId) ?? []
          const byGroup: Record<string, number> = {}
          events.forEach((e) => { byGroup[e.group_code] = (byGroup[e.group_code] ?? 0) + e.points })
          result.push({
            employeeId, ...who, locked: true,
            base: Number(locked.base_points),
            deduction: Number(locked.raw_deduction),
            total: Number(locked.total_points),
            byGroup: splitAbsenceGroup(byGroup, events), events,
          })
          continue
        }
        const daily = computed.get(employeeId)?.events ?? []
        const summary: ScoreSummary = summarizeMonth(
          employeeId,
          [...daily, ...(manualByEmployee.get(employeeId) ?? [])],
          category,
          index,
        )
        result.push({
          employeeId, ...who, locked: false,
          base: summary.base_points,
          deduction: summary.raw_deduction,
          total: summary.total_points,
          byGroup: splitAbsenceGroup(summary.by_group, summary.events),
          events: summary.events,
        })
      }

      result.sort((a, b) => a.total - b.total || a.name.localeCompare(b.name, 'th'))
      setRows(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [category, rules, ruleByCode, month])

  useEffect(() => { void load() }, [load])

  const loadAppeals = useCallback(async () => {
    setAppealsLoading(true)
    try {
      setAppeals(await fetchScoreAppeals())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดคำทักท้วงไม่สำเร็จ')
    } finally {
      setAppealsLoading(false)
    }
  }, [])

  useEffect(() => { if (activeTab === 'appeals') void loadAppeals() }, [activeTab, loadAppeals])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      r.name.toLowerCase().includes(q)
      || r.code.toLowerCase().includes(q)
      || r.nickname.toLowerCase().includes(q))
  }, [rows, search])

  const groupKeys = useMemo(() => {
    const keys = new Set<string>()
    rows.forEach((r) => Object.keys(r.byGroup).forEach((k) => keys.add(k)))
    return [...keys].sort((a, b) => (GROUP_LABELS[a] ?? a).localeCompare(GROUP_LABELS[b] ?? b, 'th'))
  }, [rows])

  const openCount = rows.filter((r) => !r.locked).length
  const dueForLock = settings ? isPeriodDue(month, settings.lock_day_of_month) : false

  /**
   * ปิดรอบเดือนนี้ — เขียนผลคะแนนลง ledger แล้วล็อกในคำสั่งเดียว (atomic ต่อคน)
   * ระหว่างเดือนไม่ต้องบันทึกอะไร ทุกหน้าคำนวณสดจากข้อเท็จจริง + กติกาปัจจุบัน
   */
  const lockAll = async () => {
    if (!category) return
    const targets = rows.filter((r) => !r.locked)
    if (targets.length === 0) return
    const ok = await showConfirm({
      title: 'ปิดรอบคะแนน',
      message: `ปิดรอบเดือน ${month} ของพนักงาน ${targets.length} คน?\n\nหลังปิดรอบจะแก้คะแนน เพิ่มเหตุการณ์ รับรองเวลาย้อนหลัง และทักท้วงคะแนนของเดือนนี้ไม่ได้อีก`,
      confirmText: 'ปิดรอบ',
    })
    if (!ok) return

    setSaving(true)
    setError('')
    setMessage('')
    try {
      for (const row of targets) {
        await commitScorePeriod({
          employeeId: row.employeeId,
          period: `${month}-01`,
          categoryId: category.id,
          summary: {
            employee_id: row.employeeId,
            base_points: row.base,
            raw_deduction: row.deduction,
            capped_amount: 0,
            total_points: row.total,
            by_group: row.byGroup,
            // เหตุการณ์ที่ HR เพิ่มเองถูกเก็บไว้แล้ว ส่งไปซ้ำจะกลายเป็น auto
            events: row.events.filter((e) => e.rule_id),
          },
          lock: true,
        })
      }
      setMessage(`ปิดรอบเดือน ${month} แล้ว (${targets.length} คน)`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ปิดรอบไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const exportExcel = () => {
    const data = filtered.map((r) => ({
      'รหัสพนักงาน': r.code,
      'ชื่อ-สกุล': r.name,
      'ชื่อเล่น': r.nickname,
      'คะแนนตั้งต้น': r.base,
      ...Object.fromEntries(groupKeys.map((k) => [GROUP_LABELS[k] ?? k, r.byGroup[k] ?? 0])),
      'หักรวม': -r.deduction,
      'คะแนนสุทธิ': r.total,
      'สถานะรอบ': r.locked ? 'ปิดรอบแล้ว' : 'ยังไม่ปิด',
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'คะแนน')
    XLSX.writeFile(wb, `work-score-${month}.xlsx`)
  }

  const addManual = async () => {
    if (!detailRow || !category) return
    const rule = rules.find((r) => r.id === manualForm.ruleId)
    if (!manualForm.date || !rule) {
      setError('เลือกวันที่และกติกาก่อน')
      return
    }
    setSaving(true)
    try {
      await addManualScoreEvent({
        employee_id: detailRow.employeeId,
        event_date: manualForm.date,
        category_id: category.id,
        event_code: rule.event_code,
        points: manualForm.points === '' ? rule.points : Number(manualForm.points),
        note: manualForm.note.trim() || undefined,
      })
      setManualForm({ date: '', ruleId: '', points: '', note: '' })
      setDetailRow(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'เพิ่มเหตุการณ์ไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const removeManual = async (eventId: string) => {
    setSaving(true)
    try {
      await deleteScoreEvent(eventId)
      setDetailRow(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบเหตุการณ์ไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const submitReview = async () => {
    if (!reviewForm) return
    const note = reviewForm.note.trim()
    // ปฏิเสธต้องมีเหตุผลเสมอ — พนักงานต้องรู้ว่าทำไมถึงไม่ได้คะแนนคืน
    if (!reviewForm.accept && !note) {
      setReviewError('ต้องระบุเหตุผลที่ปฏิเสธ')
      return
    }
    setSaving(true)
    setReviewError('')
    try {
      if (reviewForm.accept) await acceptScoreAppeal(reviewForm.appeal.id, note || undefined)
      else await rejectScoreAppeal(reviewForm.appeal.id, myEmployeeId, note)
      setReviewForm(null)
      await loadAppeals()
      await load()
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : 'ตัดสินคำทักท้วงไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-4 space-y-4">
      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">{error}</div>
      )}
      {message && (
        <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 text-sm">{message}</div>
      )}

      <div className="flex gap-2 border-b border-surface-200 flex-wrap">
        {([['summary', 'คะแนนรายเดือน'], ['appeals', 'คำทักท้วง']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className={`px-4 py-2 rounded-t-xl font-medium text-sm ${
              activeTab === key
                ? 'bg-emerald-100 text-emerald-800 border border-b-0 border-emerald-200'
                : 'bg-surface-50 text-gray-600 hover:bg-surface-100'
            }`}
          >
            {label}
            {key === 'appeals' && appeals.filter((a) => a.status === 'pending').length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-red-500 text-white text-xs">
                {appeals.filter((a) => a.status === 'pending').length}
              </span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'summary' && (
        <div className="bg-white rounded-xl shadow p-4 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="block text-gray-500 mb-1">เดือน</span>
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={inputClass} />
            </label>
            {categories.length > 1 && (
              <label className="text-sm">
                <span className="block text-gray-500 mb-1">หมวดคะแนน</span>
                <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputClass}>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <div className="relative">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหาชื่อ / รหัสพนักงาน"
                className={`${inputClass} pl-9 w-56`}
              />
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700"
            >
              <FiRefreshCw className={loading ? 'animate-spin' : ''} /> คำนวณใหม่
            </button>
            <button
              type="button"
              onClick={exportExcel}
              disabled={filtered.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 border border-emerald-600 text-emerald-700 text-sm font-medium rounded-lg hover:bg-emerald-50 disabled:opacity-40"
            >
              <FiDownload /> Export Excel
            </button>
            <button
              type="button"
              onClick={() => void lockAll()}
              disabled={saving || openCount === 0}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg disabled:opacity-40 ${
                dueForLock
                  ? 'bg-amber-500 text-white hover:bg-amber-600'
                  : 'border border-amber-500 text-amber-700 hover:bg-amber-50'
              }`}
            >
              <FiLock /> ปิดรอบ ({openCount})
            </button>
          </div>

          <div className="flex flex-wrap gap-3 text-xs text-gray-500">
            <span>คะแนนตั้งต้น {category?.base_points ?? 100} · ต่ำสุด {category?.min_points ?? 0}</span>
            <span>
              {scoredUntil
                ? `คิดคะแนนถึงวันที่ ${scoredUntil} (ไม่รวมวันนี้ที่ยังไม่จบ)`
                : 'เดือนนี้ยังไม่มีวันที่คิดคะแนนได้'}
            </span>
            <span className="text-sky-600">
              ระหว่างเดือนไม่ต้องบันทึกอะไร — คะแนนคำนวณสดตลอด พนักงานเห็นและทักท้วงได้ทันที · "ปิดรอบ" คือล็อกถาวรตอนสิ้นรอบ
            </span>
            {settings && <span>ปิดรอบวันที่ {settings.lock_day_of_month} ของเดือนถัดไป · รับรองเวลาย้อนหลัง {settings.certify_back_days} วัน</span>}
            {dueForLock && openCount > 0 && (
              <span className="flex items-center gap-1 text-amber-600 font-medium">
                <FiAlertCircle /> รอบนี้ถึงกำหนดปิดแล้ว
              </span>
            )}
          </div>

          {loading ? (
            <Loading />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-emerald-600 text-white">
                    <th className="p-3 text-left font-semibold rounded-tl-xl whitespace-nowrap">รหัสพนักงาน</th>
                    <th className="p-3 text-left font-semibold">ชื่อ-สกุล</th>
                    <th className="p-3 text-left font-semibold">ชื่อเล่น</th>
                    {groupKeys.map((k) => (
                      <th key={k} className="p-3 text-center font-semibold whitespace-nowrap">{GROUP_LABELS[k] ?? k}</th>
                    ))}
                    <th className="p-3 text-center font-semibold">หักรวม</th>
                    <th className="p-3 text-center font-semibold">คะแนน</th>
                    <th className="p-3 text-center font-semibold rounded-tr-xl">รอบ</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, idx) => (
                    <tr
                      key={r.employeeId}
                      onClick={() => setDetailRow(r)}
                      className={`border-t border-surface-200 cursor-pointer hover:bg-emerald-50 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}
                    >
                      <td className="p-3 text-gray-500 whitespace-nowrap">{r.code}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          {r.photoUrl ? (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setPhotoView({ url: r.photoUrl as string, name: r.name }) }}
                              aria-label={`ดูรูป ${r.name} ขนาดใหญ่`}
                              className="shrink-0 rounded-full hover:ring-2 hover:ring-emerald-400 transition-shadow"
                            >
                              <img src={r.photoUrl} alt="" className="w-8 h-8 rounded-full object-cover border border-gray-200" />
                            </button>
                          ) : (
                            <div className="w-8 h-8 shrink-0 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-xs">
                              {r.name[0] ?? '?'}
                            </div>
                          )}
                          <span className="font-medium text-gray-800">{r.name}</span>
                        </div>
                      </td>
                      <td className="p-3 text-gray-600">{r.nickname || '-'}</td>
                      {groupKeys.map((k) => (
                        <td key={k} className={`p-3 text-center tabular-nums ${(r.byGroup[k] ?? 0) < 0 ? 'text-amber-600' : 'text-gray-300'}`}>
                          {r.byGroup[k] ? r.byGroup[k] : '-'}
                        </td>
                      ))}
                      <td className={`p-3 text-center tabular-nums ${r.deduction > 0 ? 'text-red-600' : 'text-gray-300'}`}>
                        {r.deduction > 0 ? `-${r.deduction}` : '-'}
                      </td>
                      <td className={`p-3 text-center text-lg font-bold tabular-nums ${scoreTone(r.total, r.base)}`}>
                        {r.total}
                      </td>
                      <td className="p-3 text-center">
                        {r.locked
                          ? <span className="px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 text-xs">ปิดแล้ว</span>
                          : <span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 text-xs">เปิดอยู่</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && (
                <div className="text-center py-12 text-gray-400">ไม่พบข้อมูลในเดือนนี้</div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'appeals' && (
        <div className="bg-white rounded-xl shadow p-4">
          {appealsLoading ? <Loading /> : appeals.length === 0 ? (
            <div className="text-center py-12 text-gray-400">ยังไม่มีคำทักท้วง</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-emerald-600 text-white">
                    <th className="p-3 text-left font-semibold rounded-tl-xl">พนักงาน</th>
                    <th className="p-3 text-left font-semibold">เหตุการณ์</th>
                    <th className="p-3 text-left font-semibold">เหตุผลที่ทักท้วง</th>
                    <th className="p-3 text-center font-semibold">สถานะ</th>
                    <th className="p-3 text-center font-semibold rounded-tr-xl">จัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {appeals.map((a, idx) => (
                    <tr key={a.id} className={`border-t border-surface-200 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      <td className="p-3">
                        <div className="font-medium">{a.employee ? `${a.employee.first_name} ${a.employee.last_name}` : '-'}</div>
                        <div className="text-xs text-gray-400">{a.employee?.employee_code}</div>
                      </td>
                      <td className="p-3">
                        <div>{ruleByCode.get(a.event_code)?.name ?? a.event_code}</div>
                        <div className="text-xs text-gray-400">
                          {a.event_date} · {Number(a.points)} คะแนน
                        </div>
                      </td>
                      <td className="p-3 max-w-xs">{a.reason}</td>
                      <td className="p-3 text-center">
                        {a.status === 'pending' && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs">รอตรวจสอบ</span>}
                        {a.status === 'accepted' && <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs">ยอมรับ</span>}
                        {a.status === 'rejected' && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs">ปฏิเสธ</span>}
                      </td>
                      <td className="p-3 text-center whitespace-nowrap">
                        {a.status === 'pending' ? (
                          <div className="flex gap-2 justify-center">
                            <button type="button" disabled={saving}
                              onClick={() => { setReviewError(''); setReviewForm({ appeal: a, accept: true, note: '' }) }}
                              className="px-2 py-1 rounded-lg bg-emerald-100 text-emerald-700 text-xs hover:bg-emerald-200">
                              ยอมรับ
                            </button>
                            <button type="button" disabled={saving}
                              onClick={() => { setReviewError(''); setReviewForm({ appeal: a, accept: false, note: '' }) }}
                              className="px-2 py-1 rounded-lg bg-red-100 text-red-700 text-xs hover:bg-red-200">
                              ปฏิเสธ
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">{a.decision_note ?? '-'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ตัดสินคำทักท้วง */}
      <Modal open={!!reviewForm} onClose={() => setReviewForm(null)} closeOnBackdropClick contentClassName="max-w-md">
        {reviewForm && (
          <>
            <div className={`flex items-center justify-between px-4 py-3 text-white ${reviewForm.accept ? 'bg-emerald-600' : 'bg-red-600'}`}>
              <span className="text-sm font-medium">
                {reviewForm.accept ? 'ยอมรับคำทักท้วง' : 'ปฏิเสธคำทักท้วง'}
              </span>
              <button type="button" onClick={() => setReviewForm(null)} aria-label="ปิด">
                <FiX className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="text-sm">
                <div className="font-medium text-gray-800">
                  {reviewForm.appeal.employee
                    ? `${reviewForm.appeal.employee.first_name} ${reviewForm.appeal.employee.last_name}`
                    : '-'}
                </div>
                <div className="text-xs text-gray-400">
                  {ruleByCode.get(reviewForm.appeal.event_code)?.name ?? reviewForm.appeal.event_code}
                  {' · '}{reviewForm.appeal.event_date}
                  {' · '}{Number(reviewForm.appeal.points)} คะแนน
                </div>
              </div>
              <div className="rounded-lg bg-surface-50 border border-surface-200 px-3 py-2 text-sm text-gray-600">
                {reviewForm.appeal.reason}
              </div>
              {reviewError && (
                <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 px-3 py-2 text-sm">{reviewError}</div>
              )}
              <label className="block text-sm">
                <span className="text-gray-600">
                  เหตุผล{reviewForm.accept ? ' (ไม่บังคับ)' : ' (บังคับ)'}
                </span>
                <textarea
                  rows={3}
                  value={reviewForm.note}
                  onChange={(e) => setReviewForm({ ...reviewForm, note: e.target.value })}
                  className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
                />
              </label>
              {reviewForm.accept && (
                <p className="text-xs text-gray-400">
                  ระบบจะคืนคะแนนด้วยเหตุการณ์ชดเชย โดยไม่ลบเหตุการณ์เดิม เพื่อให้ประวัติครบ
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setReviewForm(null)}
                  className="px-4 py-2 rounded-xl bg-surface-100 hover:bg-surface-200 text-sm">ยกเลิก</button>
                <button type="button" onClick={() => void submitReview()} disabled={saving}
                  className={`px-4 py-2 rounded-xl text-white text-sm disabled:opacity-50 ${
                    reviewForm.accept ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'
                  }`}>
                  {saving ? 'กำลังบันทึก...' : reviewForm.accept ? 'ยอมรับและคืนคะแนน' : 'ปฏิเสธ'}
                </button>
              </div>
            </div>
          </>
        )}
      </Modal>

      {ConfirmModal}

      {photoView && <PhotoLightbox url={photoView.url} alt={photoView.name} onClose={() => setPhotoView(null)} />}

      {/* รายละเอียดรายวันของพนักงาน 1 คน */}
      <Modal open={!!detailRow} onClose={() => setDetailRow(null)} closeOnBackdropClick contentClassName="max-w-3xl">
        {detailRow && (
          <>
            <div className="flex items-center justify-between px-4 py-3 bg-emerald-600 text-white">
              <div className="flex items-center gap-2 min-w-0">
                {detailRow.photoUrl && (
                  <img src={detailRow.photoUrl} alt="" className="w-9 h-9 rounded-full object-cover border border-white/40 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="font-medium truncate">
                    {detailRow.name}{detailRow.nickname ? ` (${detailRow.nickname})` : ''}
                  </div>
                  <div className="text-xs opacity-80">{detailRow.code} · เดือน {month}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-2xl font-bold tabular-nums">{detailRow.total}</span>
                <button type="button" onClick={() => setDetailRow(null)} aria-label="ปิด"><FiX className="w-5 h-5" /></button>
              </div>
            </div>
            <div className="p-4 space-y-4 overflow-y-auto">
              {detailRow.events.length === 0 ? (
                <div className="text-center py-8 text-gray-400">ไม่มีเหตุการณ์หักคะแนนในเดือนนี้ 🎉</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-surface-100 border-b border-surface-200">
                    <tr>
                      <th className="text-left py-2 px-3">วันที่</th>
                      <th className="text-left py-2 px-3">เหตุการณ์</th>
                      <th className="text-left py-2 px-3">รายละเอียด</th>
                      <th className="text-center py-2 px-3">คะแนน</th>
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {[...detailRow.events].sort((a, b) => a.event_date.localeCompare(b.event_date)).map((ev, i) => (
                      <tr key={`${ev.event_date}-${ev.event_code}-${i}`} className="border-b border-surface-100">
                        <td className="py-2 px-3 whitespace-nowrap">{ev.event_date}</td>
                        <td className="py-2 px-3">
                          {ev.label}
                          <span className="ml-1.5 text-xs text-gray-400">{GROUP_LABELS[ev.group_code] ?? ev.group_code}</span>
                        </td>
                        <td className="py-2 px-3 text-xs text-gray-500">{explain(ev)}</td>
                        <td className={`py-2 px-3 text-center tabular-nums font-medium ${ev.points < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                          {ev.points}
                        </td>
                        <td className="py-2 px-1 text-center">
                          {!detailRow.locked && manualEventId(ev) && (
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => void removeManual(manualEventId(ev) as string)}
                              title="ลบเหตุการณ์ที่เพิ่มเอง"
                              className="p-1 rounded-lg text-red-500 hover:bg-red-50 disabled:opacity-40"
                            >
                              <FiTrash2 className="w-4 h-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {!detailRow.locked && (
                <div className="rounded-xl border border-surface-200 bg-surface-50 p-3 space-y-2">
                  <div className="text-sm font-medium text-gray-700">เพิ่มเหตุการณ์เอง</div>
                  <div className="flex flex-wrap gap-2">
                    <input type="date" value={manualForm.date} min={monthRange(month).from} max={monthRange(month).to}
                      onChange={(e) => setManualForm({ ...manualForm, date: e.target.value })} className={inputClass} />
                    <select value={manualForm.ruleId} onChange={(e) => setManualForm({ ...manualForm, ruleId: e.target.value })}
                      className={`${inputClass} min-w-52`}>
                      <option value="">— เลือกกติกา —</option>
                      {rules.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.points})</option>)}
                    </select>
                    <input type="number" step="0.5" value={manualForm.points} placeholder="คะแนน (ว่าง = ตามกติกา)"
                      onChange={(e) => setManualForm({ ...manualForm, points: e.target.value })} className={`${inputClass} w-44`} />
                    <input type="text" value={manualForm.note} placeholder="หมายเหตุ"
                      onChange={(e) => setManualForm({ ...manualForm, note: e.target.value })} className={`${inputClass} flex-1 min-w-40`} />
                    <button type="button" disabled={saving} onClick={() => void addManual()}
                      className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-40">
                      <FiPlus /> เพิ่ม
                    </button>
                  </div>
                  <p className="text-xs text-gray-400">
                    เหตุการณ์ที่เพิ่มเองจะไม่หายเมื่อกดคำนวณใหม่ ต้องลบเองจากหน้านี้
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}

/** รอบเดือนนี้ถึงกำหนดปิดหรือยัง (ตรรกะเดียวกับ hr_score_period_due_for_lock ฝั่ง DB) */
function isPeriodDue(month: string, lockDay: number): boolean {
  const [y, m] = month.split('-').map(Number)
  const due = new Date(y, m, lockDay) // m (1-based) = เดือนถัดไปแบบ 0-based
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return now >= due
}
