import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { FiAlertTriangle, FiAward, FiCheckCircle, FiClock, FiStar, FiTrendingUp, FiUsers } from 'react-icons/fi'
import ModalCloseButton from '../ui/ModalCloseButton'
import { fetchTaskEvaluations, getHRFileUrl } from '../../lib/hrApi'
import { DIMENSIONS, evalScore, isTaskOverdue as isOverdue, TASK_ACTIVE_STATUSES as ACTIVE, type DimensionKey } from '../../lib/hrTaskMetrics'
import type { HREmployee, HRTask, HRTaskEvaluation } from '../../types'

/** ค่าเฉลี่ยรายด้าน — ด้านที่ผลประเมินเก่าไม่มีข้อมูล (เพิ่มทีหลัง) เป็น null */
type DimensionAvg = Record<DimensionKey, number | null>
type Period = '30d' | '90d' | 'ytd' | 'all'
const PERIODS: Array<[Period, string]> = [['30d', '30 วันล่าสุด'], ['90d', '90 วันล่าสุด'], ['ytd', 'ปีนี้'], ['all', 'ทั้งหมด']]
const ACK_SLA_MINUTES = 30

const UNCATEGORIZED = { id: '', name: 'ไม่ระบุประเภท', color: '#9ca3af' }
const nameOf = (e?: HREmployee) => e ? `${e.first_name} ${e.last_name}${e.nickname ? ` (${e.nickname})` : ''}` : '-'
const photoUrlOf = (e?: HREmployee) => !e?.photo_url ? null : e.photo_url.startsWith('http') ? e.photo_url : getHRFileUrl('hr-photos', e.photo_url)
const dimensionAvg = (evals: HRTaskEvaluation[]): DimensionAvg | null => evals.length
  ? Object.fromEntries(DIMENSIONS.map(([key]) => {
    const values = evals.map((ev) => ev[key]).filter((v): v is number => typeof v === 'number')
    return [key, values.length ? values.reduce((a, b) => a + b, 0) / values.length : null]
  })) as DimensionAvg
  : null
const scoreColor = (s: number) => s >= 4.5 ? 'text-emerald-600' : s >= 3.5 ? 'text-blue-600' : s >= 2.5 ? 'text-amber-600' : 'text-red-600'
const scoreBg = (s: number) => s >= 4.5 ? 'bg-emerald-50 border-emerald-200' : s >= 3.5 ? 'bg-blue-50 border-blue-200' : s >= 2.5 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'
const pct = (n: number, total: number) => total ? Math.round((n / total) * 100) : 0
const fmtDuration = (minutes: number) => {
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), mins = Math.round(minutes % 60)
  if (days) return `${days} วัน${hours ? ` ${hours} ชม.` : ''}`
  if (hours) return `${hours} ชม.${mins ? ` ${mins} นาที` : ''}`
  return `${mins} นาที`
}
const firstSubmission = (t: HRTask) => t.first_submitted_at || t.submitted_at || (t.status === 'completed' ? t.completed_at : undefined)
const taskDurationMin = (t: HRTask) => {
  const submitted = firstSubmission(t)
  if (!t.started_at || !submitted) return null
  return Math.max(0, (new Date(submitted).getTime() - new Date(t.started_at).getTime()) / 60000)
}
const acknowledgeDurationMin = (t: HRTask) => t.acknowledged_at
  ? Math.max(0, (new Date(t.acknowledged_at).getTime() - new Date(t.created_at).getTime()) / 60000)
  : null

type CategoryStat = {
  category: { id: string; name: string; color: string }
  count: number
  share: number
  completed: number
  avgScore: number | null
  evalCount: number
}

type EmployeeStat = {
  employee: HREmployee
  total: number
  active: number
  inProgress: number
  review: number
  completed: number
  overdue: number
  onTimeRate: number | null
  ackSlaRate: number | null
  avgAckMin: number | null
  avgDurationMin: number | null
  avgScore: number | null
  evalCount: number
  dims: DimensionAvg | null
  categories: CategoryStat[]
  bestCategory: CategoryStat | null
  tasks: HRTask[]
}

function buildCategoryStats(tasks: HRTask[], evalsByTask: Map<string, HRTaskEvaluation[]>, forEmployee?: string): CategoryStat[] {
  const groups = new Map<string, { category: CategoryStat['category']; tasks: HRTask[] }>()
  for (const t of tasks) {
    const cat = t.category ? { id: t.category.id, name: t.category.name, color: t.category.color } : UNCATEGORIZED
    const g = groups.get(cat.id) ?? { category: cat, tasks: [] }
    g.tasks.push(t)
    groups.set(cat.id, g)
  }
  return [...groups.values()].map(({ category, tasks: rows }) => {
    const scores = rows.flatMap((t) => (evalsByTask.get(t.id) ?? []).filter((ev) => !forEmployee || ev.employee_id === forEmployee).map(evalScore))
    return {
      category,
      count: rows.length,
      share: pct(rows.length, tasks.length),
      completed: rows.filter((t) => t.status === 'completed').length,
      avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      evalCount: scores.length,
    }
  }).sort((a, b) => b.count - a.count)
}

export default function TaskDashboard({ tasks }: { tasks: HRTask[] }) {
  const [evaluations, setEvaluations] = useState<HRTaskEvaluation[]>([])
  const [period, setPeriod] = useState<Period>('90d')
  const [detail, setDetail] = useState<EmployeeStat | null>(null)
  const [error, setError] = useState('')

  useEffect(() => { fetchTaskEvaluations().then(setEvaluations).catch((e) => setError(e instanceof Error ? e.message : 'โหลดผลประเมินไม่สำเร็จ')) }, [])

  const scopedTasks = useMemo(() => {
    const cutoff = period === 'all' ? null : period === 'ytd' ? new Date(new Date().getFullYear(), 0, 1) : new Date(Date.now() - (period === '30d' ? 30 : 90) * 86400000)
    return tasks.filter((t) => !['draft', 'cancelled'].includes(t.status) && (!cutoff || new Date(t.created_at) >= cutoff))
  }, [tasks, period])

  const evalsByTask = useMemo(() => {
    const ids = new Set(scopedTasks.map((t) => t.id))
    const map = new Map<string, HRTaskEvaluation[]>()
    for (const ev of evaluations) { if (ids.has(ev.task_id)) map.set(ev.task_id, [...(map.get(ev.task_id) ?? []), ev]) }
    return map
  }, [evaluations, scopedTasks])

  const stats = useMemo<EmployeeStat[]>(() => {
    const byEmployee = new Map<string, { employee: HREmployee; tasks: HRTask[] }>()
    for (const t of scopedTasks) {
      for (const p of t.participants ?? []) {
        if (p.role !== 'assignee' || !p.employee) continue
        const g = byEmployee.get(p.employee_id) ?? { employee: p.employee, tasks: [] }
        g.tasks.push(t)
        byEmployee.set(p.employee_id, g)
      }
    }
    const rows = [...byEmployee.values()].map(({ employee, tasks: mine }): EmployeeStat => {
      const completedTasks = mine.filter((t) => t.status === 'completed')
      const withDue = mine.filter((t) => t.due_at && firstSubmission(t))
      const onTime = withDue.filter((t) => new Date(firstSubmission(t)!) <= new Date(t.due_at!))
      const durations = mine.map(taskDurationMin).filter((d): d is number => d !== null)
      const ackDurations = mine.map(acknowledgeDurationMin).filter((d): d is number => d !== null)
      const myEvals = mine.flatMap((t) => (evalsByTask.get(t.id) ?? []).filter((ev) => ev.employee_id === employee.id))
      const dims = dimensionAvg(myEvals)
      const categories = buildCategoryStats(mine, evalsByTask, employee.id)
      const rated = categories.filter((c) => c.avgScore !== null)
      const bestCategory = rated.length ? [...rated].sort((a, b) => (b.avgScore! - a.avgScore!) || (b.count - a.count))[0] : null
      return {
        employee,
        total: mine.length,
        active: mine.filter((t) => ACTIVE.includes(t.status)).length,
        inProgress: mine.filter((t) => t.status === 'in_progress').length,
        review: mine.filter((t) => t.status === 'review').length,
        completed: completedTasks.length,
        overdue: mine.filter(isOverdue).length,
        onTimeRate: withDue.length ? pct(onTime.length, withDue.length) : null,
        ackSlaRate: ackDurations.length ? pct(ackDurations.filter((minutes) => minutes <= ACK_SLA_MINUTES).length, ackDurations.length) : null,
        avgAckMin: ackDurations.length ? ackDurations.reduce((a, b) => a + b, 0) / ackDurations.length : null,
        avgDurationMin: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
        avgScore: myEvals.length ? myEvals.reduce((a, ev) => a + evalScore(ev), 0) / myEvals.length : null,
        evalCount: myEvals.length,
        dims,
        categories,
        bestCategory,
        tasks: mine,
      }
    })
    return rows.sort((a, b) => ((b.avgScore ?? -1) - (a.avgScore ?? -1)) || (b.completed - a.completed) || (b.total - a.total))
  }, [scopedTasks, evalsByTask])

  const team = useMemo(() => {
    const allEvals = [...evalsByTask.values()].flat()
    const completed = scopedTasks.filter((t) => t.status === 'completed')
    const withDue = scopedTasks.filter((t) => t.due_at && firstSubmission(t))
    const onTime = withDue.filter((t) => new Date(firstSubmission(t)!) <= new Date(t.due_at!))
    const ackDurations = scopedTasks.map(acknowledgeDurationMin).filter((d): d is number => d !== null)
    const teamDims = dimensionAvg(allEvals)
    return {
      total: scopedTasks.length,
      active: scopedTasks.filter((t) => ACTIVE.includes(t.status)).length,
      completed: completed.length,
      overdue: scopedTasks.filter(isOverdue).length,
      onTimeRate: withDue.length ? pct(onTime.length, withDue.length) : null,
      ackSlaRate: ackDurations.length ? pct(ackDurations.filter((minutes) => minutes <= ACK_SLA_MINUTES).length, ackDurations.length) : null,
      avgAckMin: ackDurations.length ? ackDurations.reduce((a, b) => a + b, 0) / ackDurations.length : null,
      avgScore: allEvals.length ? allEvals.reduce((a, ev) => a + evalScore(ev), 0) / allEvals.length : null,
      evalCount: allEvals.length,
      dims: teamDims,
      categories: buildCategoryStats(scopedTasks, evalsByTask),
    }
  }, [scopedTasks, evalsByTask])

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-gray-700"><FiTrendingUp className="text-emerald-600" /><span className="font-semibold">KPI และ SLA ทีม</span><span className="text-sm text-gray-400">· นับจากวันที่มอบหมายงาน</span></div>
      <select value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="border rounded-xl px-3 py-2 text-sm bg-white">{PERIODS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
    </div>
    {error && <div className="p-3 rounded-xl bg-red-50 text-red-700 text-sm">{error}</div>}

    <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
      <Kpi icon={FiUsers} label="งานที่มอบหมาย" value={String(team.total)} color="text-slate-700" />
      <Kpi icon={FiClock} label="กำลังดำเนินการ" value={String(team.active)} color="text-blue-600" />
      <Kpi icon={FiCheckCircle} label="เสร็จแล้ว" value={String(team.completed)} color="text-emerald-600" />
      <Kpi icon={FiAlertTriangle} label="เลยกำหนด" value={String(team.overdue)} color="text-red-600" />
      <Kpi icon={FiCheckCircle} label={`รับทราบ ≤ ${ACK_SLA_MINUTES} นาที`} value={team.ackSlaRate === null ? '-' : `${team.ackSlaRate}%`} color="text-indigo-600" />
      <Kpi icon={FiClock} label="เวลารับทราบเฉลี่ย" value={team.avgAckMin === null ? '-' : fmtDuration(team.avgAckMin)} color="text-violet-600" />
      <Kpi icon={FiClock} label="ส่งตรงเวลา" value={team.onTimeRate === null ? '-' : `${team.onTimeRate}%`} color="text-teal-600" />
      <Kpi icon={FiStar} label="คะแนนเฉลี่ยทีม" value={team.avgScore === null ? '-' : team.avgScore.toFixed(1)} sub={team.evalCount ? `จากการประเมิน ${team.evalCount} ครั้ง` : 'ยังไม่มีการประเมิน'} color="text-amber-500" />
    </div>

    <div className="grid lg:grid-cols-2 gap-3">
      <div className="bg-white border rounded-2xl p-4">
        <h3 className="font-semibold mb-3">สัดส่วนประเภทงานของทีม</h3>
        {team.categories.length ? <>
          <div className="flex h-3 rounded-full overflow-hidden bg-gray-100 mb-3">{team.categories.map((c) => <div key={c.category.id} title={`${c.category.name} ${c.share}%`} style={{ width: `${c.share}%`, backgroundColor: c.category.color }} />)}</div>
          <div className="space-y-2">{team.categories.map((c) => <div key={c.category.id} className="flex items-center gap-2 text-sm">
            <span className="w-3 h-3 rounded-full shrink-0 border border-black/10" style={{ backgroundColor: c.category.color }} />
            <span className="flex-1 truncate">{c.category.name}</span>
            <span className="text-gray-500">{c.count} งาน</span>
            <span className="w-12 text-right font-semibold">{c.share}%</span>
          </div>)}</div>
        </> : <p className="text-sm text-gray-400 py-6 text-center">ไม่มีงานในช่วงเวลานี้</p>}
      </div>
      <div className="bg-white border rounded-2xl p-4">
        <h3 className="font-semibold mb-3">คะแนนเฉลี่ยรายด้านของทีม</h3>
        {team.dims ? <RadarPanel dims={team.dims} />
          : <p className="text-sm text-gray-400 py-6 text-center">ยังไม่มีผลประเมินในช่วงเวลานี้</p>}
      </div>
    </div>

    <div>
      <h3 className="font-semibold mb-3 flex items-center gap-2"><FiAward className="text-amber-500" /> ผลงานรายบุคคล <span className="text-sm font-normal text-gray-400">({stats.length} คน · เรียงตามคะแนนประเมิน)</span></h3>
      {stats.length ? <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {stats.map((s, i) => <EmployeeCard key={s.employee.id} stat={s} rank={i + 1} onClick={() => setDetail(s)} />)}
      </div> : <div className="bg-white border rounded-2xl py-14 text-center text-gray-400">ยังไม่มีการมอบหมายงานในช่วงเวลานี้</div>}
    </div>

    {detail && <EmployeeDetailModal stat={detail} onClose={() => setDetail(null)} />}
  </div>
}

function Kpi({ icon: Icon, label, value, sub, color }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; color: string }) {
  return <div className="bg-white border rounded-2xl p-4">
    <div className={`flex items-center gap-2 text-sm ${color}`}><Icon />{label}</div>
    <div className="text-2xl font-bold mt-2">{value}</div>
    {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
  </div>
}

export function Avatar({ employee, size = 'w-12 h-12' }: { employee: HREmployee; size?: string }) {
  const url = photoUrlOf(employee)
  const initials = `${employee.first_name?.[0] ?? ''}${employee.last_name?.[0] ?? ''}` || '?'
  return url
    ? <img src={url} alt={nameOf(employee)} className={`${size} rounded-full object-cover border-2 border-white shadow shrink-0`} />
    : <div className={`${size} rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold shrink-0`}>{initials}</div>
}

function RankBadge({ rank }: { rank: number }) {
  const style = rank === 1 ? 'bg-amber-400 text-white' : rank === 2 ? 'bg-gray-300 text-gray-700' : rank === 3 ? 'bg-amber-700/70 text-white' : 'bg-gray-100 text-gray-500'
  return <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${style}`}>{rank}</span>
}

function ScoreBadge({ score, count }: { score: number | null; count: number }) {
  if (score === null) return <span className="text-xs text-gray-400 whitespace-nowrap">ยังไม่มีผลประเมิน</span>
  return <div className={`px-2.5 py-1 rounded-xl border text-center ${scoreBg(score)}`}>
    <div className={`flex items-center gap-1 font-bold ${scoreColor(score)}`}><FiStar className="fill-current" />{score.toFixed(1)}<span className="text-xs font-normal opacity-70">/5</span></div>
    <div className="text-[10px] text-gray-500">{count} ครั้ง</div>
  </div>
}

/** Radar Chart หกเหลี่ยม — ด้านที่ยังไม่มีข้อมูล (null) วาดที่ 0 และแสดงค่าเป็น "-" */
function RadarChart({ dims, size = 300 }: { dims: DimensionAvg; size?: number }) {
  const cx = size / 2, cy = size / 2, r = size / 2 - 58
  const n = DIMENSIONS.length
  const point = (i: number, value: number, radius = r) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n
    return [cx + Math.cos(a) * radius * (value / 5), cy + Math.sin(a) * radius * (value / 5)] as const
  }
  const ring = (level: number) => DIMENSIONS.map((_, i) => point(i, level).join(',')).join(' ')
  const data = DIMENSIONS.map(([key], i) => point(i, dims[key] ?? 0))
  return <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[320px] mx-auto" role="img" aria-label="กราฟเรดาร์คะแนนประเมินรายด้าน">
    {[1, 2, 3, 4, 5].map((level) => <polygon key={level} points={ring(level)} fill={level === 5 ? '#f9fafb' : 'none'} stroke="#e5e7eb" strokeWidth={1} />)}
    {DIMENSIONS.map((_, i) => { const [x, y] = point(i, 5); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#e5e7eb" strokeWidth={1} /> })}
    <polygon points={data.map((p) => p.join(',')).join(' ')} fill="rgba(5,150,105,0.18)" stroke="#059669" strokeWidth={2} strokeLinejoin="round" />
    {data.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={3.5} fill="#059669" stroke="white" strokeWidth={1.5} />)}
    {DIMENSIONS.map(([key, label], i) => {
      const [x, y] = point(i, 5, r + 30)
      const value = dims[key]
      return <text key={key} x={x} y={y} textAnchor="middle" className="fill-gray-600" fontSize={11}>
        <tspan x={x} dy={-3}>{label}</tspan>
        <tspan x={x} dy={13} fontWeight={700} fill={value !== null ? '#059669' : '#d1d5db'}>{value !== null ? value.toFixed(1) : '-'}</tspan>
      </text>
    })}
  </svg>
}

function RadarPanel({ dims }: { dims: DimensionAvg }) {
  return <div>
    <RadarChart dims={dims} />
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 mt-2">
      {DIMENSIONS.map(([key, label]) => <div key={key} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-gray-50 text-xs">
        <span className="text-gray-600 truncate">{label}</span>
        <span className={`font-bold ${dims[key] !== null ? scoreColor(dims[key]!) : 'text-gray-300'}`}>{dims[key] !== null ? `${dims[key]!.toFixed(1)}` : '-'}</span>
      </div>)}
    </div>
  </div>
}

function EmployeeCard({ stat, rank, onClick }: { stat: EmployeeStat; rank: number; onClick: () => void }) {
  const e = stat.employee
  return <button onClick={onClick} className="text-left bg-white border rounded-2xl p-4 hover:border-emerald-300 hover:shadow-md transition-all">
    <div className="flex items-start gap-3">
      <RankBadge rank={rank} />
      <Avatar employee={e} />
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">{nameOf(e)}</div>
        <div className="text-xs text-gray-500 truncate">{e.position?.name ?? e.employee_code}</div>
      </div>
      <ScoreBadge score={stat.avgScore} count={stat.evalCount} />
    </div>
    <div className="grid grid-cols-4 gap-2 mt-4 text-center">
      {([['มอบหมาย', stat.total, 'text-slate-700'], ['กำลังทำ', stat.active, 'text-blue-600'], ['เสร็จ', stat.completed, 'text-emerald-600'], ['เลยกำหนด', stat.overdue, stat.overdue ? 'text-red-600' : 'text-gray-400']] as const).map(([label, value, color]) =>
        <div key={label} className="bg-gray-50 rounded-xl py-2"><div className={`text-lg font-bold ${color}`}>{value}</div><div className="text-[10px] text-gray-500">{label}</div></div>)}
    </div>
    <div className="mt-3">
      <div className="flex flex-wrap justify-between gap-1 text-xs text-gray-500 mb-1"><span>ประเภทงานที่ได้รับ</span><span className="flex gap-2">{stat.ackSlaRate !== null && <span>รับทราบตาม SLA <b className="text-gray-700">{stat.ackSlaRate}%</b></span>}{stat.onTimeRate !== null && <span>ส่งตรงเวลา <b className="text-gray-700">{stat.onTimeRate}%</b></span>}</span></div>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-gray-100">{stat.categories.map((c) => <div key={c.category.id} title={`${c.category.name} ${c.share}%`} style={{ width: `${c.share}%`, backgroundColor: c.category.color }} />)}</div>
      <div className="flex flex-wrap gap-1.5 mt-2">{stat.categories.slice(0, 3).map((c) => <span key={c.category.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-50 text-[11px] text-gray-600"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.category.color }} />{c.category.name} {c.share}%</span>)}{stat.categories.length > 3 && <span className="text-[11px] text-gray-400">+{stat.categories.length - 3}</span>}</div>
    </div>
    {stat.bestCategory && <div className="mt-3 flex items-center gap-1.5 text-xs bg-emerald-50 text-emerald-700 rounded-xl px-2.5 py-1.5"><FiAward /><span>ทำได้ดีที่สุด: <b>{stat.bestCategory.category.name}</b> ({stat.bestCategory.avgScore!.toFixed(1)}★ จาก {stat.bestCategory.evalCount} งาน)</span></div>}
  </button>
}

function EmployeeDetailModal({ stat, onClose }: { stat: EmployeeStat; onClose: () => void }) {
  const e = stat.employee
  return createPortal(
    <div className="fixed inset-0 z-[1000] bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="รายละเอียดผลงานพนักงาน">
      <div className="relative bg-white rounded-2xl w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-hidden flex flex-col shadow-2xl">
        <ModalCloseButton onClick={onClose} className="absolute right-3 top-3 z-20" />
        <div className="flex items-center px-5 py-4 pr-16 border-b">
          <div className="flex items-center gap-3"><Avatar employee={e} /><div><h2 className="font-bold text-lg">{nameOf(e)}</h2><p className="text-xs text-gray-500">{e.position?.name ?? ''} {e.employee_code ? `· ${e.employee_code}` : ''}</p></div></div>
        </div>
        <div className="overflow-y-auto p-5 space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Info label="งานที่มอบหมาย" value={String(stat.total)} />
            <Info label="เสร็จแล้ว" value={`${stat.completed} งาน`} />
            <Info label={`รับทราบภายใน ${ACK_SLA_MINUTES} นาที`} value={stat.ackSlaRate === null ? '-' : `${stat.ackSlaRate}%`} />
            <Info label="เวลารับทราบเฉลี่ย" value={stat.avgAckMin === null ? '-' : fmtDuration(stat.avgAckMin)} />
            <Info label="ส่งตรงเวลา" value={stat.onTimeRate === null ? '-' : `${stat.onTimeRate}%`} />
            <Info label="เวลาเฉลี่ย/งาน" value={stat.avgDurationMin === null ? '-' : fmtDuration(stat.avgDurationMin)} />
          </div>
          <section>
            <h4 className="font-semibold mb-2">คะแนนประเมินรายด้าน {stat.evalCount ? <span className="text-sm font-normal text-gray-400">(เฉลี่ยจาก {stat.evalCount} ครั้ง)</span> : ''}</h4>
            {stat.dims ? <RadarPanel dims={stat.dims} />
              : <p className="text-sm text-gray-400">ยังไม่มีผลประเมินในช่วงเวลานี้</p>}
          </section>
          <section>
            <h4 className="font-semibold mb-2">แยกตามประเภทงาน</h4>
            <div className="overflow-x-auto border rounded-xl">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600"><tr><th className="text-left p-2.5">ประเภท</th><th className="text-right p-2.5">รับมอบหมาย</th><th className="text-right p-2.5">สัดส่วน</th><th className="text-right p-2.5">เสร็จ</th><th className="text-right p-2.5">คะแนนเฉลี่ย</th></tr></thead>
                <tbody>{stat.categories.map((c) => <tr key={c.category.id} className={`border-t ${stat.bestCategory?.category.id === c.category.id ? 'bg-emerald-50/60' : ''}`}>
                  <td className="p-2.5"><span className="inline-flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full border border-black/10" style={{ backgroundColor: c.category.color }} />{c.category.name}{stat.bestCategory?.category.id === c.category.id && <FiAward className="text-emerald-600" title="ทำได้ดีที่สุด" />}</span></td>
                  <td className="p-2.5 text-right">{c.count}</td>
                  <td className="p-2.5 text-right">{c.share}%</td>
                  <td className="p-2.5 text-right">{c.completed}</td>
                  <td className={`p-2.5 text-right font-semibold ${c.avgScore !== null ? scoreColor(c.avgScore) : 'text-gray-300'}`}>{c.avgScore !== null ? c.avgScore.toFixed(1) : '-'}</td>
                </tr>)}</tbody>
              </table>
            </div>
            {stat.bestCategory && <p className="mt-2 text-sm text-emerald-700 flex items-center gap-1.5"><FiAward /> เหมาะกับงานประเภท <b>{stat.bestCategory.category.name}</b> — คะแนนเฉลี่ย {stat.bestCategory.avgScore!.toFixed(1)}/5 พิจารณามอบหมายงานประเภทนี้เพิ่มได้</p>}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="p-3 border rounded-xl"><div className="text-xs text-gray-500">{label}</div><div className="font-semibold mt-1">{value}</div></div>
}
