import { useEffect, useMemo, useState } from 'react'
import { fetchAllOpeningLeaveBalances, fetchEmployees, fetchLeaveRequests, fetchLeaveTypes } from '../../lib/hrApi'
import { supabase } from '../../lib/supabase'
import type { HREmployee, HRLeaveRequest } from '../../types'

const MINUTES_PER_DAY = 480
type Workflow = { id?: string; employee_id: string; payroll_month: string; excess_days: number; salary_base: number; deduction_amount: number; status: 'pending' | 'confirmed' | 'sent'; note?: string }
type ReportRow = { employee: HREmployee; excessDays: number; salaryBase: number; dailyRate: number; deductionAmount: number; details: { name: string; days: number }[]; workflow?: Workflow }

function monthKey(date: string) { return `${date.slice(0, 7)}-01` }
function fmt(days: number) {
  const mins = Math.max(0, Math.round(days * MINUTES_PER_DAY)); const d = Math.floor(mins / MINUTES_PER_DAY); const h = Math.floor((mins % MINUTES_PER_DAY) / 60); const m = mins % 60
  return [d ? `${d} วัน` : '', h ? `${h} ชม.` : '', m ? `${m} นาที` : ''].filter(Boolean).join(' ') || '0 วัน'
}
function baht(value: number) { return Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }

export default function LeaveOverageReport() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [requests, setRequests] = useState<HRLeaveRequest[]>([])
  const [types, setTypes] = useState<Awaited<ReturnType<typeof fetchLeaveTypes>>>([])
  const [openings, setOpenings] = useState<Awaited<ReturnType<typeof fetchAllOpeningLeaveBalances>>>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')

  async function load() {
    setLoading(true)
    const [emps, reqs, leaveTypes, openingRows, saved] = await Promise.all([
      fetchEmployees(), fetchLeaveRequests(), fetchLeaveTypes(), fetchAllOpeningLeaveBalances(),
      supabase.from('hr_leave_payroll_deductions').select('*').eq('payroll_month', `${month}-01`),
    ])
    if (saved.error) throw saved.error
    setEmployees(emps); setRequests(reqs); setTypes(leaveTypes); setOpenings(openingRows); setWorkflows((saved.data || []) as Workflow[]); setLoading(false)
  }
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try { await load() }
      catch (e) { if (!cancelled) { setMessage(e instanceof Error ? e.message : String(e)); setLoading(false) } }
    })()
    return () => { cancelled = true }
  }, [month]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo<ReportRow[]>(() => {
    const targetMonth = `${month}-01`; const details = new Map<string, Map<string, number>>()
    for (const type of types) {
      for (const emp of employees) {
        const opening = openings.find(o => o.employee_id === emp.id && o.leave_type_id === type.id && o.year === Number(month.slice(0, 4)))
        const entitled = opening ? Number(opening.opening_remaining_days) : Number(type.max_days_per_year || 0)
        let cumulative = 0
        const approved = requests.filter(r => r.employee_id === emp.id && r.leave_type_id === type.id && r.status === 'approved' && r.start_date.startsWith(month.slice(0, 4)) && (!opening || r.start_date >= opening.effective_date)).sort((a, b) => a.start_date.localeCompare(b.start_date) || a.created_at.localeCompare(b.created_at))
        for (const req of approved) {
          const amount = Number(req.total_days || 0); const before = Math.max(0, cumulative - entitled); cumulative += amount; const excess = Math.max(0, cumulative - entitled) - before
          if (excess > 0 && monthKey(req.start_date) === targetMonth) { const byType = details.get(emp.id) || new Map(); byType.set(type.name, (byType.get(type.name) || 0) + excess); details.set(emp.id, byType) }
        }
      }
    }
    return employees.flatMap(employee => {
      const d = details.get(employee.id); if (!d) return []
      const itemDetails = [...d].map(([name, days]) => ({ name, days })); const excessDays = itemDetails.reduce((s, x) => s + x.days, 0)
      const salaryBase = Number(employee.salary || 0); const dailyRate = salaryBase / 30; const deductionAmount = Math.round(dailyRate * excessDays * 100) / 100
      return [{ employee, excessDays, salaryBase, dailyRate, deductionAmount, details: itemDetails, workflow: workflows.find(w => w.employee_id === employee.id) }]
    })
  }, [employees, month, openings, requests, types, workflows])

  async function setStatus(row: ReportRow, status: Workflow['status']) {
    const payload = { employee_id: row.employee.id, payroll_month: `${month}-01`, excess_days: row.excessDays, salary_base: row.salaryBase, deduction_amount: row.deductionAmount, status, confirmed_at: status === 'pending' ? null : new Date().toISOString(), sent_at: status === 'sent' ? new Date().toISOString() : null }
    const { error } = await supabase.from('hr_leave_payroll_deductions').upsert(payload, { onConflict: 'employee_id,payroll_month' }); if (error) return setMessage(error.message)
    setMessage(status === 'sent' ? 'บันทึกว่าส่งเงินเดือนแล้ว' : status === 'confirmed' ? 'ยืนยันยอดแล้ว' : 'เปิดรายการกลับมาตรวจสอบแล้ว'); await load()
  }

  return <div className="p-5 space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-bold text-surface-800">สรุปลาเกินสิทธิ์เพื่อหักเงินเดือน</h2><p className="text-sm text-surface-500">ยอดหัก = ฐานเงินเดือน ÷ 30 × วันลาเกินสิทธิ์ (1 วัน = 8 ชั่วโมง)</p></div><label className="text-sm">เดือน<input type="month" value={month} onChange={e => setMonth(e.target.value)} className="ml-2 rounded-lg border px-3 py-2"/></label></div>
    {message && <div className="rounded-lg bg-blue-50 p-3 text-sm text-blue-700">{message}</div>}
    <div className="overflow-x-auto rounded-xl border"><table className="w-full text-sm"><thead className="bg-surface-50"><tr><th className="p-3 text-left">พนักงาน</th><th className="p-3 text-left">รายละเอียดเกินสิทธิ์</th><th className="p-3 text-left">รวมต้องหัก</th><th className="p-3 text-right">ฐานเงินเดือน</th><th className="p-3 text-right">อัตรา/วัน</th><th className="p-3 text-right">ยอดเงินหัก</th><th className="p-3 text-left">สถานะ</th><th className="p-3 text-right">ดำเนินการ</th></tr></thead><tbody>
      {rows.map(row => { const locked = row.workflow?.status === 'confirmed' || row.workflow?.status === 'sent'; const savedSalary = Number(row.workflow?.salary_base || 0); const savedAmount = Number(row.workflow?.deduction_amount || 0); const shownSalary = locked && savedSalary > 0 ? savedSalary : row.salaryBase; const shownAmount = locked && savedAmount > 0 ? savedAmount : row.deductionAmount; return <tr key={row.employee.id} className="border-t"><td className="p-3 whitespace-nowrap"><b>{row.employee.employee_code}</b><div>{row.employee.first_name} {row.employee.last_name}</div></td><td className="p-3">{row.details.map(d => <div key={d.name}>{d.name}: {fmt(d.days)}</div>)}</td><td className="p-3 font-semibold text-red-700 whitespace-nowrap">{fmt(row.excessDays)}</td><td className="p-3 text-right whitespace-nowrap">{baht(shownSalary)} บาท</td><td className="p-3 text-right whitespace-nowrap">{baht(shownSalary / 30)} บาท</td><td className="p-3 text-right font-bold text-red-700 whitespace-nowrap">{baht(shownAmount)} บาท</td><td className="p-3">{row.workflow?.status === 'sent' ? 'ส่งเงินเดือนแล้ว' : row.workflow?.status === 'confirmed' ? 'ยืนยันแล้ว' : 'รอตรวจสอบ'}</td><td className="p-3"><div className="flex justify-end gap-2">{row.workflow?.status !== 'confirmed' && row.workflow?.status !== 'sent' && <button onClick={() => setStatus(row, 'confirmed')} className="rounded-lg bg-amber-500 px-3 py-2 text-white">ยืนยันยอด</button>}{row.workflow?.status === 'confirmed' && <button onClick={() => setStatus(row, 'sent')} className="rounded-lg bg-emerald-600 px-3 py-2 text-white">ส่งเงินเดือนแล้ว</button>}{row.workflow?.status && <button onClick={() => setStatus(row, 'pending')} className="rounded-lg border px-3 py-2">เปิดตรวจสอบใหม่</button>}</div></td></tr> })}
      {!loading && rows.length === 0 && <tr><td colSpan={8} className="p-10 text-center text-surface-500">ไม่พบรายการลาเกินสิทธิ์ในเดือนนี้</td></tr>}{loading && <tr><td colSpan={8} className="p-10 text-center">กำลังคำนวณ...</td></tr>}
    </tbody></table></div>
  </div>
}
