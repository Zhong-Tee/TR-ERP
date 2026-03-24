import { useCallback, useEffect, useMemo, useState } from 'react'
import { FiImage, FiPrinter } from 'react-icons/fi'
import { Link } from 'react-router-dom'
import { useAuthContext } from '../contexts/AuthContext'
import { useMenuAccess } from '../contexts/MenuAccessContext'
import { supabase } from '../lib/supabase'
import {
  MACHINERY_STATUS_LABELS,
  type MachineryMachine,
  type MachineryEvent,
  type PrMachineryStatus,
  fetchMachines,
  upsertMachine,
  deleteMachine,
  changeMachineStatus,
  fetchEventsOverlappingRange,
  computeEffectiveUnitsToday,
  computeWorkingTimeInShiftMsToday,
  computeShiftDurationMsForDay,
  formatMsAsHms,
  summarizeDayForMachine,
  totalProductionCapacityPerShift,
  uploadMachineryPhoto,
  computeRepairRounds,
  computeEventDurationMs,
  formatDurationHoursMinutes,
  type DailySummaryRow,
} from '../lib/machineryApi'
import { isSuperadmin } from '../config/accessPolicy'

type TabKey = 'monitor' | 'settings' | 'history'

const STATUS_ORDER: PrMachineryStatus[] = [
  'working',
  'broken',
  'repairing',
  'idle',
  'decommissioned',
  'power_off',
]
const STATUS_SUMMARY_ORDER: PrMachineryStatus[] = ['working', 'broken', 'repairing', 'idle', 'decommissioned']

/** พื้นหลังการ์ดมอนิเตอร์ — เข้ม ตามสถานะ: เขียว / แดง / เหลือง / ฟ้า / เทา */
function monitorCardShellClass(status: PrMachineryStatus): string {
  const map: Record<PrMachineryStatus, string> = {
    working:
      'border-emerald-400/95 bg-gradient-to-br from-emerald-950 via-emerald-900 to-slate-950 ring-2 ring-emerald-500/70 shadow-xl shadow-emerald-950/50',
    broken:
      'border-red-400/95 bg-gradient-to-br from-red-950 via-red-900 to-slate-950 ring-2 ring-red-500/70 shadow-xl shadow-red-950/50',
    repairing:
      'border-yellow-400/95 bg-gradient-to-br from-yellow-950 via-amber-950 to-slate-950 ring-2 ring-yellow-500/70 shadow-xl shadow-amber-950/50',
    idle:
      'border-sky-400/95 bg-gradient-to-br from-sky-950 via-sky-900 to-slate-950 ring-2 ring-sky-500/70 shadow-xl shadow-sky-950/50',
    decommissioned:
      'border-zinc-500/95 bg-gradient-to-br from-zinc-900 via-zinc-950 to-slate-950 ring-2 ring-zinc-500/60 shadow-xl shadow-black/50',
    power_off:
      'border-white/95 bg-gradient-to-br from-slate-100 via-white to-slate-200 ring-2 ring-white/95 shadow-xl shadow-slate-300/60',
  }
  return `rounded-2xl border overflow-hidden flex flex-col min-h-[12rem] ${map[status]}`
}

function monitorStatusBarClass(status: PrMachineryStatus): string {
  const map: Record<PrMachineryStatus, string> = {
    working: 'bg-emerald-700/95 text-white',
    broken: 'bg-red-700/95 text-white',
    repairing: 'bg-yellow-500/95 text-gray-900',
    idle: 'bg-sky-600/95 text-white',
    decommissioned: 'bg-zinc-600/95 text-white',
    power_off: 'bg-white text-slate-900',
  }
  return `absolute bottom-0 left-0 right-0 px-2.5 py-1.5 text-xs font-bold backdrop-blur-sm ${map[status]}`
}

export default function Machinery() {
  const { user, signOut } = useAuthContext()
  const { hasAccess } = useMenuAccess()
  const [loggingOut, setLoggingOut] = useState(false)
  const [tab, setTab] = useState<TabKey>('monitor')
  const [machines, setMachines] = useState<MachineryMachine[]>([])
  const [events, setEvents] = useState<MachineryEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)

  const showSettingsTab =
    user?.role !== 'production_mb' &&
    user?.role !== 'manager' &&
    user?.role !== 'technician' &&
    (isSuperadmin(user?.role) || hasAccess('machinery-settings'))

  useEffect(() => {
    if (!showSettingsTab && tab === 'settings') setTab('monitor')
  }, [showSettingsTab, tab])

  const isMobileRole =
    user?.role === 'production_mb' || user?.role === 'manager' || user?.role === 'technician'

  const handleLogout = async () => {
    if (!confirm('ออกจากระบบ?')) return
    setLoggingOut(true)
    try {
      await signOut()
    } finally {
      setLoggingOut(false)
    }
  }

  const [histFrom, setHistFrom] = useState(() => new Date().toISOString().slice(0, 10))
  const [histTo, setHistTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [histMachineId, setHistMachineId] = useState<string>('')
  /** กรองตารางช่วงสถานะ — ว่าง = ทั้งหมด */
  const [histStatus, setHistStatus] = useState<'' | PrMachineryStatus>('')
  /** อัปเดตทุกวินาที — จับเวลาในกะที่หน้ามอนิเตอร์ */
  const [monitorTick, setMonitorTick] = useState(() => Date.now())

  const load = useCallback(async () => {
    setError(null)
    try {
      const m = await fetchMachines()
      setMachines(m)
      const from = new Date()
      from.setDate(from.getDate() - 2)
      from.setHours(0, 0, 0, 0)
      const to = new Date()
      to.setDate(to.getDate() + 2)
      to.setHours(23, 59, 59, 999)
      const ev = await fetchEventsOverlappingRange(from.toISOString(), to.toISOString())
      setEvents(ev)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const ch = supabase
      .channel('machinery-rt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pr_machinery_machines' },
        () => {
          load()
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pr_machinery_status_events' },
        () => {
          load()
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [load])

  useEffect(() => {
    if (tab !== 'monitor') return
    const id = window.setInterval(() => setMonitorTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [tab])

  const statusCounts = useMemo(() => {
    const c: Record<PrMachineryStatus, number> = {
      working: 0,
      broken: 0,
      repairing: 0,
      idle: 0,
      decommissioned: 0,
      power_off: 0,
    }
    for (const m of machines) {
      c[m.current_status]++
    }
    return c
  }, [machines])

  const totalEffectiveToday = useMemo(() => {
    return machines.reduce((sum, m) => sum + computeEffectiveUnitsToday(m, events), 0)
  }, [machines, events])

  /** ผลรวมกำลังผลิตรวม/วัน (ชม.กะ × หน่วย/ชม.) ของทุกเครื่อง */
  const totalMaxProductionPerDay = useMemo(() => {
    return machines.reduce((sum, m) => sum + totalProductionCapacityPerShift(m), 0)
  }, [machines])

  const onStatusChange = async (machineId: string, status: PrMachineryStatus) => {
    setSavingId(machineId)
    setError(null)
    try {
      await changeMachineStatus(machineId, status)
      await load()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSavingId(null)
    }
  }

  const [form, setForm] = useState<Partial<MachineryMachine>>({
    name: '',
    location: '',
    work_start: '08:00',
    work_end: '17:00',
    capacity_units_per_hour: 0,
    sort_order: 0,
    image_url: null,
  })
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoRemove, setPhotoRemove] = useState(false)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (photoPreview?.startsWith('blob:')) URL.revokeObjectURL(photoPreview)
    }
  }, [photoPreview])

  const resetForm = () => {
    if (photoPreview?.startsWith('blob:')) URL.revokeObjectURL(photoPreview)
    setForm({
      name: '',
      location: '',
      work_start: '08:00',
      work_end: '17:00',
      capacity_units_per_hour: 0,
      sort_order: 0,
      image_url: null,
    })
    setPhotoFile(null)
    setPhotoRemove(false)
    setPhotoPreview(null)
  }

  const saveMachine = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name?.trim()) return
    setError(null)
    try {
      const base = {
        id: form.id,
        name: form.name.trim(),
        location: form.location || null,
        work_start: normalizeTime(form.work_start || '08:00'),
        work_end: normalizeTime(form.work_end || '17:00'),
        capacity_units_per_hour: Number(form.capacity_units_per_hour) || 0,
        sort_order: Number(form.sort_order) || 0,
      }
      if (photoRemove && form.id) {
        await upsertMachine({ ...base, name: base.name, image_url: null })
      } else if (photoFile) {
        const saved = await upsertMachine({ ...base, name: base.name })
        const url = await uploadMachineryPhoto(saved.id, photoFile)
        await upsertMachine({ id: saved.id, name: saved.name, image_url: url })
      } else {
        await upsertMachine({ ...base, name: base.name })
      }
      resetForm()
      await load()
    } catch (err: any) {
      setError(err?.message || String(err))
    }
  }

  const editMachine = (m: MachineryMachine) => {
    if (photoPreview?.startsWith('blob:')) URL.revokeObjectURL(photoPreview)
    setPhotoFile(null)
    setPhotoRemove(false)
    setPhotoPreview(m.image_url || null)
    setForm({
      id: m.id,
      name: m.name,
      location: m.location || '',
      work_start: m.work_start.slice(0, 5),
      work_end: m.work_end.slice(0, 5),
      capacity_units_per_hour: m.capacity_units_per_hour,
      sort_order: m.sort_order,
      image_url: m.image_url ?? null,
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const removeMachine = async (id: string) => {
    if (!confirm('ลบเครื่องนี้?')) return
    try {
      await deleteMachine(id)
      await load()
    } catch (err: any) {
      setError(err?.message || String(err))
    }
  }

  const [histLoading, setHistLoading] = useState(false)
  const [histEvents, setHistEvents] = useState<MachineryEvent[]>([])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (tab !== 'history') return
      setHistLoading(true)
      try {
        const [fy, fm, fd] = histFrom.split('-').map(Number)
        const [ty, tm, td] = histTo.split('-').map(Number)
        const from = new Date(fy, fm - 1, fd, 0, 0, 0, 0).toISOString()
        const toEnd = new Date(ty, tm - 1, td, 23, 59, 59, 999).toISOString()
        const ev = await fetchEventsOverlappingRange(from, toEnd, histMachineId || null)
        if (!cancelled) setHistEvents(ev)
      } catch {
        if (!cancelled) setHistEvents([])
      } finally {
        if (!cancelled) setHistLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [histFrom, histTo, histMachineId, tab])

  const historyRowsComputed = useMemo(() => {
    const fromD = new Date(histFrom + 'T12:00:00')
    const toD = new Date(histTo + 'T12:00:00')
    const rows: DailySummaryRow[] = []
    for (let t = fromD.getTime(); t <= toD.getTime(); t += 86400000) {
      const day = new Date(t)
      const ms = machines.filter((m) => !histMachineId || m.id === histMachineId)
      for (const m of ms) {
        rows.push(summarizeDayForMachine(m, day, histEvents))
      }
    }
    return rows
  }, [histFrom, histTo, histMachineId, machines, histEvents])

  const repairRoundsFiltered = useMemo(() => {
    const ms = machines.filter((m) => !histMachineId || m.id === histMachineId)
    const [fy, fm, fd] = histFrom.split('-').map(Number)
    const [ty, tm, td] = histTo.split('-').map(Number)
    const rangeStart = new Date(fy, fm - 1, fd, 0, 0, 0, 0).getTime()
    const rangeEnd = new Date(ty, tm - 1, td, 23, 59, 59, 999).getTime()
    return computeRepairRounds(ms, histEvents, new Date()).filter((r) => {
      const bt = new Date(r.broken_at).getTime()
      return bt >= rangeStart && bt <= rangeEnd
    })
  }, [histFrom, histTo, histMachineId, machines, histEvents])

  const statusSegmentsSorted = useMemo(() => {
    let list = [...histEvents]
    if (histMachineId) {
      list = list.filter((e) => e.machine_id === histMachineId)
    }
    if (histStatus) {
      list = list.filter((e) => e.status === histStatus)
    }
    return list
  }, [histEvents, histMachineId, histStatus])

  const statusSegmentsDisplay = useMemo(() => {
    return [...statusSegmentsSorted]
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
      .map((ev) => ({
        ev,
        durationMs: computeEventDurationMs(ev, new Date()),
      }))
  }, [statusSegmentsSorted])

  if (loading) {
    return (
      <div
        className={`flex justify-center items-center py-24 ${isMobileRole ? 'min-h-screen w-full bg-slate-900' : ''}`}
      >
        <div
          className={`animate-spin rounded-full h-12 w-12 border-b-2 ${isMobileRole ? 'border-emerald-400' : 'border-emerald-600'}`}
        />
      </div>
    )
  }

  const pageText = isMobileRole ? 'text-slate-100 text-sm sm:text-base' : 'text-gray-900 text-sm sm:text-base lg:text-lg'

  return (
    <div className={isMobileRole ? 'min-h-screen w-full bg-slate-900' : 'w-full max-w-none'}>
      <div
        className={`w-full max-w-none mx-auto space-y-5 ${pageText} ${
          isMobileRole ? 'px-3 pb-10 pt-2' : 'px-2 sm:px-4 lg:px-6 pb-8 pt-1'
        }`}
      >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <span
            className={`mt-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${
              isMobileRole
                ? 'bg-slate-800 text-emerald-400 ring-1 ring-slate-600'
                : 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/80'
            }`}
            aria-hidden
          >
            <FiPrinter className="h-7 w-7" />
          </span>
          <div>
            <h1
              className={`text-xl sm:text-2xl lg:text-3xl font-bold tracking-tight ${
                isMobileRole ? 'text-white' : 'text-gray-900'
              }`}
            >
              Machinery
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isMobileRole && user?.role !== 'technician' && (
            <Link
              to="/wms"
              className="inline-flex items-center justify-center gap-2 text-sm font-bold px-4 py-2.5 rounded-xl text-white bg-gradient-to-b from-red-500 to-red-600 shadow-md shadow-red-500/35 ring-1 ring-inset ring-white/20 hover:from-red-600 hover:to-red-700 hover:shadow-lg hover:shadow-red-600/30 active:scale-[0.98] transition-all duration-150"
            >
              <i className="fas fa-arrow-left text-xs opacity-95" aria-hidden />
              ย้อนกลับ
            </Link>
          )}
          {user?.role === 'technician' && (
            <span className="flex items-center gap-2">
              <span className={`text-xs font-medium ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>
                มือถือ · ช่างเทคนิค
              </span>
              <button
                type="button"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
                className="text-sm font-bold px-3 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {loggingOut ? 'กำลังออก...' : 'ออกจากระบบ'}
              </button>
            </span>
          )}
        </div>
      </header>

      {error && (
        <div
          className={`rounded-lg px-4 py-3 text-sm sm:text-base border ${
            isMobileRole
              ? 'bg-red-950/50 text-red-200 border-red-800/60'
              : 'bg-red-50 text-red-800 border-red-200'
          }`}
        >
          {error}
        </div>
      )}

      <nav className={`flex gap-1 flex-wrap border-b ${isMobileRole ? 'border-slate-700' : 'border-gray-200'}`}>
        {(['monitor', 'settings', 'history'] as TabKey[]).map((k) => {
          if (k === 'settings' && !showSettingsTab) return null
          const labels: Record<TabKey, string> = {
            monitor: 'สถานะ / มอนิเตอร์',
            settings: 'ตั้งค่าเครื่อง',
            history: 'ประวัติ / รายงาน',
          }
          return (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`px-4 py-2.5 text-sm sm:text-base font-semibold rounded-t-lg border-b-2 -mb-px ${
                tab === k
                  ? isMobileRole
                    ? 'border-emerald-500 text-emerald-400'
                    : 'border-emerald-600 text-emerald-700'
                  : isMobileRole
                    ? 'border-transparent text-gray-400 hover:text-gray-200'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {labels[k]}
            </button>
          )
        })}
      </nav>

      {tab === 'monitor' && (
        <section className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div
              className={`rounded-xl border p-4 text-center shadow-sm ${
                isMobileRole
                  ? 'border-emerald-600/60 bg-emerald-950/30 ring-1 ring-emerald-700/50 shadow-black/25'
                  : 'border-emerald-300 bg-emerald-50/80 shadow-sm ring-1 ring-emerald-200/60'
              }`}
            >
              <div className={`text-xs font-medium ${isMobileRole ? 'text-emerald-300/90' : 'text-emerald-800'}`}>
                จำนวนรวม / ปิดเครื่อง
              </div>
              <div
                className={`text-2xl sm:text-3xl font-black tabular-nums ${
                  isMobileRole ? 'text-white' : 'text-emerald-900'
                }`}
              >
                {machines.length}/{statusCounts.power_off}
              </div>
            </div>
            {STATUS_SUMMARY_ORDER.map((s) => (
              <div
                key={s}
                className={`rounded-xl border p-4 text-center shadow-sm ${
                  isMobileRole
                    ? 'border-slate-600 bg-slate-800/90 shadow-black/25'
                    : 'border-gray-200 bg-white shadow-sm'
                }`}
              >
                <div className={`text-xs ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>
                  {MACHINERY_STATUS_LABELS[s]}
                </div>
                <div className={`text-2xl sm:text-3xl font-black tabular-nums ${isMobileRole ? 'text-white' : 'text-gray-900'}`}>
                  {statusCounts[s]}
                </div>
              </div>
            ))}
          </div>
          <div
            className={`rounded-xl border px-4 py-4 sm:px-5 sm:py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${
              isMobileRole
                ? 'border-emerald-700/40 bg-emerald-950/40 text-emerald-100'
                : 'border-emerald-200 bg-emerald-50 text-emerald-900'
            }`}
          >
            <div>
              <span className="font-semibold text-sm sm:text-base">กำลังผลิตสะสมวันนี้: </span>
              <span className="text-xl sm:text-2xl font-black tabular-nums">{fmtInt(totalEffectiveToday)}</span>
              <span className={`text-sm sm:text-base ml-1 ${isMobileRole ? 'text-emerald-200/90' : ''}`}>
                หน่วย (จากชม.ทำงาน × หน่วย/ชม.)
              </span>
            </div>
            <div
              className={`sm:text-right sm:pl-4 sm:border-l ${
                isMobileRole ? 'sm:border-emerald-700/40' : 'sm:border-emerald-300/80'
              }`}
            >
              <span className="font-semibold text-sm sm:text-base">กำลังผลิตสูงสุด: </span>
              <span className="text-xl sm:text-2xl font-black tabular-nums">{fmtInt(totalMaxProductionPerDay)}</span>
              <span className={`text-sm sm:text-base ml-1 ${isMobileRole ? 'text-emerald-200/90' : ''}`}>
                หน่วย (รวมกำลังผลิตรวม/วันทุกเครื่อง)
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
            {machines.length === 0 && (
              <div
                className={`col-span-full rounded-2xl border px-6 py-12 text-center text-sm sm:text-base ${
                  isMobileRole ? 'border-slate-600 bg-slate-800/60 text-gray-400' : 'border-gray-200 bg-gray-50 text-gray-500'
                }`}
              >
                ยังไม่มีเครื่อง — ไปแท็บตั้งค่าเพื่อเพิ่ม
              </div>
            )}
            {machines.map((m) => {
              const now = new Date(monitorTick)
              const workingMs = computeWorkingTimeInShiftMsToday(m, events, now)
              const shiftTotalMs = computeShiftDurationMsForDay(m, now)
              const units = computeEffectiveUnitsToday(m, events)
              const st = m.current_status
              const isPowerOff = st === 'power_off'
              const textColor = isPowerOff ? 'text-slate-900' : 'text-white'
              const subTextColor = isPowerOff ? 'text-slate-700' : 'text-white'
              return (
                <article key={m.id} className={monitorCardShellClass(st)}>
                  <div className="relative aspect-[4/3] w-full shrink-0 bg-black/50">
                    {m.image_url ? (
                      <img
                        src={m.image_url}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-slate-400">
                        <FiImage className="h-12 w-12 opacity-60" aria-hidden />
                        <span className="text-xs font-medium">ยังไม่มีรูป</span>
                      </div>
                    )}
                    <div className={monitorStatusBarClass(st)}>{MACHINERY_STATUS_LABELS[st]}</div>
                  </div>
                  <div className={`flex flex-1 flex-col gap-2.5 p-3 ${textColor}`}>
                    <div>
                      <h3 className="text-base sm:text-lg font-bold leading-tight">{m.name}</h3>
                      <p className={`mt-0.5 text-xs sm:text-sm ${subTextColor}`}>
                        สถานที่ {m.location?.trim() ? m.location : '—'}
                      </p>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-xs sm:text-sm">
                      <dt>เวลาในกะ (จับเวลา)</dt>
                      <dd className="text-right font-mono tabular-nums font-semibold text-[11px] sm:text-sm">
                        {formatMsAsHms(workingMs)} / {formatMsAsHms(shiftTotalMs)}
                      </dd>
                      <dt>กำลังผลิต/ชม.</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {fmtInt(Number(m.capacity_units_per_hour))} หน่วย
                      </dd>
                      <dt>กำลังผลิตรวม/วัน</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {fmtInt(totalProductionCapacityPerShift(m))} หน่วย
                      </dd>
                      <dt>ผลิตวันนี้</dt>
                      <dd className="text-right font-mono tabular-nums font-semibold">
                        {fmtInt(units)} หน่วย
                      </dd>
                    </dl>
                    <label className="mt-auto block text-xs">
                      <span className="mb-0.5 block font-medium">เปลี่ยนสถานะ</span>
                      <select
                        className={`w-full rounded-lg border px-2.5 py-2 text-sm ${
                          isPowerOff
                            ? 'border-slate-300 bg-white text-slate-900'
                            : 'border-slate-500/80 bg-slate-950/80 text-white'
                        }`}
                        value={m.current_status}
                        disabled={savingId === m.id}
                        onChange={(e) => onStatusChange(m.id, e.target.value as PrMachineryStatus)}
                      >
                        {STATUS_ORDER.map((s) => (
                          <option key={s} value={s}>
                            {MACHINERY_STATUS_LABELS[s]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {tab === 'settings' && showSettingsTab && (
        <section className="space-y-6">
          <form
            onSubmit={saveMachine}
            className={`rounded-xl border p-5 sm:p-6 shadow-sm space-y-4 ${
              isMobileRole
                ? 'border-slate-600 bg-slate-800/90 shadow-black/30'
                : 'border-gray-200 bg-white'
            }`}
          >
            <h2
              className={`text-xl sm:text-2xl font-bold ${isMobileRole ? 'text-white' : 'text-gray-900'}`}
            >
              {form.id ? 'แก้ไขเครื่อง' : 'เพิ่มเครื่อง'}
            </h2>
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block">
                <span className={`text-sm ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>ชื่อเครื่อง *</span>
                <input
                  className={`mt-1 w-full border rounded-lg px-3 py-2.5 text-base ${
                    isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                  }`}
                  value={form.name || ''}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
              </label>
              <label className="block">
                <span className={`text-sm ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>สถานที่</span>
                <input
                  className={`mt-1 w-full border rounded-lg px-3 py-2.5 text-base ${
                    isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                  }`}
                  value={form.location || ''}
                  onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className={`text-sm ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>เริ่มกะ</span>
                <input
                  type="time"
                  className={`mt-1 w-full border rounded-lg px-3 py-2.5 text-base ${
                    isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                  }`}
                  value={form.work_start || ''}
                  onChange={(e) => setForm((f) => ({ ...f, work_start: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className={`text-sm ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>สิ้นสุดกะ</span>
                <input
                  type="time"
                  className={`w-full border rounded-lg px-3 py-2.5 text-base ${
                    isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                  }`}
                  value={form.work_end || ''}
                  onChange={(e) => setForm((f) => ({ ...f, work_end: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className={`text-sm ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>
                  กำลังผลิต (หน่วย/ชม.)
                </span>
                <input
                  type="number"
                  step="0.0001"
                  className={`mt-1 w-full border rounded-lg px-3 py-2.5 text-base ${
                    isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                  }`}
                  value={form.capacity_units_per_hour ?? 0}
                  onChange={(e) => setForm((f) => ({ ...f, capacity_units_per_hour: parseFloat(e.target.value) }))}
                />
              </label>
              <label className="block">
                <span className={`text-sm ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>ลำดับแสดง</span>
                <input
                  type="number"
                  className={`mt-1 w-full border rounded-lg px-3 py-2.5 text-base ${
                    isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                  }`}
                  value={form.sort_order ?? 0}
                  onChange={(e) => setForm((f) => ({ ...f, sort_order: parseInt(e.target.value, 10) }))}
                />
              </label>
              <div className="sm:col-span-2 space-y-2">
                <span className={`text-sm ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>รูปเครื่อง (JPEG/PNG/WebP)</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className={`block w-full text-base file:mr-3 file:rounded-lg file:border-0 file:px-3 file:py-2 file:font-semibold ${
                    isMobileRole
                      ? 'file:bg-slate-700 file:text-slate-100 text-gray-300'
                      : 'file:bg-emerald-600 file:text-white text-gray-700'
                  }`}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (!f) return
                    if (photoPreview?.startsWith('blob:')) URL.revokeObjectURL(photoPreview)
                    setPhotoFile(f)
                    setPhotoPreview(URL.createObjectURL(f))
                    setPhotoRemove(false)
                  }}
                />
                {(photoRemove ? null : photoPreview || form.image_url) && (
                  <div className="flex flex-wrap items-end gap-3">
                    <img
                      src={(photoRemove ? null : photoPreview || form.image_url) || ''}
                      alt=""
                      className={`h-28 w-40 rounded-xl object-cover border ${
                        isMobileRole ? 'border-slate-600/50' : 'border-gray-200'
                      }`}
                    />
                    <button
                      type="button"
                      className={`text-sm font-semibold px-3 py-2 rounded-lg ${
                        isMobileRole ? 'bg-red-900/50 text-red-300 hover:bg-red-900/70' : 'bg-red-100 text-red-800 hover:bg-red-200'
                      }`}
                      onClick={() => {
                        if (photoPreview?.startsWith('blob:')) URL.revokeObjectURL(photoPreview)
                        setPhotoFile(null)
                        setPhotoPreview(null)
                        setPhotoRemove(true)
                      }}
                    >
                      ลบรูป (บันทึกเพื่อยืนยัน)
                    </button>
                  </div>
                )}
                {photoRemove && form.id && (
                  <p className={`text-sm ${isMobileRole ? 'text-amber-300/90' : 'text-amber-800'}`}>
                    จะลบรูปออกจากเครื่องนี้เมื่อกดบันทึก
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                className="px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-base font-semibold hover:bg-emerald-700"
              >
                บันทึก
              </button>
              {form.id && (
                <button
                  type="button"
                  className={`px-4 py-2 rounded-lg ${
                    isMobileRole ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-gray-200 text-gray-800'
                  }`}
                  onClick={() => {
                    resetForm()
                  }}
                >
                  ยกเลิกการแก้ไข
                </button>
              )}
            </div>
          </form>

          <div
            className={`overflow-x-auto rounded-xl border shadow-sm ${
              isMobileRole ? 'border-slate-600 bg-slate-800/90 shadow-black/30' : 'border-gray-200 bg-white'
            }`}
          >
            <table className="min-w-full text-base sm:text-lg">
              <thead
                className={`text-left ${isMobileRole ? 'bg-slate-800/90 text-gray-300' : 'bg-gray-50 text-gray-600'}`}
              >
                <tr>
                  <th className="px-3 py-3 whitespace-nowrap">ลำดับ</th>
                  <th className="px-3 py-3 whitespace-nowrap w-16">รูป</th>
                  <th className="px-3 py-3 whitespace-nowrap">เครื่อง</th>
                  <th className="px-3 py-3 whitespace-nowrap min-w-[8rem]">สถานที่</th>
                  <th className="px-3 py-3 whitespace-nowrap">กะ</th>
                  <th className="px-3 py-3 whitespace-nowrap">units/ชม.</th>
                  <th className="px-3 py-3 whitespace-nowrap">กำลังผลิตรวม</th>
                  <th className="px-3 py-3 whitespace-nowrap text-right" />
                </tr>
              </thead>
              <tbody>
                {machines.map((m) => (
                  <tr key={m.id} className={`border-t ${isMobileRole ? 'border-slate-700' : 'border-gray-100'}`}>
                    <td className={`px-3 py-3 tabular-nums text-center ${isMobileRole ? 'text-gray-300' : 'text-gray-700'}`}>
                      {m.sort_order}
                    </td>
                    <td className="px-3 py-2">
                      {m.image_url ? (
                        <img src={m.image_url} alt="" className="h-10 w-14 rounded object-cover" loading="lazy" />
                      ) : (
                        <span className={`text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-400'}`}>—</span>
                      )}
                    </td>
                    <td className={`px-3 py-3 font-medium ${isMobileRole ? 'text-slate-100' : 'text-gray-900'}`}>
                      {m.name}
                    </td>
                    <td className={`px-3 py-3 ${isMobileRole ? 'text-gray-400' : 'text-gray-600'}`}>
                      {m.location?.trim() ? m.location : '—'}
                    </td>
                    <td className={`px-3 py-3 font-mono text-sm sm:text-base ${isMobileRole ? 'text-gray-400' : ''}`}>
                      {m.work_start.slice(0, 5)} – {m.work_end.slice(0, 5)}
                    </td>
                    <td className={`px-3 py-3 tabular-nums ${isMobileRole ? 'text-gray-200' : ''}`}>
                      {fmtInt(Number(m.capacity_units_per_hour))}
                    </td>
                    <td className={`px-3 py-3 tabular-nums font-medium ${isMobileRole ? 'text-emerald-300/90' : 'text-emerald-800'}`}>
                      {fmtInt(totalProductionCapacityPerShift(m))}
                    </td>
                    <td className="px-3 py-3 text-right space-x-2 whitespace-nowrap">
                      <button
                        type="button"
                        className={`font-semibold ${isMobileRole ? 'text-sky-400' : 'text-blue-600'}`}
                        onClick={() => editMachine(m)}
                      >
                        แก้ไข
                      </button>
                      <button
                        type="button"
                        className={`font-semibold ${isMobileRole ? 'text-red-400' : 'text-red-600'}`}
                        onClick={() => removeMachine(m.id)}
                      >
                        ลบ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'history' && (
        <section className="space-y-4">
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-sm">
              <span className={`block text-xs ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>จากวันที่</span>
              <input
                type="date"
                className={`border rounded-lg px-3 py-2 ${
                  isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                }`}
                value={histFrom}
                onChange={(e) => setHistFrom(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className={`block text-xs ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>ถึงวันที่</span>
              <input
                type="date"
                className={`border rounded-lg px-3 py-2 ${
                  isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                }`}
                value={histTo}
                onChange={(e) => setHistTo(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className={`block text-xs ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>เครื่อง</span>
              <select
                className={`border rounded-lg px-3 py-2 min-w-[10rem] ${
                  isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                }`}
                value={histMachineId}
                onChange={(e) => setHistMachineId(e.target.value)}
              >
                <option value="">ทั้งหมด</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className={`block text-xs ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>สถานะ</span>
              <select
                className={`border rounded-lg px-3 py-2 min-w-[10rem] ${
                  isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                }`}
                value={histStatus}
                onChange={(e) => setHistStatus((e.target.value || '') as '' | PrMachineryStatus)}
              >
                <option value="">ทั้งหมด</option>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {MACHINERY_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {histLoading && (
            <p className={`text-sm ${isMobileRole ? 'text-gray-400' : 'text-gray-500'}`}>กำลังโหลดประวัติ…</p>
          )}

          <h3 className={`font-bold text-base ${isMobileRole ? 'text-gray-200' : 'text-gray-800'}`}>
            สรุปผลการผลิตรายวัน (วันต่อวัน)
          </h3>
          <p className={`text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-600'}`}>
            ตัวเลขต่อวันคำนวณจากกะและสถานะจริงในวันนั้น (เทียบกับการตั้งค่าเครื่อง)
          </p>
          <div
            className={`overflow-x-auto rounded-xl border shadow-sm ${
              isMobileRole ? 'border-slate-600 bg-slate-800/90 shadow-black/30' : 'border-gray-200 bg-white'
            }`}
          >
            <table className="min-w-full text-sm">
              <thead
                className={`text-left ${isMobileRole ? 'bg-slate-800/90 text-gray-300' : 'bg-gray-50 text-gray-600'}`}
              >
                <tr>
                  <th className="px-3 py-2">วันที่</th>
                  <th className="px-3 py-2">เครื่อง</th>
                  <th className="px-3 py-2">ชม.กะ</th>
                  <th className="px-3 py-2">ชม.ทำงาน</th>
                  <th className="px-3 py-2">ชม.หยุด</th>
                  <th className="px-3 py-2">หน่วย</th>
                </tr>
              </thead>
              <tbody>
                {historyRowsComputed.map((r, i) => (
                  <tr key={`${r.machine_id}-${r.date}-${i}`} className={`border-t ${isMobileRole ? 'border-slate-700' : 'border-gray-100'}`}>
                    <td className={`px-3 py-2 font-mono ${isMobileRole ? 'text-gray-200' : ''}`}>{r.date}</td>
                    <td className={`px-3 py-2 ${isMobileRole ? 'text-slate-100' : ''}`}>{r.machine_name}</td>
                    <td className={`px-3 py-2 font-mono tabular-nums text-xs ${isMobileRole ? 'text-gray-300' : ''}`}>
                      {hoursToHms(r.shift_hours)}
                    </td>
                    <td className={`px-3 py-2 font-mono tabular-nums text-xs ${isMobileRole ? 'text-gray-300' : ''}`}>
                      {hoursToHms(r.working_hours)}
                    </td>
                    <td className={`px-3 py-2 font-mono tabular-nums text-xs ${isMobileRole ? 'text-gray-300' : ''}`}>
                      {hoursToHms(r.downtime_hours)}
                    </td>
                    <td className={`px-3 py-2 font-semibold ${isMobileRole ? 'text-emerald-300' : ''}`}>
                      {fmtInt(r.effective_units)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className={`font-bold text-base pt-4 ${isMobileRole ? 'text-gray-200' : 'text-gray-800'}`}>
            รอบเครื่องเสีย → กลับมาทำงาน
          </h3>
          <p className={`text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-600'}`}>
            จับเวลาจากเปลี่ยนเป็น “เครื่องเสีย” จนถึงครั้งถัดไปที่เป็น “ทำงาน” (รวมช่วงซ่อม/รอ)
          </p>
          <div
            className={`overflow-x-auto rounded-xl border shadow-sm ${
              isMobileRole ? 'border-slate-600 bg-slate-800/90 shadow-black/30' : 'border-gray-200 bg-white'
            }`}
          >
            <table className="min-w-full text-sm">
              <thead
                className={`text-left ${isMobileRole ? 'bg-slate-800/90 text-gray-300' : 'bg-gray-50 text-gray-600'}`}
              >
                <tr>
                  <th className="px-3 py-2">เครื่อง</th>
                  <th className="px-3 py-2">เริ่มเครื่องเสีย</th>
                  <th className="px-3 py-2">กลับมาทำงาน</th>
                  <th className="px-3 py-2">ระยะเวลา</th>
                </tr>
              </thead>
              <tbody>
                {repairRoundsFiltered.length === 0 && (
                  <tr>
                    <td colSpan={4} className={`px-3 py-6 text-center text-sm ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>
                      ไม่มีรอบเครื่องเสียในช่วงที่เลือก
                    </td>
                  </tr>
                )}
                {repairRoundsFiltered.map((r, idx) => (
                  <tr key={`repair-${idx}-${r.machine_id}-${r.broken_at}`} className={`border-t ${isMobileRole ? 'border-slate-700' : 'border-gray-100'}`}>
                    <td className={`px-3 py-2 ${isMobileRole ? 'text-slate-100' : ''}`}>{r.machine_name}</td>
                    <td className={`px-3 py-2 font-mono text-xs whitespace-nowrap ${isMobileRole ? 'text-gray-300' : ''}`}>
                      {new Date(r.broken_at).toLocaleString('th-TH')}
                    </td>
                    <td className={`px-3 py-2 font-mono text-xs whitespace-nowrap ${isMobileRole ? 'text-gray-300' : ''}`}>
                      {r.back_to_work_at ? new Date(r.back_to_work_at).toLocaleString('th-TH') : '— (ยังไม่กลับมาทำงาน)'}
                    </td>
                    <td className={`px-3 py-2 font-medium ${isMobileRole ? 'text-amber-200' : 'text-amber-900'}`}>
                      {formatDurationHoursMinutes(r.duration_ms)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className={`font-bold text-base pt-4 ${isMobileRole ? 'text-gray-200' : 'text-gray-800'}`}>
            ช่วงสถานะทุกประเภท (ระยะเวลา)
          </h3>
          <p className={`text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-600'}`}>
            รวมเครื่องเสีย / กำลังซ่อม / พักเครื่อง / หยุดใช้งาน / ทำงาน — แสดงชม. นาที ต่อช่วง
          </p>
          <div
            className={`overflow-x-auto rounded-xl border shadow-sm max-h-[28rem] overflow-y-auto ${
              isMobileRole ? 'border-slate-600 bg-slate-800/90 shadow-black/30' : 'border-gray-200 bg-white'
            }`}
          >
            <table className="min-w-full text-xs">
              <thead
                className={`text-left sticky top-0 z-10 ${
                  isMobileRole ? 'bg-slate-800/95 text-gray-300' : 'bg-gray-50 text-gray-600'
                }`}
              >
                <tr>
                  <th className="px-2 py-2">เครื่อง</th>
                  <th className="px-2 py-2">สถานะ</th>
                  <th className="px-2 py-2">เริ่ม</th>
                  <th className="px-2 py-2">จบ</th>
                  <th className="px-2 py-2">ระยะเวลา</th>
                </tr>
              </thead>
              <tbody>
                {statusSegmentsDisplay.map(({ ev, durationMs }) => {
                  const name = machines.find((x) => x.id === ev.machine_id)?.name || ev.machine_id
                  return (
                    <tr key={ev.id} className={`border-t ${isMobileRole ? 'border-slate-700' : 'border-gray-100'}`}>
                      <td className={`px-2 py-1.5 ${isMobileRole ? 'text-slate-100' : ''}`}>{name}</td>
                      <td className={`px-2 py-1.5 ${isMobileRole ? 'text-gray-200' : ''}`}>
                        {MACHINERY_STATUS_LABELS[ev.status]}
                      </td>
                      <td className={`px-2 py-1.5 font-mono whitespace-nowrap ${isMobileRole ? 'text-gray-300' : ''}`}>
                        {new Date(ev.started_at).toLocaleString('th-TH')}
                      </td>
                      <td className={`px-2 py-1.5 font-mono whitespace-nowrap ${isMobileRole ? 'text-gray-300' : ''}`}>
                        {ev.ended_at ? new Date(ev.ended_at).toLocaleString('th-TH') : '—'}
                      </td>
                      <td className={`px-2 py-1.5 font-medium ${isMobileRole ? 'text-sky-200' : 'text-sky-900'}`}>
                        {formatDurationHoursMinutes(durationMs)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      </div>
    </div>
  )
}

function normalizeTime(t: string): string {
  if (t.includes(':') && t.split(':').length === 2) {
    return `${t}:00`
  }
  return t
}

/** แสดงตัวเลขเป็นจำนวนเต็ม พร้อมคั่นหลักพันด้วยลูกน้ำ */
function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return Math.round(n).toLocaleString('th-TH')
}

const HOURS_TO_MS = 3600000

/** แปลงจำนวนชั่วโมง (ทศนิยม) เป็น HH:MM:SS */
function hoursToHms(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return formatMsAsHms(0)
  return formatMsAsHms(Math.round(hours * HOURS_TO_MS))
}
