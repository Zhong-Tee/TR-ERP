import { useCallback, useEffect, useMemo, useState } from 'react'
import { pdf } from '@react-pdf/renderer'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import { useAuthContext } from '../../contexts/AuthContext'
import type { HRCompany } from '../../types'
import {
  fetchConfirmedLeaveDeductions, fetchHRCompanies, fetchPayrollEmployees, fetchPayrollHistory,
  fetchPayrollRun, fetchSocialSecuritySettings, calculateSocialSecurity, savePayrollRun,
  type PayrollItem, type PayrollRun,
} from '../../lib/payrollApi'
import PayrollSlipPDF, { type PayrollYtd } from './pdf/PayrollSlipPDF'
import Modal from '../ui/Modal'

const currentMonth = () => new Date().toISOString().slice(0, 7)
const fmt = (value: number) => Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const monthLabel = (month: string) => new Date(`${month}-01T00:00:00`).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })
const employeeFullName = (employee: { prefix?: string; first_name: string; last_name: string }) =>
  `${employee.prefix || ''}${employee.first_name} ${employee.last_name}`.replace(/\s+/g, ' ').trim()
const safeFilePart = (value: string) => value.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim()
const slipFileName = (item: PayrollItem, targetMonth: string) => {
  const employee = item.employee_nickname
    ? `${item.employee_name} (${item.employee_nickname})`
    : item.employee_name
  return `สลิปเงินเดือน_${safeFilePart(employee)}_${targetMonth}.pdf`
}
const sortPayrollItems = (rows: PayrollItem[]) => [...rows].sort((a, b) =>
  a.employee_code.localeCompare(b.employee_code, 'en', { numeric: true, sensitivity: 'base' }))
const calc = (item: PayrollItem) => {
  const gross = item.base_salary + item.position_allowance + item.other_income
  const deduction = item.personal_tax + item.social_security + item.savings + item.student_loan + item.company_loan + item.leave_deduction + item.other_deduction
  return { gross, deduction, net: gross - deduction }
}
const employeeSocialSecurity = (employeeCode: string, wage: number, settings: Parameters<typeof calculateSocialSecurity>[1]) =>
  employeeCode === 'EMP00001' ? 0 : calculateSocialSecurity(wage, settings)

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
  const [activeView, setActiveView] = useState<'payroll' | 'history'>('payroll')
  const [historySearch, setHistorySearch] = useState('')
  const [historyDateFrom, setHistoryDateFrom] = useState('')
  const [historyDateTo, setHistoryDateTo] = useState('')
  const [preview, setPreview] = useState<{ item: PayrollItem; url: string } | null>(null)
  const [zipLoading, setZipLoading] = useState(false)
  const company = companies.find((c) => c.id === companyId)
  const locked = run?.status === 'confirmed'

  useEffect(() => {
    fetchHRCompanies().then((rows) => { setCompanies(rows); setCompanyId((id) => id || rows[0]?.id || '') }).catch((e) => setMessage(e.message))
  }, [])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true); setMessage('')
    try {
      const [employees, leaveMap, savedRun, historyRows, socialSecuritySettings] = await Promise.all([
        fetchPayrollEmployees(companyId), fetchConfirmedLeaveDeductions(month), fetchPayrollRun(month, companyId), fetchPayrollHistory(companyId), fetchSocialSecuritySettings(),
      ])
      setHistory(historyRows)
      setRun(savedRun)
      setPaymentDate(savedRun?.payment_date || `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()}`)
      if (savedRun?.items?.length) {
        const employeesById = new Map(employees.map((employee) => [employee.id, employee]))
        setItems(sortPayrollItems((savedRun.items || []).map((item) => {
          const employee = employeesById.get(item.employee_id)
          const baseSalary = Number(item.base_salary)
          const positionAllowance = Number(item.position_allowance)
          return { ...item, employee_name: employee ? employeeFullName(employee) : item.employee_name, employee_nickname: item.employee_nickname || employee?.nickname || null, base_salary: baseSalary, position_allowance: positionAllowance, personal_tax: Number(item.personal_tax), social_security: savedRun.status === 'confirmed' ? Number(item.social_security) : employeeSocialSecurity(item.employee_code, baseSalary + positionAllowance, socialSecuritySettings), savings: Number(item.savings), student_loan: Number(item.student_loan), company_loan: Number(item.company_loan), leave_deduction: Number(item.leave_deduction), other_income: Number(item.other_income), other_deduction: Number(item.other_deduction), income_opening_balance: Number(item.income_opening_balance), personal_tax_opening_balance: Number(item.personal_tax_opening_balance), social_security_opening_balance: Number(item.social_security_opening_balance), student_loan_opening_balance: Number(item.student_loan_opening_balance), savings_opening_balance: Number(item.savings_opening_balance), company_loan_opening_balance: Number(item.company_loan_opening_balance), company_loan_opening_installments: Number(item.company_loan_opening_installments) }
        })))
      }
      else if ((!savedRun || savedRun.status === 'draft') && month === currentMonth()) setItems(sortPayrollItems(employees.map((employee) => ({
        employee_id: employee.id, employee_code: employee.employee_code,
        employee_name: employeeFullName(employee),
        employee_nickname: employee.nickname || null,
        department_position: [employee.department?.name, employee.position?.name].filter(Boolean).join(' / '),
        base_salary: Number(employee.salary) || 0, position_allowance: Number(employee.position_allowance) || 0,
        personal_tax: Number(employee.monthly_personal_tax) || 0,
        social_security: employeeSocialSecurity(employee.employee_code, (Number(employee.salary) || 0) + (Number(employee.position_allowance) || 0), socialSecuritySettings),
        savings: Number(employee.monthly_savings) || 0,
        student_loan: Number(employee.monthly_student_loan) || 0, company_loan: Number(employee.monthly_company_loan) || 0,
        leave_deduction: leaveMap[employee.id] || 0, other_income: 0, other_deduction: 0,
        income_opening_balance: Number(employee.income_opening_balance) || 0,
        personal_tax_opening_balance: Number(employee.personal_tax_opening_balance) || 0,
        social_security_opening_balance: Number(employee.social_security_opening_balance) || 0,
        student_loan_opening_balance: Number(employee.student_loan_opening_balance) || 0,
        savings_opening_balance: Number(employee.savings_opening_balance) || 0,
        company_loan_opening_balance: Number(employee.company_loan_opening_balance) || 0,
        company_loan_opening_installments: Number(employee.company_loan_opening_installments) || 0,
      }))))
      else {
        setItems([])
        setMessage(`ไม่พบข้อมูลเงินเดือนที่บันทึกไว้สำหรับ${monthLabel(month)}`)
      }
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

  const update = (index: number, key: keyof PayrollItem, value: number) => setItems((rows) => rows.map((row, i) => i === index ? { ...row, [key]: value, reviewed_at: null, reviewed_by: null } : row))
  const save = async (confirm: boolean) => {
    if (!company) return
    if (confirm && items.some((item) => !item.reviewed_at)) {
      setMessage('กรุณาพรีวิวและกด “ตรวจสอบแล้ว” ให้ครบทุกคนก่อนยืนยันยอด')
      return
    }
    if (confirm && !window.confirm(`ยืนยันยอดเงินเดือน ${monthLabel(month)} ของ ${company.name_th}? หลังยืนยันจะล็อกยอดสำหรับรายงานย้อนหลัง`)) return
    setSaving(true)
    try { const saved = await savePayrollRun({ month, company, paymentDate, items, confirm, userId: user?.id }); setRun(saved); setItems(sortPayrollItems(saved.items || items)); setMessage(confirm ? 'ยืนยันยอดเงินเดือนเรียบร้อย' : 'บันทึกร่างเรียบร้อย'); setHistory(await fetchPayrollHistory(companyId)) }
    catch (e) { setMessage(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  const ytdFor = (item: PayrollItem): PayrollYtd => {
    const year = month.slice(0, 4)
    const previous = history.filter((h) => h.payroll_month.startsWith(year) && h.payroll_month.slice(0, 7) <= month).flatMap((h) => h.items || []).filter((x) => x.employee_id === item.employee_id)
    const rows = run?.status === 'confirmed' ? previous : [...previous.filter((x) => x.payroll_run_id !== run?.id), item]
    const yearly = rows.reduce((sum, row) => { const c = calc(row); return { income: sum.income + c.gross, personalTax: sum.personalTax + Number(row.personal_tax), socialSecurity: sum.socialSecurity + Number(row.social_security), studentLoan: sum.studentLoan + Number(row.student_loan), companyLoan: sum.companyLoan + Number(row.company_loan) } }, { income: 0, personalTax: 0, socialSecurity: 0, studentLoan: 0, companyLoan: 0 })
    return {
      ...yearly,
      income: Number(item.income_opening_balance || 0) + yearly.income,
      personalTax: Number(item.personal_tax_opening_balance || 0) + yearly.personalTax,
      socialSecurity: Number(item.social_security_opening_balance || 0) + yearly.socialSecurity,
      studentLoan: Number(item.student_loan_opening_balance || 0) + yearly.studentLoan,
      ...financialProgress(item),
    }
  }

  const createSlipBlob = async (item: PayrollItem) => {
    if (!company) return
    const itemCalc = calc(item)
    return pdf(<PayrollSlipPDF company={(item.company_snapshot as HRCompany) || company} item={{ ...item, gross_income: itemCalc.gross, total_deduction: itemCalc.deduction, net_pay: itemCalc.net }} monthLabel={monthLabel(month)} paymentDate={paymentDate ? new Date(`${paymentDate}T00:00:00`).toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' }) : '-'} ytd={ytdFor(item)} />).toBlob()
  }

  const downloadSlip = async (item: PayrollItem) => {
    const blob = await createSlipBlob(item)
    if (!blob) return
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = slipFileName(item, month); a.click(); URL.revokeObjectURL(url)
  }

  const previewSlip = async (item: PayrollItem) => {
    if (!company) return
    const blob = await createSlipBlob(item)
    if (!blob) return
    setPreview((old) => { if (old) URL.revokeObjectURL(old.url); return { item, url: URL.createObjectURL(blob) } })
  }

  const downloadAllSlipsZip = async () => {
    if (!company || !locked || !items.length) return
    setZipLoading(true); setMessage('')
    try {
      const zip = new JSZip()
      for (const item of sortPayrollItems(items)) {
        const blob = await createSlipBlob(item)
        if (blob) zip.file(slipFileName(item, month), blob)
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `สลิปเงินเดือน_${company.company_key}_${month}.zip`; a.click(); URL.revokeObjectURL(url)
      setMessage(`ดาวน์โหลดสลิปเงินเดือน ${items.length} รายการเรียบร้อย`)
    } catch (e) { setMessage(e instanceof Error ? e.message : 'สร้างไฟล์ ZIP ไม่สำเร็จ') }
    finally { setZipLoading(false) }
  }

  const markReviewed = async () => {
    if (!preview || !company || !user?.id || locked) return
    const reviewedAt = new Date().toISOString()
    const nextItems = items.map((item) => item.employee_id === preview.item.employee_id ? { ...item, reviewed_at: reviewedAt, reviewed_by: user.id } : item)
    setSaving(true)
    try {
      const saved = await savePayrollRun({ month, company, paymentDate, items: nextItems, confirm: false, userId: user.id })
      setRun(saved); setItems(sortPayrollItems(saved.items || nextItems)); setPreview(null)
      setHistory(await fetchPayrollHistory(companyId)); setMessage(`ตรวจสอบสลิป ${preview.item.employee_code} แล้ว`)
    } catch (e) { setMessage(e instanceof Error ? e.message : 'บันทึกผลตรวจสอบไม่สำเร็จ') }
    finally { setSaving(false) }
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
  const filteredHistory = history.filter((row) => {
    const reportMonth = row.payroll_month.slice(0, 7)
    if (historyDateFrom && reportMonth < historyDateFrom) return false
    if (historyDateTo && reportMonth > historyDateTo) return false
    const query = historySearch.trim().toLocaleLowerCase('th-TH')
    if (!query) return true
    const searchable = [row.company?.name_th, row.company?.name_en, monthLabel(row.payroll_month.slice(0, 7)), ...(row.items || []).flatMap((item) => [item.employee_code, item.employee_name])].filter(Boolean).join(' ').toLocaleLowerCase('th-TH')
    return searchable.includes(query)
  })
  return <div className="space-y-5">
    <div className="flex gap-2 border-b border-gray-200">
      <button type="button" onClick={() => setActiveView('payroll')} className={`px-4 py-3 font-medium border-b-2 ${activeView === 'payroll' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-gray-500'}`}>จัดทำเงินเดือน</button>
      <button type="button" onClick={() => setActiveView('history')} className={`px-4 py-3 font-medium border-b-2 ${activeView === 'history' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-gray-500'}`}>รายงานย้อนหลัง</button>
    </div>
    {activeView === 'history' ? <>
      <div className="rounded-xl border bg-white p-4 flex flex-wrap gap-3 items-end">
        <label className="text-sm">บริษัท<select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="block mt-1 rounded-lg border px-3 py-2 min-w-64">{companies.map((c) => <option key={c.id} value={c.id}>{c.name_th}</option>)}</select></label>
        <label className="text-sm">เดือนเริ่มต้น<input type="month" value={historyDateFrom} onChange={(e) => setHistoryDateFrom(e.target.value)} className="block mt-1 rounded-lg border px-3 py-2" /></label>
        <label className="text-sm">เดือนสิ้นสุด<input type="month" value={historyDateTo} onChange={(e) => setHistoryDateTo(e.target.value)} className="block mt-1 rounded-lg border px-3 py-2" /></label>
        <label className="text-sm flex-1 min-w-64">ค้นหา<input type="search" value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} placeholder="เดือน บริษัท รหัส หรือชื่อพนักงาน" className="block mt-1 w-full rounded-lg border px-3 py-2" /></label>
      </div>
      {message && <div className="rounded-lg bg-blue-50 px-4 py-3 text-blue-700">{message}</div>}
      <div className="rounded-xl border bg-white overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-50"><tr><th className="p-3 text-left">เดือน</th><th className="p-3 text-left">บริษัท</th><th className="p-3 text-right">พนักงาน</th><th className="p-3 text-right">ยอดสุทธิ</th><th className="p-3 text-right">รายงาน</th></tr></thead><tbody>{filteredHistory.map((h) => <tr key={h.id} className="border-t"><td className="p-3">{monthLabel(h.payroll_month.slice(0, 7))}</td><td className="p-3">{h.company?.name_th}</td><td className="p-3 text-right">{h.items?.length || 0}</td><td className="p-3 text-right font-semibold">{fmt((h.items || []).reduce((sum, item) => sum + calc(item).net, 0))}</td><td className="p-3 text-right"><button onClick={() => exportExcel(h)} className="text-emerald-700">ดาวน์โหลด Excel</button></td></tr>)}{!loading && !filteredHistory.length && <tr><td colSpan={5} className="p-10 text-center text-gray-500">ไม่พบรายงาน</td></tr>}</tbody></table></div>
    </> : <>
    <div className="rounded-xl border bg-white p-4 flex flex-wrap gap-3 items-end"><label className="text-sm">บริษัท<select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="block mt-1 rounded-lg border px-3 py-2 min-w-72">{companies.map((c) => <option key={c.id} value={c.id}>{c.name_th}</option>)}</select></label><label className="text-sm">เดือน<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="block mt-1 rounded-lg border px-3 py-2" /></label><label className="text-sm">วันที่จ่าย<input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} disabled={locked} className="block mt-1 rounded-lg border px-3 py-2 disabled:bg-gray-100" /></label><span className={`rounded-full px-3 py-2 text-sm font-semibold ${locked ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{locked ? 'ยืนยันยอดแล้ว' : `ตรวจแล้ว ${items.filter((item) => item.reviewed_at).length}/${items.length}`}</span><div className="ml-auto flex gap-2"><button onClick={() => exportExcel()} disabled={!items.length} className="rounded-lg border border-emerald-600 px-4 py-2 text-emerald-700">ดาวน์โหลด Excel</button>{locked && <button onClick={downloadAllSlipsZip} disabled={zipLoading || !items.length} className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{zipLoading ? 'กำลังสร้าง ZIP...' : 'ดาวน์โหลด ZIP'}</button>}{!locked && <><button onClick={() => save(false)} disabled={saving || !items.length} className="rounded-lg border px-4 py-2 disabled:opacity-50">บันทึกร่าง</button><button onClick={() => save(true)} disabled={saving || !items.length || items.some((item) => !item.reviewed_at)} title={items.some((item) => !item.reviewed_at) ? 'ต้องตรวจสอบสลิปให้ครบทุกคนก่อน' : undefined} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">ยืนยันยอด</button></>}</div></div>
    {message && <div className="rounded-lg bg-blue-50 px-4 py-3 text-blue-700">{message}</div>}
    <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">{cards.map(([label, value, color]) => <div key={label} className="rounded-xl border bg-white p-4"><div className="text-xs text-gray-500">{label}</div><div className={`mt-1 text-xl font-bold ${color}`}>{fmt(value)}</div></div>)}</div>
    <div className="rounded-xl border bg-white overflow-x-auto">{loading ? <div className="p-12 text-center">กำลังโหลด...</div> : <table className="w-full text-sm whitespace-nowrap"><thead className="bg-gray-50"><tr>{['พนักงาน','เงินเดือน','ภาษี','ประกันสังคม','เงินสะสม','กยศ.','กู้บริษัทฯ','ลาเกินสิทธิ์','รายได้อื่นๆ','หักอื่นๆ','สุทธิ','สลิป'].map((h) => <th key={h} className="p-3 text-right first:text-left">{h}</th>)}</tr></thead><tbody>{items.map((item, index) => { const c = calc(item); const progress = financialProgress(item); return <tr key={item.employee_id} className="border-t"><td className="p-3"><div className="flex items-center gap-2"><b>{item.employee_code}</b>{locked ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">ยืนยันยอดแล้ว</span> : item.reviewed_at ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">ตรวจสอบแล้ว</span> : null}</div><div>{item.employee_name}</div><div className="text-xs text-gray-500">{item.department_position}</div></td><td className="p-3 text-right">{fmt(item.base_salary + item.position_allowance)}</td>{(['personal_tax','social_security','savings','student_loan','company_loan','leave_deduction','other_income','other_deduction'] as const).map((key) => <td key={key} className="p-2 text-right">{key === 'savings' ? <><div>{fmt(item.savings)}</div><div className="text-xs text-indigo-600">สะสม {fmt(progress.accumulatedSavings)}</div></> : key === 'company_loan' ? <><div>{fmt(item.company_loan)}</div><div className="text-xs text-orange-600">เหลือ {fmt(progress.companyLoanBalance)} ({progress.companyLoanInstallments} งวด)</div></> : locked || !['personal_tax','student_loan','other_income','other_deduction'].includes(key) ? fmt(item[key]) : <input type="text" inputMode="decimal" value={item[key]} onChange={(e) => { const value = e.target.value.replace(/,/g, '').replace(/[^\d.]/g, ''); update(index, key, Number(value) || 0) }} className="w-24 rounded border px-2 py-1 text-right" />}</td>)}<td className="p-3 text-right font-bold text-emerald-700">{fmt(c.net)}</td><td className="p-3 text-right"><div className="flex justify-end gap-2"><button onClick={() => previewSlip(item)} className="rounded-lg bg-gray-100 text-gray-700 px-3 py-2">ดู</button><button onClick={() => downloadSlip(item)} className="rounded-lg bg-blue-50 text-blue-700 px-3 py-2">ดาวน์โหลด</button></div></td></tr> })}</tbody></table>}</div>
    <Modal open={!!preview} onClose={() => setPreview((old) => { if (old) URL.revokeObjectURL(old.url); return null })} contentClassName="max-w-5xl h-[92vh] flex flex-col">
      {preview && <div className="flex h-full min-h-0 flex-col"><div className="flex items-center justify-between gap-3 border-b p-4"><div><div className="font-semibold">พรีวิวสลิปเงินเดือน — {preview.item.employee_code}</div><div className="text-sm text-gray-500">{preview.item.employee_name} · {monthLabel(month)}</div></div><div className="flex items-center gap-2">{!locked && !preview.item.reviewed_at && <button type="button" onClick={markReviewed} disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">ตรวจสอบแล้ว</button>}<button type="button" onClick={() => downloadSlip(preview.item)} className="rounded-lg bg-blue-50 px-4 py-2 text-blue-700">ดาวน์โหลด</button><button type="button" aria-label="ปิดพรีวิวสลิปเงินเดือน" title="ปิด" onClick={() => setPreview((old) => { if (old) URL.revokeObjectURL(old.url); return null })} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-600 text-white hover:bg-red-700"><svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg></button></div></div><iframe title={`สลิป ${preview.item.employee_code}`} src={preview.url} className="min-h-0 flex-1 w-full" /></div>}
    </Modal>
    </>}
  </div>
}
