import { useCallback, useEffect, useMemo, useState } from 'react'
import { pdf } from '@react-pdf/renderer'
import * as XLSX from 'xlsx'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  calculateEmployeeEwf,
  fetchDailyWageSummaries,
  fetchHRCompanies,
  fetchPayrollEmployees,
  fetchPayrollHistory,
  fetchPayrollOvertime,
  fetchPayrollRun,
  savePayrollRun,
  type DailyWageDetail,
  type PayrollItem,
  type PayrollRun,
} from '../../lib/payrollApi'
import type { HRCompany, HREmployee } from '../../types'
import Modal from '../ui/Modal'
import PayrollSlipPDF, { type PayrollYtd } from './pdf/PayrollSlipPDF'

const currentMonth = () => new Date().toISOString().slice(0, 7)
const fmt = (value: number) => Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const monthLabel = (month: string) => new Date(`${month}-01T00:00:00`).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })
const employeeName = (employee: HREmployee) => `${employee.prefix || ''}${employee.first_name} ${employee.last_name}`.replace(/\s+/g, ' ').trim()
const sortDailyPayrollItems = (rows: PayrollItem[]) => [...rows].sort((a, b) =>
  a.employee_code.localeCompare(b.employee_code, 'en', { numeric: true, sensitivity: 'base' }))
const calc = (item: PayrollItem) => {
  const gross = Number(item.base_salary) + Number(item.overtime_pay) + Number(item.other_income)
  const deduction = Number(item.ewf) + Number(item.other_deduction)
  return { gross, deduction, net: gross - deduction }
}
const emptyYtd: PayrollYtd = { income: 0, personalTax: 0, socialSecurity: 0, ewf: 0, studentLoan: 0, companyLoan: 0, accumulatedSavings: 0, companyLoanBalance: 0, companyLoanInstallments: 0 }
const detailLabel: Record<DailyWageDetail['status'], string> = {
  worked_full: 'ทำงานเต็มวัน', worked_half: 'ทำงานครึ่งวัน', paid_holiday: 'วันหยุดได้รับค่าจ้าง',
  unpaid_leave: 'ลาไม่รับค่าจ้าง', absent: 'ไม่ได้มาทำงาน', unresolved: 'รอตรวจสอบ',
}

export default function DailyPayrollSection() {
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
  const [search, setSearch] = useState('')
  const [detailItem, setDetailItem] = useState<PayrollItem | null>(null)
  const [preview, setPreview] = useState<{ item: PayrollItem; url: string } | null>(null)
  const company = companies.find((row) => row.id === companyId)
  const locked = run?.status === 'confirmed'

  useEffect(() => {
    fetchHRCompanies().then((rows) => {
      setCompanies(rows)
      setCompanyId((value) => value || rows[0]?.id || '')
    }).catch((error) => setMessage(error.message))
  }, [])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true); setMessage('')
    try {
      const employees = (await fetchPayrollEmployees(companyId)).filter((employee) => employee.contract_type === 'daily')
      const [savedRun, historyRows, wageByEmployee, overtimeByEmployee] = await Promise.all([
        fetchPayrollRun(month, companyId, 'daily'),
        fetchPayrollHistory(companyId, 'daily'),
        fetchDailyWageSummaries(month, employees),
        fetchPayrollOvertime(month, employees),
      ])
      setRun(savedRun); setHistory(historyRows)
      setPaymentDate(savedRun?.payment_date || `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()}`)
      if (savedRun?.status === 'confirmed' && savedRun.items?.length) {
        setItems(sortDailyPayrollItems(savedRun.items.map((item) => ({ ...item, daily_wage_details: item.daily_wage_details || [] }))))
        return
      }
      const savedByEmployee = new Map((savedRun?.items || []).map((item) => [item.employee_id, item]))
      const nextItems = employees.map((employee) => {
        const saved = savedByEmployee.get(employee.id)
        const wage = wageByEmployee[employee.id]
        const overtime = overtimeByEmployee[employee.id] || { normalHours: 0, holidayHours: 0, overtimePay: 0 }
        // Use the same company-level EWF switch as permanent payroll. Once enabled,
        // calculate 0.25% from the regular wage actually payable in this period.
        const ewf = calculateEmployeeEwf(
          employee.employee_code,
          wage?.regularPay || 0,
          company?.ewf_enabled !== false,
        )
        const changed = !!saved && (
          Number(saved.base_salary) !== (wage?.regularPay || 0)
          || Number(saved.overtime_pay) !== overtime.overtimePay
          || Number(saved.ewf) !== ewf
          || Number(saved.payable_days || 0) !== (wage?.payableDays || 0)
        )
        return {
          ...saved,
          employee_id: employee.id,
          employee_code: employee.employee_code,
          employee_name: employeeName(employee),
          employee_nickname: employee.nickname || null,
          department_position: [employee.department?.name, employee.position?.name].filter(Boolean).join(' / '),
          pay_type: 'daily' as const,
          daily_rate: wage?.dailyRate || Number(employee.salary) || 0,
          full_days: wage?.fullDays || 0,
          half_days: wage?.halfDays || 0,
          paid_holiday_days: wage?.paidHolidayDays || 0,
          unpaid_leave_days: wage?.unpaidLeaveDays || 0,
          payable_days: wage?.payableDays || 0,
          unresolved_attendance_days: wage?.unresolvedDays || 0,
          daily_wage_details: wage?.details || [],
          base_salary: wage?.regularPay || 0,
          position_allowance: 0,
          ot_normal_hours: overtime.normalHours,
          ot_holiday_hours: overtime.holidayHours,
          overtime_pay: overtime.overtimePay,
          personal_tax: 0,
          social_security: 0,
          ewf,
          savings: 0,
          student_loan: 0,
          company_loan: 0,
          leave_deduction: 0,
          other_income: Number(saved?.other_income) || 0,
          other_deduction: Number(saved?.other_deduction) || 0,
          income_opening_balance: Number(employee.income_opening_balance) || 0,
          personal_tax_opening_balance: 0,
          social_security_opening_balance: 0,
          ewf_opening_balance: Number(employee.ewf_opening_balance) || 0,
          student_loan_opening_balance: 0,
          savings_opening_balance: 0,
          company_loan_opening_balance: 0,
          company_loan_opening_installments: 0,
          reviewed_at: changed ? null : saved?.reviewed_at || null,
          reviewed_by: changed ? null : saved?.reviewed_by || null,
        } satisfies PayrollItem
      })
      setItems(sortDailyPayrollItems(nextItems))
      if (!employees.length) setMessage('ไม่พบพนักงานสัญญาจ้างรายวันในบริษัทนี้')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'โหลดข้อมูลค่าจ้างรายวันไม่สำเร็จ')
    } finally { setLoading(false) }
  }, [company?.ewf_enabled, companyId, month])
  useEffect(() => { void load() }, [load])

  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('th-TH')
    return query ? items.filter((item) => `${item.employee_code} ${item.employee_name} ${item.employee_nickname || ''}`.toLocaleLowerCase('th-TH').includes(query)) : items
  }, [items, search])
  const totals = useMemo(() => items.reduce((sum, item) => {
    const value = calc(item)
    return { wage: sum.wage + Number(item.base_salary), overtime: sum.overtime + Number(item.overtime_pay), ewf: sum.ewf + Number(item.ewf), net: sum.net + value.net }
  }, { wage: 0, overtime: 0, ewf: 0, net: 0 }), [items])

  const update = (employeeId: string, key: 'other_income' | 'other_deduction', value: number) => setItems((rows) => rows.map((item) => item.employee_id === employeeId ? { ...item, [key]: value, reviewed_at: null, reviewed_by: null } : item))
  const save = async (confirm: boolean) => {
    if (!company) return
    const unresolved = items.reduce((sum, item) => sum + Number(item.unresolved_attendance_days || 0), 0)
    if (confirm && unresolved > 0) { setMessage(`ยังมีข้อมูลเวลาเข้า–ออกที่ต้องตรวจสอบ ${unresolved} วัน`); return }
    if (confirm && items.some((item) => !item.reviewed_at)) { setMessage('กรุณาตรวจสอบรายการพนักงานให้ครบก่อนยืนยันยอด'); return }
    if (confirm && !window.confirm(`ยืนยันค่าจ้างรายวัน ${monthLabel(month)} ของ ${company.name_th} หรือไม่?`)) return
    setSaving(true)
    try {
      const saved = await savePayrollRun({ month, company, paymentDate, items, confirm, payrollType: 'daily', userId: user?.id })
      setRun(saved); setItems(sortDailyPayrollItems(saved.items || items)); setHistory(await fetchPayrollHistory(companyId, 'daily'))
      setMessage(confirm ? 'ยืนยันค่าจ้างรายวันเรียบร้อย' : 'บันทึกร่างค่าจ้างรายวันเรียบร้อย')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'บันทึกค่าจ้างรายวันไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  const createSlipBlob = async (item: PayrollItem) => {
    if (!company) return
    const value = calc(item)
    return pdf(<PayrollSlipPDF company={(item.company_snapshot as HRCompany) || company} item={{ ...item, gross_income: value.gross, total_deduction: value.deduction, net_pay: value.net }} monthLabel={monthLabel(month)} paymentDate={paymentDate ? new Date(`${paymentDate}T00:00:00`).toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' }) : '-'} ytd={emptyYtd} />).toBlob()
  }
  const downloadSlip = async (item: PayrollItem) => {
    const blob = await createSlipBlob(item)
    if (!blob) return
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `สลิปค่าจ้าง_${item.employee_code}_${month}.pdf`; anchor.click(); URL.revokeObjectURL(url)
  }
  const previewSlip = async (item: PayrollItem) => {
    const blob = await createSlipBlob(item)
    if (!blob) return
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old.url)
      return { item, url: URL.createObjectURL(blob) }
    })
  }
  const closePreview = () => setPreview((old) => {
    if (old) URL.revokeObjectURL(old.url)
    return null
  })
  const setReviewed = async (reviewed: boolean) => {
    if (!preview || !company || locked) return
    const nextItems = items.map((item) => item.employee_id === preview.item.employee_id
      ? { ...item, reviewed_at: reviewed ? new Date().toISOString() : null, reviewed_by: reviewed ? user?.id || null : null }
      : item)
    setSaving(true)
    try {
      const saved = await savePayrollRun({ month, company, paymentDate, items: nextItems, confirm: false, payrollType: 'daily', userId: user?.id })
      setRun(saved); setItems(sortDailyPayrollItems(saved.items || nextItems)); closePreview()
      setHistory(await fetchPayrollHistory(companyId, 'daily'))
      setMessage(reviewed ? `ตรวจสอบสลิป ${preview.item.employee_code} แล้ว` : `ยกเลิกการตรวจสอบสลิป ${preview.item.employee_code} แล้ว`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'บันทึกสถานะการตรวจสอบไม่สำเร็จ') }
    finally { setSaving(false) }
  }
  const exportExcel = () => {
    const rows = items.map((item) => ({
      'รหัสพนักงาน': item.employee_code, 'ชื่อ-สกุล': item.employee_name, 'ค่าแรง/วัน': item.daily_rate,
      'วันเต็ม': item.full_days, 'ครึ่งวัน': item.half_days, 'วันหยุดจ่าย': item.paid_holiday_days,
      'วันลาไม่จ่าย': item.unpaid_leave_days, 'จำนวนวันจ่าย': item.payable_days, 'ค่าจ้าง': item.base_salary,
      'OT ปกติ (ชม.)': item.ot_normal_hours, 'OT วันหยุด (ชม.)': item.ot_holiday_hours, 'เงิน OT': item.overtime_pay,
      'เงินกองทุนสงเคราะห์ลูกจ้าง': item.ewf, 'รายได้อื่น': item.other_income, 'หักอื่น': item.other_deduction, 'สุทธิ': calc(item).net,
    }))
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'ค่าจ้างรายวัน'); XLSX.writeFile(book, `รายงานค่าจ้างรายวัน_${company?.company_key || 'company'}_${month}.xlsx`)
  }

  return <div className="space-y-5">
    <div className="rounded-xl border bg-white p-4 flex flex-wrap gap-3 items-end">
      <label className="text-sm">บริษัท<select value={companyId} onChange={(event) => setCompanyId(event.target.value)} className="block mt-1 rounded-lg border px-3 py-2 min-w-72">{companies.map((row) => <option key={row.id} value={row.id}>{row.name_th}</option>)}</select></label>
      <label className="text-sm">เดือน<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="block mt-1 rounded-lg border px-3 py-2" /></label>
      <label className="text-sm">วันที่จ่าย<input type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} disabled={locked} className="block mt-1 rounded-lg border px-3 py-2 disabled:bg-gray-100" /></label>
      <label className="text-sm flex-1 min-w-56">ค้นหา<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} className="block mt-1 w-full rounded-lg border px-3 py-2" placeholder="ชื่อ ชื่อเล่น หรือรหัสพนักงาน" /></label>
      <div className="ml-auto flex gap-2"><button onClick={exportExcel} disabled={!items.length} className="rounded-lg border border-emerald-600 px-4 py-2 text-emerald-700">ดาวน์โหลด Excel</button>{!locked && <><button onClick={() => save(false)} disabled={saving || !items.length} className="rounded-lg border px-4 py-2">บันทึกร่าง</button><button onClick={() => save(true)} disabled={saving || !items.length} className="rounded-lg bg-emerald-600 px-4 py-2 text-white">ยืนยันยอด</button></>}</div>
    </div>
    {message && <div className="rounded-lg bg-blue-50 px-4 py-3 text-blue-700">{message}</div>}
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{[['ค่าจ้าง', totals.wage], ['เงิน OT', totals.overtime], ['เงินกองทุนสงเคราะห์ลูกจ้าง', totals.ewf], ['ยอดสุทธิ', totals.net]].map(([label, value]) => <div key={label} className="rounded-xl border bg-white p-4"><div className="text-xs text-gray-500">{label}</div><div className="mt-1 text-xl font-bold text-emerald-700">{fmt(Number(value))}</div></div>)}</div>
    <div className="rounded-xl border bg-white overflow-x-auto">{loading ? <div className="p-12 text-center">กำลังโหลด...</div> : <table className="w-full text-sm whitespace-nowrap"><thead className="bg-gray-50"><tr>{['พนักงาน','ค่าแรง/วัน','วันจ่าย','ค่าจ้าง','OT','เงินกองทุนสงเคราะห์ลูกจ้าง','รายได้อื่น','หักอื่น','สุทธิ','สลิป'].map((heading) => <th key={heading} className="p-3 text-right first:text-left">{heading}</th>)}</tr></thead><tbody>{visibleItems.map((item) => <tr key={item.employee_id} className="border-t"><td className="p-3"><div className="flex items-center gap-2"><b>{item.employee_code}</b>{locked ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">ยืนยันยอดแล้ว</span> : item.reviewed_at ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">ตรวจสอบแล้ว</span> : null}</div><div>{item.employee_name}</div><div className="text-xs text-gray-500">{item.department_position}</div>{Number(item.unresolved_attendance_days || 0) > 0 && <div className="text-xs font-medium text-red-600">รอตรวจสอบ {item.unresolved_attendance_days} วัน</div>}</td><td className="p-3 text-right">{fmt(Number(item.daily_rate))}</td><td className="p-3 text-right"><button className="text-blue-700" onClick={() => setDetailItem(item)}>{fmt(Number(item.payable_days))} วัน</button><div className="text-xs text-gray-500">เต็ม {item.full_days} · ครึ่ง {item.half_days} · หยุด {item.paid_holiday_days}</div></td><td className="p-3 text-right">{fmt(item.base_salary)}</td><td className="p-3 text-right">{fmt(item.overtime_pay)}<div className="text-xs text-violet-600">ปกติ {fmt(item.ot_normal_hours)} · หยุด {fmt(item.ot_holiday_hours)} ชม.</div></td><td className="p-3 text-right">{fmt(item.ewf)}<div className="text-xs text-teal-600">0.25% ของค่าจ้าง</div></td>{(['other_income','other_deduction'] as const).map((key) => <td key={key} className="p-2 text-right">{locked ? fmt(item[key]) : <input type="text" inputMode="decimal" value={item[key]} onChange={(event) => update(item.employee_id, key, Number(event.target.value.replace(/,/g, '')) || 0)} className="w-24 rounded border px-2 py-1 text-right" />}</td>)}<td className="p-3 text-right font-bold text-emerald-700">{fmt(calc(item).net)}</td><td className="p-3 text-right"><div className="flex justify-end gap-2"><button onClick={() => previewSlip(item)} className="rounded-lg bg-gray-100 px-3 py-2 text-gray-700">ดู</button><button onClick={() => downloadSlip(item)} className="rounded-lg bg-blue-50 px-3 py-2 text-blue-700">ดาวน์โหลด</button></div></td></tr>)}{!visibleItems.length && <tr><td colSpan={10} className="p-10 text-center text-gray-500">ไม่พบพนักงานรายวัน</td></tr>}</tbody></table>}</div>
    <Modal open={!!detailItem} onClose={() => setDetailItem(null)} contentClassName="max-w-5xl max-h-[90vh] overflow-auto rounded-xl"><div className="p-5"><h3 className="text-lg font-semibold">รายละเอียดค่าจ้างรายวัน — {detailItem?.employee_name}</h3><table className="mt-4 w-full text-sm"><thead><tr className="bg-gray-50"><th className="p-2 text-left">วันที่</th><th className="p-2 text-left">สถานะ</th><th className="p-2 text-left">หลักฐาน</th><th className="p-2 text-right">วันจ่าย</th><th className="p-2 text-right">จำนวนเงิน</th></tr></thead><tbody>{(detailItem?.daily_wage_details || []).map((detail) => <tr key={detail.workDate} className={`border-t ${detail.status === 'unresolved' ? 'border-l-4 border-l-amber-500 bg-amber-50 text-amber-950' : ''}`}><td className="p-2">{new Date(`${detail.workDate}T00:00:00`).toLocaleDateString('th-TH')}</td><td className={`p-2 ${detail.status === 'unresolved' ? 'font-bold text-amber-800' : ''}`}>{detailLabel[detail.status]}</td><td className="p-2">{detail.note}{(detail.clockIn || detail.clockOut) && <div className={`text-xs ${detail.status === 'unresolved' ? 'font-medium text-amber-700' : 'text-gray-500'}`}>เข้า {detail.clockIn ? new Date(detail.clockIn).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '-'} · ออก {detail.clockOut ? new Date(detail.clockOut).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '-'}</div>}</td><td className="p-2 text-right">{fmt(detail.payableDay)}</td><td className="p-2 text-right">{fmt(detail.amount)}</td></tr>)}</tbody></table></div></Modal>
    <Modal open={!!preview} onClose={closePreview} contentClassName="max-w-none h-full flex flex-col rounded-xl">
      {preview && <div className="flex h-full min-h-0 flex-col"><div className="flex items-center justify-between gap-3 border-b p-4"><div><div className="font-semibold">พรีวิวสลิปค่าจ้าง — {preview.item.employee_code}</div><div className="text-sm text-gray-500">{preview.item.employee_name} · {monthLabel(month)}</div></div><div className="flex items-center gap-2">{!locked && !preview.item.reviewed_at && <button type="button" onClick={() => setReviewed(true)} disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">ตรวจสอบแล้ว</button>}{!locked && preview.item.reviewed_at && <button type="button" onClick={() => setReviewed(false)} disabled={saving} className="rounded-lg border border-amber-500 bg-amber-50 px-4 py-2 text-amber-700 disabled:opacity-50">ยกเลิกการตรวจสอบ</button>}<button type="button" onClick={() => downloadSlip(preview.item)} className="rounded-lg bg-blue-50 px-4 py-2 text-blue-700">ดาวน์โหลด</button><button type="button" aria-label="ปิดพรีวิวสลิปค่าจ้าง" title="ปิด" onClick={closePreview} className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-600 text-white"><svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg></button></div></div><iframe title={`สลิป ${preview.item.employee_code}`} src={`${preview.url}#zoom=150`} className="min-h-0 flex-1 w-full" /></div>}
    </Modal>
    {history.length > 0 && <div className="text-xs text-gray-500">มีรายงานค่าจ้างรายวันที่ยืนยันแล้ว {history.length} รอบ</div>}
  </div>
}
