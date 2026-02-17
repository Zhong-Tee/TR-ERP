import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import * as XLSX from 'xlsx'
import { FiDownload, FiSearch } from 'react-icons/fi'

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */
interface SalesOrder {
  channel_code: string
  total_amount: number
  entry_date: string
  admin_user: string
  status: string
  or_order_items: { quantity: number; unit_price: number; is_free: boolean }[]
}
interface WmsSummary {
  order_id: string
  picker_id: string
  total_items: number
  correct_at_first_check: number
  wrong_at_first_check: number
  not_find_at_first_check: number
  accuracy_percent: number
  checked_at: string
  us_users: { username: string } | null
}
interface WmsOrder {
  order_id: string
  created_at: string
  end_time: string | null
}
interface QcSession {
  username: string
  start_time: string
  end_time: string
  total_items: number
  pass_count: number
  fail_count: number
  kpi_score: number
}
interface PackLog {
  packed_by: string
  packed_at: string
  order_id: string
}
interface PlanJob {
  name: string
  tracks: Record<string, Record<string, { start: string | null; end: string | null }>> | null
  date: string
}
interface IssueRow {
  status: string
  duration_minutes: number | null
  created_by: string | null
  created_at: string
  closed_at: string | null
  or_issue_types: { name: string } | null
}
interface AuditRow {
  accuracy_percent: number | null
  location_accuracy_percent: number | null
  safety_stock_accuracy_percent: number | null
  total_items: number | null
  status: string
  completed_at: string | null
  created_at: string
}

type TabKey = 'overview' | 'sales' | 'warehouse' | 'qc' | 'packing' | 'production' | 'issues' | 'audit'
type PresetKey = 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'thisYear'

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */
const fmt = (n: number) => n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtInt = (n: number) => n.toLocaleString('th-TH')
const fmtPct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%'

function toLocalDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getPresetDates(key: PresetKey): [string, string] {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const today = toLocalDate(now)
  switch (key) {
    case 'today': return [today, today]
    case 'yesterday': { const d = new Date(now); d.setDate(d.getDate() - 1); return [toLocalDate(d), toLocalDate(d)] }
    case 'thisWeek': { const diff = now.getDay() === 0 ? 6 : now.getDay() - 1; const mon = new Date(now); mon.setDate(mon.getDate() - diff); return [toLocalDate(mon), today] }
    case 'thisMonth': return [`${y}-${String(m + 1).padStart(2, '0')}-01`, today]
    case 'lastMonth': { const pm = m === 0 ? 11 : m - 1; const py = m === 0 ? y - 1 : y; const ld = new Date(py, pm + 1, 0).getDate(); return [`${py}-${String(pm + 1).padStart(2, '0')}-01`, `${py}-${String(pm + 1).padStart(2, '0')}-${String(ld).padStart(2, '0')}`] }
    case 'thisQuarter': { const qs = Math.floor(m / 3) * 3; return [`${y}-${String(qs + 1).padStart(2, '0')}-01`, today] }
    case 'thisYear': return [`${y}-01-01`, today]
  }
}

function getPrevPeriod(from: string, to: string): [string, string] {
  const f = new Date(from + 'T00:00:00')
  const t = new Date(to + 'T00:00:00')
  const diff = t.getTime() - f.getTime()
  const prevTo = new Date(f.getTime() - 86400000)
  const prevFrom = new Date(prevTo.getTime() - diff)
  return [toLocalDate(prevFrom), toLocalDate(prevTo)]
}

function fmtDuration(ms: number): string {
  if (ms <= 0 || Number.isNaN(ms)) return '00:00:00'
  let s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600); s %= 3600
  const mi = Math.floor(s / 60); s %= 60
  return `${h.toString().padStart(2, '0')}:${mi.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function fmtMinutes(mins: number): string {
  if (mins <= 0 || Number.isNaN(mins)) return '-'
  if (mins < 60) return `${Math.round(mins)} นาที`
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return m > 0 ? `${h} ชม. ${m} นาที` : `${h} ชม.`
}

function delta(curr: number, prev: number) {
  if (prev === 0) return curr > 0 ? 100 : 0
  return ((curr - prev) / prev) * 100
}

/* ================================================================== */
/*  Component                                                          */
/* ================================================================== */
export default function KPIDashboard() {
  const today = toLocalDate(new Date())
  const monthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`

  const [dateFrom, setDateFrom] = useState(monthStart)
  const [dateTo, setDateTo] = useState(today)
  const [activePreset, setActivePreset] = useState<PresetKey | null>('thisMonth')
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [tab, setTab] = useState<TabKey>('overview')

  // Data states
  const [salesData, setSalesData] = useState<SalesOrder[]>([])
  const [prevSalesData, setPrevSalesData] = useState<SalesOrder[]>([])
  const [wmsData, setWmsData] = useState<WmsSummary[]>([])
  const [prevWmsData, setPrevWmsData] = useState<WmsSummary[]>([])
  const [wmsOrders, setWmsOrders] = useState<WmsOrder[]>([])
  const [prevWmsOrders, setPrevWmsOrders] = useState<WmsOrder[]>([])
  const [qcData, setQcData] = useState<QcSession[]>([])
  const [prevQcData, setPrevQcData] = useState<QcSession[]>([])
  const [packData, setPackData] = useState<PackLog[]>([])
  const [prevPackData, setPrevPackData] = useState<PackLog[]>([])
  const [prodData, setProdData] = useState<PlanJob[]>([])
  const [issueData, setIssueData] = useState<IssueRow[]>([])
  const [prevIssueData, setPrevIssueData] = useState<IssueRow[]>([])
  const [auditData, setAuditData] = useState<AuditRow[]>([])
  const [prevAuditData, setPrevAuditData] = useState<AuditRow[]>([])

  /* ---------- Fetch helpers ---------- */
  const fetchRange = useCallback(async (from: string, to: string) => {
    const tsFrom = from + 'T00:00:00'
    const tsTo = to + 'T23:59:59'

    const [sales, wms, wmsOrd, qc, pack, prod, issues, audits] = await Promise.all([
      supabase.from('or_orders')
        .select('channel_code, total_amount, entry_date, admin_user, status, or_order_items(quantity, unit_price, is_free)')
        .gte('entry_date', from).lte('entry_date', to).in('status', ['จัดส่งแล้ว', 'เสร็จสิ้น']),
      supabase.from('wms_order_summaries')
        .select('order_id, picker_id, total_items, correct_at_first_check, wrong_at_first_check, not_find_at_first_check, accuracy_percent, checked_at, us_users!picker_id(username)')
        .gte('checked_at', tsFrom).lte('checked_at', tsTo),
      supabase.from('wms_orders')
        .select('order_id, created_at, end_time')
        .gte('created_at', tsFrom).lte('created_at', tsTo),
      supabase.from('qc_sessions')
        .select('username, start_time, end_time, total_items, pass_count, fail_count, kpi_score')
        .not('end_time', 'is', null)
        .gte('start_time', tsFrom).lte('start_time', tsTo),
      supabase.from('pk_packing_logs')
        .select('packed_by, packed_at, order_id')
        .gte('packed_at', tsFrom).lte('packed_at', tsTo),
      supabase.from('plan_jobs')
        .select('name, tracks, date')
        .gte('date', from).lte('date', to),
      supabase.from('or_issues')
        .select('status, duration_minutes, created_by, created_at, closed_at, or_issue_types(name)')
        .gte('created_at', tsFrom).lte('created_at', tsTo),
      supabase.from('inv_audits')
        .select('accuracy_percent, location_accuracy_percent, safety_stock_accuracy_percent, total_items, status, completed_at, created_at')
        .gte('created_at', tsFrom).lte('created_at', tsTo),
    ])

    return {
      sales: (sales.data || []) as SalesOrder[],
      wms: (wms.data || []) as WmsSummary[],
      wmsOrd: (wmsOrd.data || []) as WmsOrder[],
      qc: (qc.data || []) as QcSession[],
      pack: (pack.data || []) as PackLog[],
      prod: (prod.data || []) as PlanJob[],
      issues: (issues.data || []) as IssueRow[],
      audits: (audits.data || []) as AuditRow[],
    }
  }, [])

  async function handleSearch() {
    setLoading(true)
    try {
      const [pf, pt] = getPrevPeriod(dateFrom, dateTo)
      const [curr, prev] = await Promise.all([fetchRange(dateFrom, dateTo), fetchRange(pf, pt)])
      setSalesData(curr.sales); setPrevSalesData(prev.sales)
      setWmsData(curr.wms); setPrevWmsData(prev.wms)
      setWmsOrders(curr.wmsOrd); setPrevWmsOrders(prev.wmsOrd)
      setQcData(curr.qc); setPrevQcData(prev.qc)
      setPackData(curr.pack); setPrevPackData(prev.pack)
      setProdData(curr.prod)
      setIssueData(curr.issues); setPrevIssueData(prev.issues)
      setAuditData(curr.audits); setPrevAuditData(prev.audits)
      setLoaded(true)
    } catch (err: any) {
      console.error(err)
      alert('โหลดข้อมูลไม่สำเร็จ: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { handleSearch() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function applyPreset(key: PresetKey) {
    const [f, t] = getPresetDates(key)
    setDateFrom(f); setDateTo(t); setActivePreset(key)
  }

  /* ================================================================ */
  /*  Aggregations (all useMemo — no refetch on tab switch)           */
  /* ================================================================ */

  // --- Sales ---
  const salesKpi = useMemo(() => {
    let rev = 0, items = 0
    salesData.forEach((o) => { rev += Number(o.total_amount) || 0; o.or_order_items?.forEach((i) => { items += Number(i.quantity) || 0 }) })
    return { revenue: rev, orders: salesData.length, avgOrder: salesData.length ? rev / salesData.length : 0, items }
  }, [salesData])

  const prevSalesKpi = useMemo(() => {
    let rev = 0
    prevSalesData.forEach((o) => { rev += Number(o.total_amount) || 0 })
    return { revenue: rev, orders: prevSalesData.length }
  }, [prevSalesData])

  const salesByChannel = useMemo(() => {
    const m: Record<string, { ch: string; orders: number; rev: number }> = {}
    salesData.forEach((o) => {
      const ch = o.channel_code || 'N/A'
      if (!m[ch]) m[ch] = { ch, orders: 0, rev: 0 }
      m[ch].orders++; m[ch].rev += Number(o.total_amount) || 0
    })
    return Object.values(m).sort((a, b) => b.rev - a.rev)
  }, [salesData])

  const salesByAdmin = useMemo(() => {
    const m: Record<string, { admin: string; orders: number; rev: number }> = {}
    salesData.forEach((o) => {
      const a = o.admin_user || 'N/A'
      if (!m[a]) m[a] = { admin: a, orders: 0, rev: 0 }
      m[a].orders++; m[a].rev += Number(o.total_amount) || 0
    })
    return Object.values(m).sort((a, b) => b.rev - a.rev)
  }, [salesData])

  // --- WMS ---
  const wmsTimeMap = useMemo(() => {
    const tm: Record<string, { start: number; end: number }> = {}
    wmsOrders.forEach((o) => {
      const s = new Date(o.created_at).getTime()
      const e = o.end_time ? new Date(o.end_time).getTime() : 0
      if (!tm[o.order_id]) { tm[o.order_id] = { start: s, end: e } }
      else { if (s < tm[o.order_id].start) tm[o.order_id].start = s; if (e > tm[o.order_id].end) tm[o.order_id].end = e }
    })
    return tm
  }, [wmsOrders])

  const prevWmsTimeMap = useMemo(() => {
    const tm: Record<string, { start: number; end: number }> = {}
    prevWmsOrders.forEach((o) => {
      const s = new Date(o.created_at).getTime()
      const e = o.end_time ? new Date(o.end_time).getTime() : 0
      if (!tm[o.order_id]) { tm[o.order_id] = { start: s, end: e } }
      else { if (s < tm[o.order_id].start) tm[o.order_id].start = s; if (e > tm[o.order_id].end) tm[o.order_id].end = e }
    })
    return tm
  }, [prevWmsOrders])

  function calcWmsKpi(data: WmsSummary[], timeMap: Record<string, { start: number; end: number }>) {
    let sumAcc = 0, totalMs = 0, countTime = 0
    data.forEach((s) => {
      sumAcc += Number(s.accuracy_percent) || 0
      const t = timeMap[s.order_id]
      if (t && t.start && t.end && t.end > t.start) { totalMs += t.end - t.start; countTime++ }
    })
    return {
      totalOrders: data.length,
      avgAccuracy: data.length ? sumAcc / data.length : 0,
      avgPickMs: countTime ? totalMs / countTime : 0,
    }
  }

  const wmsKpi = useMemo(() => calcWmsKpi(wmsData, wmsTimeMap), [wmsData, wmsTimeMap])
  const prevWmsKpi = useMemo(() => calcWmsKpi(prevWmsData, prevWmsTimeMap), [prevWmsData, prevWmsTimeMap])

  const wmsByPicker = useMemo(() => {
    const m: Record<string, { name: string; orders: number; sumAcc: number; correct: number; wrong: number; notFind: number; totalMs: number; countTime: number }> = {}
    wmsData.forEach((s) => {
      const name = (s.us_users as any)?.username || s.picker_id
      if (!m[name]) m[name] = { name, orders: 0, sumAcc: 0, correct: 0, wrong: 0, notFind: 0, totalMs: 0, countTime: 0 }
      m[name].orders++
      m[name].sumAcc += Number(s.accuracy_percent) || 0
      m[name].correct += s.correct_at_first_check
      m[name].wrong += s.wrong_at_first_check
      m[name].notFind += s.not_find_at_first_check
      const t = wmsTimeMap[s.order_id]
      if (t && t.start && t.end && t.end > t.start) { m[name].totalMs += t.end - t.start; m[name].countTime++ }
    })
    return Object.values(m).sort((a, b) => (b.orders ? b.sumAcc / b.orders : 0) - (a.orders ? a.sumAcc / a.orders : 0))
  }, [wmsData, wmsTimeMap])

  // --- QC ---
  function calcQcKpi(data: QcSession[]) {
    let totalScore = 0, totalItems = 0, totalPass = 0, totalFail = 0, countScore = 0
    data.forEach((s) => {
      totalItems += s.total_items || 0
      totalPass += s.pass_count || 0
      totalFail += s.fail_count || 0
      if (s.kpi_score > 0) { totalScore += s.kpi_score; countScore++ }
    })
    return {
      sessions: data.length,
      avgScore: countScore ? totalScore / countScore : 0,
      passRate: (totalPass + totalFail) > 0 ? (totalPass / (totalPass + totalFail)) * 100 : 0,
      totalItems, totalPass, totalFail,
    }
  }

  const qcKpi = useMemo(() => calcQcKpi(qcData), [qcData])
  const prevQcKpi = useMemo(() => calcQcKpi(prevQcData), [prevQcData])

  const qcByStaff = useMemo(() => {
    const m: Record<string, { name: string; sessions: number; items: number; pass: number; fail: number; totalScore: number; countScore: number }> = {}
    qcData.forEach((s) => {
      const n = s.username || 'N/A'
      if (!m[n]) m[n] = { name: n, sessions: 0, items: 0, pass: 0, fail: 0, totalScore: 0, countScore: 0 }
      m[n].sessions++
      m[n].items += s.total_items || 0
      m[n].pass += s.pass_count || 0
      m[n].fail += s.fail_count || 0
      if (s.kpi_score > 0) { m[n].totalScore += s.kpi_score; m[n].countScore++ }
    })
    return Object.values(m).sort((a, b) => b.items - a.items)
  }, [qcData])

  // --- Packing ---
  function calcPackKpi(data: PackLog[]) {
    const orderSet = new Set(data.map((p) => p.order_id))
    return { totalLogs: data.length, uniqueOrders: orderSet.size }
  }

  const packKpi = useMemo(() => calcPackKpi(packData), [packData])
  const prevPackKpi = useMemo(() => calcPackKpi(prevPackData), [prevPackData])

  const packByPacker = useMemo(() => {
    const m: Record<string, { name: string; logs: number; orders: Set<string> }> = {}
    packData.forEach((p) => {
      const n = p.packed_by || 'N/A'
      if (!m[n]) m[n] = { name: n, logs: 0, orders: new Set() }
      m[n].logs++
      m[n].orders.add(p.order_id)
    })
    return Object.values(m).map((v) => ({ name: v.name, logs: v.logs, orders: v.orders.size })).sort((a, b) => b.logs - a.logs)
  }, [packData])

  // --- Production ---
  const prodByDept = useMemo(() => {
    const m: Record<string, { dept: string; jobs: number; totalMs: number; countTime: number }> = {}
    prodData.forEach((j) => {
      if (!j.tracks) return
      Object.entries(j.tracks).forEach(([dept, processes]) => {
        if (!m[dept]) m[dept] = { dept, jobs: 0, totalMs: 0, countTime: 0 }
        let hasData = false
        Object.values(processes).forEach((p) => {
          if (p.start && p.end) {
            const diff = new Date(p.end).getTime() - new Date(p.start).getTime()
            if (diff > 0) { m[dept].totalMs += diff; m[dept].countTime++; hasData = true }
          }
        })
        if (hasData) m[dept].jobs++
      })
    })
    return Object.values(m).sort((a, b) => b.jobs - a.jobs)
  }, [prodData])

  // --- Issues ---
  function calcIssueKpi(data: IssueRow[]) {
    const closed = data.filter((i) => i.status === 'Close')
    let totalMin = 0, countMin = 0
    closed.forEach((i) => { if (i.duration_minutes && i.duration_minutes > 0) { totalMin += i.duration_minutes; countMin++ } })
    return {
      total: data.length,
      open: data.filter((i) => i.status === 'On').length,
      closed: closed.length,
      avgResMin: countMin ? totalMin / countMin : 0,
    }
  }

  const issueKpi = useMemo(() => calcIssueKpi(issueData), [issueData])
  const prevIssueKpi = useMemo(() => calcIssueKpi(prevIssueData), [prevIssueData])

  const issueByType = useMemo(() => {
    const m: Record<string, { type: string; total: number; open: number; closed: number; totalMin: number; countMin: number }> = {}
    issueData.forEach((i) => {
      const t = (i.or_issue_types as any)?.name || 'ไม่ระบุ'
      if (!m[t]) m[t] = { type: t, total: 0, open: 0, closed: 0, totalMin: 0, countMin: 0 }
      m[t].total++
      if (i.status === 'On') m[t].open++
      else m[t].closed++
      if (i.duration_minutes && i.duration_minutes > 0) { m[t].totalMin += i.duration_minutes; m[t].countMin++ }
    })
    return Object.values(m).sort((a, b) => b.total - a.total)
  }, [issueData])

  // --- Audit ---
  function calcAuditKpi(data: AuditRow[]) {
    const completed = data.filter((a) => ['completed', 'closed', 'review'].includes(a.status))
    let sumQty = 0, cQty = 0, sumLoc = 0, cLoc = 0, sumSS = 0, cSS = 0, totalItems = 0
    completed.forEach((a) => {
      if (a.accuracy_percent != null) { sumQty += Number(a.accuracy_percent); cQty++ }
      if (a.location_accuracy_percent != null) { sumLoc += Number(a.location_accuracy_percent); cLoc++ }
      if (a.safety_stock_accuracy_percent != null) { sumSS += Number(a.safety_stock_accuracy_percent); cSS++ }
      totalItems += Number(a.total_items) || 0
    })
    return {
      totalAudits: data.length,
      completed: completed.length,
      avgQtyAcc: cQty ? sumQty / cQty : 0,
      avgLocAcc: cLoc ? sumLoc / cLoc : 0,
      avgSSAcc: cSS ? sumSS / cSS : 0,
      totalItems,
    }
  }

  const auditKpi = useMemo(() => calcAuditKpi(auditData), [auditData])
  const prevAuditKpi = useMemo(() => calcAuditKpi(prevAuditData), [prevAuditData])

  /* ================================================================ */
  /*  Excel Export                                                     */
  /* ================================================================ */
  function exportExcel() {
    const wb = XLSX.utils.book_new()

    // Sheet 1: Overview
    const ov = [
      ['KPI Dashboard', '', ''],
      ['ช่วงวันที่', `${dateFrom} ถึง ${dateTo}`, ''],
      [],
      ['ตัวชี้วัด', 'ค่า', 'หน่วย'],
      ['ยอดขายรวม', salesKpi.revenue, 'บาท'],
      ['จำนวนบิล', salesKpi.orders, 'บิล'],
      ['ความแม่นยำจัดสินค้า', wmsKpi.avgAccuracy.toFixed(2), '%'],
      ['เวลาจัดสินค้าเฉลี่ย', fmtDuration(wmsKpi.avgPickMs), 'HH:MM:SS'],
      ['QC คะแนนเฉลี่ย', (qcKpi.avgScore / 60).toFixed(2), 'นาที/ชิ้น'],
      ['QC อัตรา Pass', qcKpi.passRate.toFixed(2), '%'],
      ['แก้ปัญหาเฉลี่ย', fmtMinutes(issueKpi.avgResMin), ''],
      ['ตรวจนับแม่นยำ', auditKpi.avgQtyAcc.toFixed(2), '%'],
    ]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ov), 'ภาพรวม')

    // Sheet 2: Sales
    const sr = [['ช่องทาง', 'จำนวนบิล', 'ยอดขาย', 'เฉลี่ย/บิล']]
    salesByChannel.forEach((r) => sr.push([r.ch, r.orders as any, r.rev as any, r.orders ? (r.rev / r.orders) as any : 0]))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sr), 'ยอดขาย')

    // Sheet 3: Warehouse
    const wr = [['พนักงาน', 'จำนวนงาน', 'ความแม่นยำ(%)', 'เวลาเฉลี่ย', 'หยิบถูก', 'หยิบผิด', 'ไม่พบ']]
    wmsByPicker.forEach((r) => wr.push([r.name, r.orders as any, r.orders ? ((r.sumAcc / r.orders).toFixed(2)) as any : 0, r.countTime ? fmtDuration(r.totalMs / r.countTime) : '-', r.correct as any, r.wrong as any, r.notFind as any]))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(wr), 'คลังจัดสินค้า')

    // Sheet 4: QC
    const qr = [['พนักงาน', 'เซสชัน', 'รายการ', 'Pass', 'Fail', 'อัตรา Pass(%)', 'คะแนนเฉลี่ย(นาที/ชิ้น)']]
    qcByStaff.forEach((r) => {
      const pr = (r.pass + r.fail) > 0 ? ((r.pass / (r.pass + r.fail)) * 100).toFixed(2) : '0'
      const sc = r.countScore ? (r.totalScore / r.countScore / 60).toFixed(2) : '-'
      qr.push([r.name, r.sessions as any, r.items as any, r.pass as any, r.fail as any, pr as any, sc as any])
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(qr), 'QC')

    // Sheet 5: Packing
    const pk = [['พนักงาน', 'จำนวนสแกน', 'จำนวนออเดอร์']]
    packByPacker.forEach((r) => pk.push([r.name, r.logs as any, r.orders as any]))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pk), 'แพ็คสินค้า')

    // Sheet 6: Production
    const pd = [['แผนก', 'จำนวนงาน', 'เวลาเฉลี่ย']]
    prodByDept.forEach((r) => pd.push([r.dept, r.jobs as any, r.countTime ? fmtDuration(r.totalMs / r.countTime) : '-']))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pd), 'การผลิต')

    // Sheet 7: Issues
    const is = [['ประเภท', 'ทั้งหมด', 'เปิดอยู่', 'ปิดแล้ว', 'เวลาแก้เฉลี่ย']]
    issueByType.forEach((r) => is.push([r.type, r.total as any, r.open as any, r.closed as any, r.countMin ? fmtMinutes(r.totalMin / r.countMin) : '-']))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(is), 'ปัญหา')

    // Sheet 8: Audit
    const au = [['ตัวชี้วัด', 'ค่า'],
      ['จำนวนครั้งตรวจนับ', auditKpi.totalAudits],
      ['สำเร็จ', auditKpi.completed],
      ['ความแม่นยำจำนวน(%)', auditKpi.avgQtyAcc.toFixed(2)],
      ['ความแม่นยำตำแหน่ง(%)', auditKpi.avgLocAcc.toFixed(2)],
      ['ความแม่นยำ Safety Stock(%)', auditKpi.avgSSAcc.toFixed(2)],
      ['รายการตรวจรวม', auditKpi.totalItems],
    ]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(au), 'ตรวจนับสต็อก')

    XLSX.writeFile(wb, `KPI_${dateFrom}_${dateTo}.xlsx`)
  }

  /* ================================================================ */
  /*  Preset & Tab configs                                             */
  /* ================================================================ */
  const presets: { key: PresetKey; label: string }[] = [
    { key: 'today', label: 'วันนี้' }, { key: 'yesterday', label: 'เมื่อวาน' },
    { key: 'thisWeek', label: 'สัปดาห์นี้' }, { key: 'thisMonth', label: 'เดือนนี้' },
    { key: 'lastMonth', label: 'เดือนก่อน' }, { key: 'thisQuarter', label: 'ไตรมาสนี้' },
    { key: 'thisYear', label: 'ปีนี้' },
  ]

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'overview', label: 'ภาพรวม' }, { key: 'sales', label: 'ยอดขาย' },
    { key: 'warehouse', label: 'คลังจัดสินค้า' }, { key: 'qc', label: 'QC' },
    { key: 'packing', label: 'แพ็คสินค้า' }, { key: 'production', label: 'การผลิต' },
    { key: 'issues', label: 'ปัญหา' }, { key: 'audit', label: 'ตรวจนับสต็อก' },
  ]

  /* ================================================================ */
  /*  Sub-components                                                   */
  /* ================================================================ */
  function KpiCard({ label, value, unit, prev, colorClass, prefix }: { label: string; value: number; unit?: string; prev?: number; colorClass: string; prefix?: string }) {
    const d = prev != null ? delta(value, prev) : null
    return (
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 hover:shadow-md transition-shadow">
        <div className="text-base text-gray-500 font-medium mb-1 truncate">{label}</div>
        <div className={`text-2xl font-bold ${colorClass} truncate`}>{prefix}{unit === '%' ? value.toFixed(1) + '%' : unit === 'time' ? fmtDuration(value) : unit === 'min' ? fmtMinutes(value) : typeof value === 'number' && prefix === '฿' ? fmt(value) : fmtInt(value)}</div>
        {d != null && (
          <div className={`text-sm mt-0.5 font-medium ${d >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
            {d >= 0 ? '▲' : '▼'} {fmtPct(d)} vs ก่อนหน้า
          </div>
        )}
      </div>
    )
  }

  function RankTable({ title, headers, rows, colorFrom, colorTo }: { title: string; headers: string[]; rows: (string | number)[][]; colorFrom: string; colorTo: string }) {
    return (
      <div>
        <h3 className="text-base font-bold text-gray-700 mb-2">{title}</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-base">
            <thead>
              <tr className={`bg-gradient-to-r ${colorFrom} ${colorTo} text-white`}>
                <th className="p-2.5 text-left font-semibold rounded-tl-lg">#</th>
                {headers.map((h, i) => (
                  <th key={h} className={`p-2.5 ${i === 0 ? 'text-left' : 'text-right'} font-semibold ${i === headers.length - 1 ? 'rounded-tr-lg' : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className={`border-t border-gray-100 hover:bg-gray-50 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                  <td className="p-2.5 text-gray-400 font-medium">{i + 1}</td>
                  {row.map((cell, j) => (
                    <td key={j} className={`p-2.5 ${j === 0 ? 'font-medium text-left' : 'text-right'}`}>
                      {typeof cell === 'number' ? (Number.isInteger(cell) ? fmtInt(cell) : fmt(cell)) : cell}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={headers.length + 1} className="p-6 text-center text-gray-400">ไม่มีข้อมูล</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  function BarRow({ label, value, max, sub, color }: { label: string; value: string; max: number; sub?: string; color: string }) {
    const pct = max > 0 ? (parseFloat(value.replace(/[^0-9.]/g, '')) / max) * 100 : 0
    return (
      <div className="flex items-center gap-3 py-1.5">
        <span className="w-28 text-sm font-medium text-gray-700 truncate">{label}</span>
        <div className="flex-1">
          <div className="flex items-baseline justify-between mb-0.5">
            <span className="text-sm font-semibold text-gray-800">{value}</span>
            {sub && <span className="text-sm text-gray-400">{sub}</span>}
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
        </div>
      </div>
    )
  }

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */
  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* ===== Filter Bar ===== */}
      <div className="sticky top-0 z-20 bg-white border-b border-gray-200 shadow-sm -mx-6 px-6 py-4">
        <div className="flex flex-wrap gap-1.5 mb-3">
          {presets.map((p) => (
            <button key={p.key} onClick={() => applyPreset(p.key)}
              className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors ${activePreset === p.key ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <div>
              <label className="block text-sm text-gray-500 mb-0.5">จากวันที่</label>
              <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setActivePreset(null) }}
                className="border border-gray-300 rounded-lg px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-400" />
            </div>
            <span className="text-gray-400 mt-4">—</span>
            <div>
              <label className="block text-sm text-gray-500 mb-0.5">ถึงวันที่</label>
              <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setActivePreset(null) }}
                className="border border-gray-300 rounded-lg px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-400" />
            </div>
          </div>
          <button onClick={handleSearch} disabled={loading}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-base font-medium disabled:opacity-50 shadow-sm">
            <FiSearch className="w-5 h-5" /> โหลดข้อมูล
          </button>
          <button onClick={exportExcel} disabled={!loaded || salesData.length === 0}
            className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-base font-medium disabled:opacity-50 shadow-sm">
            <FiDownload className="w-5 h-5" /> Export Excel
          </button>
        </div>
      </div>

      {loading && <div className="flex justify-center items-center py-16"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500" /></div>}
      {!loading && !loaded && <div className="text-center py-16 text-gray-400 text-lg">กดปุ่ม "โหลดข้อมูล" เพื่อเริ่มต้น</div>}

      {!loading && loaded && (
        <div className="flex-1 overflow-y-auto pt-5 space-y-5 pb-8">

          {/* ===== Overview KPI Cards (always visible) ===== */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
            <KpiCard label="ยอดขายรวม" value={salesKpi.revenue} prev={prevSalesKpi.revenue} colorClass="text-emerald-600" prefix="฿" />
            <KpiCard label="จำนวนบิล" value={salesKpi.orders} prev={prevSalesKpi.orders} colorClass="text-blue-600" />
            <KpiCard label="แม่นยำจัดสินค้า" value={wmsKpi.avgAccuracy} prev={prevWmsKpi.avgAccuracy} colorClass="text-cyan-600" unit="%" />
            <KpiCard label="เวลาจัดเฉลี่ย" value={wmsKpi.avgPickMs} prev={prevWmsKpi.avgPickMs} colorClass="text-teal-600" unit="time" />
            <KpiCard label="QC นาที/ชิ้น" value={qcKpi.avgScore / 60} prev={prevQcKpi.avgScore / 60} colorClass="text-purple-600" />
            <KpiCard label="QC Pass Rate" value={qcKpi.passRate} prev={prevQcKpi.passRate} colorClass="text-indigo-600" unit="%" />
            <KpiCard label="แก้ปัญหาเฉลี่ย" value={issueKpi.avgResMin} prev={prevIssueKpi.avgResMin} colorClass="text-amber-600" unit="min" />
            <KpiCard label="ตรวจนับแม่นยำ" value={auditKpi.avgQtyAcc} prev={prevAuditKpi.avgQtyAcc} colorClass="text-rose-600" unit="%" />
          </div>

          {/* ===== Department Tabs ===== */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="border-b border-gray-200 overflow-x-auto scrollbar-thin">
              <nav className="flex min-w-max">
                {tabs.map((t) => (
                  <button key={t.key} onClick={() => setTab(t.key)}
                    className={`px-5 py-3 text-base font-semibold whitespace-nowrap border-b-2 transition-colors ${tab === t.key ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-500'}`}>
                    {t.label}
                  </button>
                ))}
              </nav>
            </div>

            <div className="p-5">

              {/* ===== OVERVIEW TAB ===== */}
              {tab === 'overview' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <KpiCard label="ยอดขายรวม" value={salesKpi.revenue} prev={prevSalesKpi.revenue} colorClass="text-emerald-600" prefix="฿" />
                    <KpiCard label="จำนวนบิล" value={salesKpi.orders} prev={prevSalesKpi.orders} colorClass="text-blue-600" />
                    <KpiCard label="เฉลี่ย/บิล" value={salesKpi.avgOrder} colorClass="text-indigo-600" prefix="฿" />
                    <KpiCard label="จำนวนชิ้นขาย" value={salesKpi.items} colorClass="text-purple-600" />
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Top 5 pickers */}
                    <div>
                      <h3 className="text-base font-bold text-gray-700 mb-2">Top 5 พนักงานจัดสินค้า</h3>
                      {wmsByPicker.slice(0, 5).map((p, i) => (
                        <BarRow key={p.name} label={`${i + 1}. ${p.name}`}
                          value={`${p.orders ? (p.sumAcc / p.orders).toFixed(1) : 0}%`}
                          max={100} sub={`${fmtInt(p.orders)} งาน`}
                          color="bg-gradient-to-r from-cyan-400 to-cyan-600" />
                      ))}
                      {wmsByPicker.length === 0 && <div className="text-sm text-gray-400 py-2">ไม่มีข้อมูล</div>}
                    </div>

                    {/* Top 5 QC staff */}
                    <div>
                      <h3 className="text-base font-bold text-gray-700 mb-2">Top 5 พนักงาน QC</h3>
                      {qcByStaff.slice(0, 5).map((s, i) => {
                        const pr = (s.pass + s.fail) > 0 ? (s.pass / (s.pass + s.fail)) * 100 : 0
                        return (
                          <BarRow key={s.name} label={`${i + 1}. ${s.name}`}
                            value={`${pr.toFixed(1)}%`}
                            max={100} sub={`${fmtInt(s.items)} ชิ้น`}
                            color="bg-gradient-to-r from-purple-400 to-purple-600" />
                        )
                      })}
                      {qcByStaff.length === 0 && <div className="text-sm text-gray-400 py-2">ไม่มีข้อมูล</div>}
                    </div>

                    {/* Top 5 packers */}
                    <div>
                      <h3 className="text-base font-bold text-gray-700 mb-2">Top 5 พนักงานแพ็ค</h3>
                      {packByPacker.slice(0, 5).map((p, i) => (
                        <BarRow key={p.name} label={`${i + 1}. ${p.name}`}
                          value={`${fmtInt(p.logs)}`}
                          max={packByPacker[0]?.logs || 1} sub={`${fmtInt(p.orders)} ออเดอร์`}
                          color="bg-gradient-to-r from-amber-400 to-orange-500" />
                      ))}
                      {packByPacker.length === 0 && <div className="text-sm text-gray-400 py-2">ไม่มีข้อมูล</div>}
                    </div>
                  </div>

                  {/* Production + Issues summary */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div>
                      <h3 className="text-base font-bold text-gray-700 mb-2">เวลาผลิตเฉลี่ยตามแผนก</h3>
                      {prodByDept.slice(0, 8).map((d) => (
                        <BarRow key={d.dept} label={d.dept}
                          value={d.countTime ? fmtDuration(d.totalMs / d.countTime) : '-'}
                          max={prodByDept[0]?.countTime ? prodByDept[0].totalMs / prodByDept[0].countTime : 1}
                          sub={`${fmtInt(d.jobs)} งาน`}
                          color="bg-gradient-to-r from-teal-400 to-teal-600" />
                      ))}
                      {prodByDept.length === 0 && <div className="text-sm text-gray-400 py-2">ไม่มีข้อมูล</div>}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <KpiCard label="ปัญหาทั้งหมด" value={issueKpi.total} prev={prevIssueKpi.total} colorClass="text-orange-600" />
                      <KpiCard label="ปัญหาเปิดอยู่" value={issueKpi.open} colorClass="text-red-600" />
                      <KpiCard label="แก้ไขแล้ว" value={issueKpi.closed} colorClass="text-emerald-600" />
                      <KpiCard label="เวลาแก้เฉลี่ย" value={issueKpi.avgResMin} prev={prevIssueKpi.avgResMin} colorClass="text-amber-600" unit="min" />
                    </div>
                  </div>
                </div>
              )}

              {/* ===== SALES TAB ===== */}
              {tab === 'sales' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <KpiCard label="ยอดขายรวม" value={salesKpi.revenue} prev={prevSalesKpi.revenue} colorClass="text-emerald-600" prefix="฿" />
                    <KpiCard label="จำนวนบิล" value={salesKpi.orders} prev={prevSalesKpi.orders} colorClass="text-blue-600" />
                    <KpiCard label="เฉลี่ย/บิล" value={salesKpi.avgOrder} colorClass="text-indigo-600" prefix="฿" />
                    <KpiCard label="จำนวนชิ้นขาย" value={salesKpi.items} colorClass="text-purple-600" />
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <RankTable title="ยอดขายตามช่องทาง" headers={['ช่องทาง', 'บิล', 'ยอดขาย', 'เฉลี่ย/บิล']}
                      rows={salesByChannel.map((r) => [r.ch, r.orders, r.rev, r.orders ? r.rev / r.orders : 0])}
                      colorFrom="from-emerald-600" colorTo="to-emerald-700" />
                    <RankTable title="ยอดขายตามแอดมิน" headers={['แอดมิน', 'บิล', 'ยอดขาย', 'เฉลี่ย/บิล']}
                      rows={salesByAdmin.map((r) => [r.admin, r.orders, r.rev, r.orders ? r.rev / r.orders : 0])}
                      colorFrom="from-blue-600" colorTo="to-blue-700" />
                  </div>
                </div>
              )}

              {/* ===== WAREHOUSE TAB ===== */}
              {tab === 'warehouse' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <KpiCard label="ตรวจสอบทั้งหมด" value={wmsKpi.totalOrders} prev={prevWmsKpi.totalOrders} colorClass="text-blue-600" />
                    <KpiCard label="ความแม่นยำเฉลี่ย" value={wmsKpi.avgAccuracy} prev={prevWmsKpi.avgAccuracy} colorClass="text-cyan-600" unit="%" />
                    <KpiCard label="เวลาจัดเฉลี่ย" value={wmsKpi.avgPickMs} prev={prevWmsKpi.avgPickMs} colorClass="text-teal-600" unit="time" />
                  </div>
                  <RankTable title="ผลงานพนักงานจัดสินค้า"
                    headers={['พนักงาน', 'จำนวนงาน', 'แม่นยำ(%)', 'เวลาเฉลี่ย', 'ถูก', 'ผิด', 'ไม่พบ']}
                    rows={wmsByPicker.map((r) => [
                      r.name, r.orders,
                      r.orders ? Number((r.sumAcc / r.orders).toFixed(2)) : 0,
                      r.countTime ? fmtDuration(r.totalMs / r.countTime) : '-',
                      r.correct, r.wrong, r.notFind
                    ])}
                    colorFrom="from-cyan-600" colorTo="to-cyan-700" />
                </div>
              )}

              {/* ===== QC TAB ===== */}
              {tab === 'qc' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <KpiCard label="จำนวนเซสชัน" value={qcKpi.sessions} prev={prevQcKpi.sessions} colorClass="text-blue-600" />
                    <KpiCard label="คะแนนเฉลี่ย (นาที/ชิ้น)" value={qcKpi.avgScore / 60} prev={prevQcKpi.avgScore / 60} colorClass="text-purple-600" />
                    <KpiCard label="อัตรา Pass" value={qcKpi.passRate} prev={prevQcKpi.passRate} colorClass="text-emerald-600" unit="%" />
                    <KpiCard label="รายการตรวจรวม" value={qcKpi.totalItems} colorClass="text-indigo-600" />
                  </div>
                  <RankTable title="ผลงานพนักงาน QC"
                    headers={['พนักงาน', 'เซสชัน', 'รายการ', 'Pass', 'Fail', 'Pass(%)', 'นาที/ชิ้น']}
                    rows={qcByStaff.map((r) => {
                      const pr = (r.pass + r.fail) > 0 ? Number(((r.pass / (r.pass + r.fail)) * 100).toFixed(1)) : 0
                      const sc = r.countScore ? Number((r.totalScore / r.countScore / 60).toFixed(2)) : 0
                      return [r.name, r.sessions, r.items, r.pass, r.fail, pr, sc]
                    })}
                    colorFrom="from-purple-600" colorTo="to-purple-700" />
                </div>
              )}

              {/* ===== PACKING TAB ===== */}
              {tab === 'packing' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <KpiCard label="สแกนทั้งหมด" value={packKpi.totalLogs} prev={prevPackKpi.totalLogs} colorClass="text-blue-600" />
                    <KpiCard label="ออเดอร์แพ็ค" value={packKpi.uniqueOrders} prev={prevPackKpi.uniqueOrders} colorClass="text-amber-600" />
                    <KpiCard label="พนักงานแพ็ค" value={packByPacker.length} colorClass="text-purple-600" />
                  </div>
                  <RankTable title="ผลงานพนักงานแพ็คสินค้า"
                    headers={['พนักงาน', 'จำนวนสแกน', 'ออเดอร์']}
                    rows={packByPacker.map((r) => [r.name, r.logs, r.orders])}
                    colorFrom="from-amber-600" colorTo="to-amber-700" />
                </div>
              )}

              {/* ===== PRODUCTION TAB ===== */}
              {tab === 'production' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <KpiCard label="ใบงานที่มีข้อมูล" value={prodData.length} colorClass="text-blue-600" />
                    <KpiCard label="แผนกที่เก็บเวลา" value={prodByDept.length} colorClass="text-teal-600" />
                    <KpiCard label="ข้อมูลเวลารวม" value={prodByDept.reduce((s, d) => s + d.countTime, 0)} colorClass="text-indigo-600" />
                  </div>
                  <RankTable title="ประสิทธิภาพตามแผนกผลิต"
                    headers={['แผนก', 'จำนวนงาน', 'ข้อมูลเวลา', 'เวลาเฉลี่ย']}
                    rows={prodByDept.map((r) => [r.dept, r.jobs, r.countTime, r.countTime ? fmtDuration(r.totalMs / r.countTime) : '-'])}
                    colorFrom="from-teal-600" colorTo="to-teal-700" />
                </div>
              )}

              {/* ===== ISSUES TAB ===== */}
              {tab === 'issues' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <KpiCard label="ปัญหาทั้งหมด" value={issueKpi.total} prev={prevIssueKpi.total} colorClass="text-orange-600" />
                    <KpiCard label="เปิดอยู่" value={issueKpi.open} colorClass="text-red-600" />
                    <KpiCard label="แก้ไขแล้ว" value={issueKpi.closed} colorClass="text-emerald-600" />
                    <KpiCard label="เวลาแก้เฉลี่ย" value={issueKpi.avgResMin} prev={prevIssueKpi.avgResMin} colorClass="text-amber-600" unit="min" />
                  </div>
                  <RankTable title="ปัญหาแยกตามประเภท"
                    headers={['ประเภท', 'ทั้งหมด', 'เปิดอยู่', 'แก้แล้ว', 'เวลาแก้เฉลี่ย']}
                    rows={issueByType.map((r) => [r.type, r.total, r.open, r.closed, r.countMin ? fmtMinutes(r.totalMin / r.countMin) : '-'])}
                    colorFrom="from-orange-600" colorTo="to-orange-700" />
                </div>
              )}

              {/* ===== AUDIT TAB ===== */}
              {tab === 'audit' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                    <KpiCard label="ตรวจนับทั้งหมด" value={auditKpi.totalAudits} prev={prevAuditKpi.totalAudits} colorClass="text-blue-600" />
                    <KpiCard label="สำเร็จ" value={auditKpi.completed} colorClass="text-emerald-600" />
                    <KpiCard label="แม่นยำจำนวน" value={auditKpi.avgQtyAcc} prev={prevAuditKpi.avgQtyAcc} colorClass="text-cyan-600" unit="%" />
                    <KpiCard label="แม่นยำตำแหน่ง" value={auditKpi.avgLocAcc} prev={prevAuditKpi.avgLocAcc} colorClass="text-teal-600" unit="%" />
                    <KpiCard label="แม่นยำ Safety Stock" value={auditKpi.avgSSAcc} prev={prevAuditKpi.avgSSAcc} colorClass="text-indigo-600" unit="%" />
                    <KpiCard label="รายการตรวจรวม" value={auditKpi.totalItems} colorClass="text-purple-600" />
                  </div>
                  {auditData.length === 0 ? (
                    <div className="text-center py-12 text-gray-400">ไม่มีข้อมูลตรวจนับในช่วงเวลาที่เลือก</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-base">
                        <thead>
                          <tr className="bg-gradient-to-r from-indigo-600 to-indigo-700 text-white">
                            <th className="p-2.5 text-left font-semibold rounded-tl-lg">#</th>
                            <th className="p-2.5 text-left font-semibold">สถานะ</th>
                            <th className="p-2.5 text-right font-semibold">จำนวน(%)</th>
                            <th className="p-2.5 text-right font-semibold">ตำแหน่ง(%)</th>
                            <th className="p-2.5 text-right font-semibold">Safety(%)</th>
                            <th className="p-2.5 text-right font-semibold">รายการ</th>
                            <th className="p-2.5 text-left font-semibold rounded-tr-lg">วันที่สร้าง</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditData.map((a, i) => (
                            <tr key={i} className={`border-t border-gray-100 hover:bg-gray-50 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                              <td className="p-2.5 text-gray-400">{i + 1}</td>
                              <td className="p-2.5">
                                <span className={`px-2 py-0.5 rounded-full text-sm font-bold ${a.status === 'completed' || a.status === 'closed' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                                  {a.status}
                                </span>
                              </td>
                              <td className="p-2.5 text-right">{a.accuracy_percent != null ? Number(a.accuracy_percent).toFixed(1) + '%' : '-'}</td>
                              <td className="p-2.5 text-right">{a.location_accuracy_percent != null ? Number(a.location_accuracy_percent).toFixed(1) + '%' : '-'}</td>
                              <td className="p-2.5 text-right">{a.safety_stock_accuracy_percent != null ? Number(a.safety_stock_accuracy_percent).toFixed(1) + '%' : '-'}</td>
                              <td className="p-2.5 text-right">{a.total_items ?? '-'}</td>
                              <td className="p-2.5 text-gray-600">{new Date(a.created_at).toLocaleDateString('th-TH')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

            </div>
          </div>
        </div>
      )}
    </div>
  )
}
