import { useCallback, useEffect, useMemo, useState } from 'react'
import { pdf } from '@react-pdf/renderer'
import * as XLSX from 'xlsx'
import { useAuthContext } from '../../contexts/AuthContext'
import type { HRCompany } from '../../types'
import {
  fetchConfirmedLeaveDeductions, fetchHRCompanies, fetchPayrollEmployees, fetchPayrollHistory,
  fetchPayrollRun, savePayrollRun, type PayrollItem, type PayrollRun,
} from '../../lib/payrollApi'
import PayrollSlipPDF, { type PayrollYtd } from './pdf/PayrollSlipPDF'

const currentMonth = () => new Date().toISOString().slice(0, 7)
const fmt = (value: number) => Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const monthLabel = (month: string) => new Date(`${month}-01T00:00:00`).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })
const calc = (item: PayrollItem) => {
  const gross = item.base_salary + item.position_allowance + item.other_income
  const deduction = item.personal_tax + item.social_security + item.savings + item.student_loan + item.company_loan + item.leave_deduction + item.other_deduction
  return { gross, deduction, net: gross - deduction }
}

export default function PayrollSection() {
  const { user } = useAuthContext()
  const [companies, setCompanies] = useState<HRCompany[]>([])
  const [companyId, setCompanyId] = useState('')
  const [month, setMonth] = useState(currentMonth())
  const [paymentDate, setPaymentDate] = useState('')
  const [items, setItems] = useState<PayrollItem[]>([])
  const [run, setRun] = useState<PayrollRun | null>(null)
  const [history, setHistory] = useState<PayrollRun[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const company = companies.find((c) => c.id === companyId)
  const locked = run?.status === 'confirmed'

  useEffect(() => {
    fetchHRCompanies().then((rows) => { setCompanies(rows); setCompanyId((id) => id || rows[0]?.id || '') }).catch((e) => setMessage(e.message))
  }, [])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true); setMessage('')
    try {
      const [employees, leaveMap, savedRun, historyRows] = await Promise.all([
        fetchPayrollEmployees(companyId), fetchConfirmedLeaveDeductions(month), fetchPayrollRun(month, companyId), fetchPayrollHistory(companyId),
      ])
      setHistory(historyRows)
      setRun(savedRun)
      setPaymentDate(savedRun?.payment_date || `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()}`)
      if (savedRun?.items?.length) setItems(savedRun.items.map((item) => ({ ...item, base_salary: Number(item.base_salary), position_allowance: Number(item.position_allowance), personal_tax: Number(item.personal_tax), social_security: Number(item.social_security), savings: Number(item.savings), student_loan: Number(item.student_loan), company_loan: Number(item.company_loan), leave_deduction: Number(item.leave_deduction), other_income: Number(item.other_income), other_deduction: Number(item.other_deduction), savings_opening_balance: Number(item.savings_opening_balance), company_loan_opening_balance: Number(item.company_loan_opening_balance), company_loan_opening_installments: Number(item.company_loan_opening_installments) })))
      else setItems(employees.map((employee) => ({
        employee_id: employee.id, employee_code: employee.employee_code,
        employee_name: `${employee.prefix || ''}${employee.first_name} ${employee.last_name}`.trim(),
        department_position: [employee.department?.name, employee.position?.name].filter(Boolean).join(' / '),
        base_salary: Number(employee.salary) || 0, position_allowance: Number(employee.position_allowance) || 0,
        personal_tax: Number(employee.monthly_personal_tax) || 0, social_security: Number(employee.monthly_social_security) || 0,
        savings: Number(employee.monthly_savings) || 0,
        student_loan: Number(employee.monthly_student_loan) || 0, company_loan: Number(employee.monthly_company_loan) || 0,
        leave_deduction: leaveMap[employee.id] || 0, other_income: 0, other_deduction: 0,
        savings_opening_balance: Number(employee.savings_opening_balance) || 0,
        company_loan_opening_balance: Number(employee.company_loan_opening_balance) || 0,
        company_loan_opening_installments: Number(employee.company_loan_opening_installments) || 0,
      })))
    } catch (e) { setMessage(e instanceof Error ? e.message : 'โหลดข้อมูลเงินเดือนไม่สำเร็จ') }
    finally { setLoading(false) }
  }, [companyId, month])
  useEffect(() => { load() }, [load])

  const totals = useMemo(() => items.reduce((sum, item) => { const c = calc(item); return { salary: sum.salary + c.gross, tax: sum.tax + item.personal_tax, social: sum.social + item.social_security, savings: sum.savings + item.savings, student: sum.student + item.student_loan, companyLoan: sum.companyLoan + item.company_loan, leave: sum.leave + item.leave_deduction, net: sum.net + c.net } }, { salary: 0, tax: 0, social: 0, savings: 0, student: 0, companyLoan: 0, leave: 0, net: 0 }), [items])

  const financialProgress = (item: PayrollItem, cutoffMonth = month, includeDraft = !locked) => {
    const confirmedRows = history
      .filter((h) => h.payroll_month.slice(0, 7) <= cutoffMonth)
      .flatMap((h) => h.items || [])
      .filter((row) => row.employee_id === item.employee_id)
    const rows = includeDraft ? [...confirmedRows.filter((row) => row.payroll_run_id !== run?.id), item] : confirmedRows
    const savingsPaid = rows.reduce((sum, row) => sum + Number(row.savings || 0), 0)
    const loanPaid = rows.reduce((sum, row) => sum + Number(row.company_loan || 0), 0)
    const paidInstallments = rows.filter((row) => Number(row.company_loan || 0) > 0).length
    return {
      accumulatedSavings: Number(item.savings_opening_balance || 0) + savingsPaid,
      companyLoanBalance: Math.max(0, Number(item.company_loan_opening_balance || 0) - loanPaid),
      companyLoanInstallments: Math.max(0, Number(item.company_loan_opening_installments || 0) - paidInstallments),
    }
  }

  const update = (index: number, key: keyof PayrollItem, value: number) => setItems((rows) => rows.map((row, i) => i === index ? { ...row, [key]: value } : row))
  const save = async (confirm: boolean) => {
    if (!company) return
    if (confirm && !window.confirm(`ยืนยันยอดเงินเดือน ${monthLabel(month)} ของ ${company.name_th}? หลังยืนยันจะล็อกยอดสำหรับรายงานย้อนหลัง`)) return
    setSaving(true)
    try { const saved = await savePayrollRun({ month, company, paymentDate, items, confirm, userId: user?.id }); setRun(saved); setItems(saved.items || items); setMessage(confirm ? 'ยืนยันยอดเงินเดือนเรียบร้อย' : 'บันทึกร่างเรียบร้อย'); setHistory(await fetchPayrollHistory(companyId)) }
    catch (e) { setMessage(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  const ytdFor = (item: PayrollItem): PayrollYtd => {
    const year = month.slice(0, 4)
    const previous = history.filter((h) => h.payroll_month.startsWith(year) && h.payroll_month.slice(0, 7) <= month).flatMap((h) => h.items || []).filter((x) => x.employee_id === item.employee_id)
    const rows = run?.status === 'confirmed' ? previous : [...previous.filter((x) => x.payroll_run_id !== run?.id), item]
    const yearly = rows.reduce((sum, row) => { const c = calc(row); return { income: sum.income + c.gross, personalTax: sum.personalTax + Number(row.personal_tax), socialSecurity: sum.socialSecurity + Number(row.social_security), studentLoan: sum.studentLoan + Number(row.student_loan), companyLoan: sum.companyLoan + Number(row.company_loan) } }, { income: 0, personalTax: 0, socialSecurity: 0, studentLoan: 0, companyLoan: 0 })
    return { ...yearly, ...financialProgress(item) }
  }

  const downloadSlip = async (item: PayrollItem) => {
    if (!company) return
    const itemCalc = calc(item)
    const blob = await pdf(<PayrollSlipPDF company={(item.company_snapshot as HRCompany) || company} item={{ ...item, gross_income: itemCalc.gross, total_deduction: itemCalc.deduction, net_pay: itemCalc.net }} monthLabel={monthLabel(month)} paymentDate={paymentDate ? new Date(`${paymentDate}T00:00:00`).toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' }) : '-'} ytd={ytdFor(item)} />).toBlob()
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `สลิปเงินเดือน_${item.employee_code}_${month}.pdf`; a.click(); URL.revokeObjectURL(url)
  }

  const exportExcel = (targetRun: PayrollRun | null = run) => {
    const exportItems = targetRun?.items || items
    const exportCompany = targetRun?.company || company
    const exportMonth = targetRun?.payroll_month.slice(0, 7) || month
    const rows = exportItems.map((item) => {
      const c = calc(item)
      const progress = financialProgress(item, exportMonth, targetRun ? false : !locked)
      return { 'รหัสพนักงาน': item.employee_code, 'ชื่อ-สกุล': item.employee_name, 'แผนก/ตำแหน่ง': item.department_position || '', 'เงินเดือน': item.base_salary, 'เงินพิเศษ': item.position_allowance, 'รายได้อื่น': item.other_income, 'รวมรายได้': c.gross, 'ภาษี': item.personal_tax, 'ประกันสังคม': item.social_security, 'เงินสะสมเดือนนี้': item.savings, 'เงินสะสมรวม': progress.accumulatedSavings, 'กยศ.': item.student_loan, 'เงินกู้บริษัทฯ เดือนนี้': item.company_loan, 'เงินกู้บริษัทฯ คงเหลือ': progress.companyLoanBalance, 'งวดคงเหลือ': progress.companyLoanInstallments, 'ลาเกินสิทธิ์': item.leave_deduction, 'หักอื่น': item.other_deduction, 'รวมหัก': c.deduction, 'เงินสุทธิ': c.net }
    })
    const ws = XLSX.utils.json_to_sheet(rows); ws['!cols'] = [12, 26, 24, ...Array(12).fill(14)].map((wch) => ({ wch }))
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'เงินเดือน'); XLSX.writeFile(wb, `รายงานเงินเดือน_${exportCompany?.company_key || 'company'}_${exportMonth}.xlsx`)
  }

  const cards = [['ยอดเงินเดือน', totals.salary, 'text-blue-700'], ['ภาษีส่วนบุคคล', totals.tax, 'text-amber-700'], ['ประกันสังคม', totals.social, 'text-purple-700'], ['เงินสะสม', totals.savings, 'text-indigo-700'], ['กยศ.', totals.student, 'text-cyan-700'], ['เงินกู้บริษัทฯ', totals.companyLoan, 'text-orange-700'], ['ลาเกินสิทธิ์', totals.leave, 'text-red-700'], ['ยอดสุทธิ', totals.net, 'text-emerald-700']] as const
  return <div className="space-y-5">
    <div className="rounded-xl border bg-white p-4 flex flex-wrap gap-3 items-end"><label className="text-sm">บริษัท<select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="block mt-1 rounded-lg border px-3 py-2 min-w-72">{companies.map((c) => <option key={c.id} value={c.id}>{c.name_th}</option>)}</select></label><label className="text-sm">เดือน<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="block mt-1 rounded-lg border px-3 py-2" /></label><label className="text-sm">วันที่จ่าย<input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} disabled={locked} className="block mt-1 rounded-lg border px-3 py-2 disabled:bg-gray-100" /></label><span className={`rounded-full px-3 py-2 text-sm font-semibold ${locked ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{locked ? 'ยืนยันยอดแล้ว' : 'รอตรวจสอบ'}</span><div className="ml-auto flex gap-2"><button onClick={() => exportExcel()} disabled={!items.length} className="rounded-lg border border-emerald-600 px-4 py-2 text-emerald-700">ดาวน์โหลด Excel</button>{!locked && <><button onClick={() => save(false)} disabled={saving} className="rounded-lg border px-4 py-2">บันทึกร่าง</button><button onClick={() => save(true)} disabled={saving || !items.length} className="rounded-lg bg-emerald-600 px-4 py-2 text-white">ยืนยันยอด</button></>}</div></div>
    {message && <div className="rounded-lg bg-blue-50 px-4 py-3 text-blue-700">{message}</div>}
    <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">{cards.map(([label, value, color]) => <div key={label} className="rounded-xl border bg-white p-4"><div className="text-xs text-gray-500">{label}</div><div className={`mt-1 text-xl font-bold ${color}`}>{fmt(value)}</div></div>)}</div>
    <div className="rounded-xl border bg-white overflow-x-auto">{loading ? <div className="p-12 text-center">กำลังโหลด...</div> : <table className="w-full text-sm whitespace-nowrap"><thead className="bg-gray-50"><tr>{['พนักงาน','เงินเดือน','ภาษี','ประกันสังคม','เงินสะสม','กยศ.','กู้บริษัทฯ','ลาเกินสิทธิ์','รายได้อื่น','หักอื่น','สุทธิ','สลิป'].map((h) => <th key={h} className="p-3 text-right first:text-left">{h}</th>)}</tr></thead><tbody>{items.map((item, index) => { const c = calc(item); const progress = financialProgress(item); return <tr key={item.employee_id} className="border-t"><td className="p-3"><b>{item.employee_code}</b><div>{item.employee_name}</div><div className="text-xs text-gray-500">{item.department_position}</div></td><td className="p-3 text-right">{fmt(item.base_salary + item.position_allowance)}</td>{(['personal_tax','social_security','savings','student_loan','company_loan','leave_deduction','other_income','other_deduction'] as const).map((key) => <td key={key} className="p-2 text-right">{key === 'savings' ? <><div>{fmt(item.savings)}</div><div className="text-xs text-indigo-600">สะสม {fmt(progress.accumulatedSavings)}</div></> : key === 'company_loan' ? <><div>{fmt(item.company_loan)}</div><div className="text-xs text-orange-600">เหลือ {fmt(progress.companyLoanBalance)} ({progress.companyLoanInstallments} งวด)</div></> : locked || !['other_income','other_deduction'].includes(key) ? fmt(item[key]) : <input type="number" min="0" value={item[key]} onChange={(e) => update(index, key, Number(e.target.value) || 0)} className="w-24 rounded border px-2 py-1 text-right" />}</td>)}<td className="p-3 text-right font-bold text-emerald-700">{fmt(c.net)}</td><td className="p-3 text-right"><button onClick={() => downloadSlip(item)} className="rounded-lg bg-blue-50 text-blue-700 px-3 py-2">ดาวน์โหลด</button></td></tr> })}</tbody></table>}</div>
    <div className="rounded-xl border bg-white overflow-hidden"><div className="p-4 border-b font-semibold">รายงานย้อนหลัง</div><table className="w-full text-sm"><thead className="bg-gray-50"><tr><th className="p-3 text-left">เดือน</th><th className="p-3 text-left">บริษัท</th><th className="p-3 text-right">พนักงาน</th><th className="p-3 text-right">ยอดสุทธิ</th><th className="p-3 text-right">รายงาน</th></tr></thead><tbody>{history.map((h) => <tr key={h.id} className="border-t"><td className="p-3">{monthLabel(h.payroll_month.slice(0, 7))}</td><td className="p-3">{h.company?.name_th}</td><td className="p-3 text-right">{h.items?.length || 0}</td><td className="p-3 text-right font-semibold">{fmt((h.items || []).reduce((sum, item) => sum + calc(item).net, 0))}</td><td className="p-3 text-right"><button onClick={() => exportExcel(h)} className="text-emerald-700">ดาวน์โหลด Excel</button></td></tr>)}</tbody></table></div>
  </div>
}
