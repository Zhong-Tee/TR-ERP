import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pdf } from '@react-pdf/renderer'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import { useAuthContext } from '../../contexts/AuthContext'
import type { HRCompany, HREmployee } from '../../types'
import {
  fetchMonthlyWageSummaries, fetchPayrollLeaveDeductions, fetchHRCompanies, fetchPayrollEmployees, fetchPayrollHistory,
  fetchPayrollRun, fetchSocialSecuritySettings, fetchPayrollOvertime, isEmployeeSocialSecurityEnabled, calculateEmployeeSocialSecurity, fetchPayrollRevisions, reopenMonthlyPayroll, calculateCappedSavings, calculateEmployeeEwf, savePayrollRun,
  type PayrollItem, type PayrollRun, type PayrollRevision,
} from '../../lib/payrollApi'
import PayrollSlipPDF, { type PayrollYtd } from './pdf/PayrollSlipPDF'
import PayrollPeriodWorkspace from './PayrollPeriodWorkspace'
import PayrollPaymentsPanel from './PayrollPaymentsPanel'
import DailyPayrollSection from './DailyPayrollSection'
import Modal from '../ui/Modal'
import { appendMissingMonthlyEmployees, monthlyPayrollGroup } from '../../lib/payrollGroups'
import { resolvePayrollLeaveDeduction } from '../../lib/payrollLeaveDeduction'

type PayrollView = 'scheduled' | 'payroll' | 'uninsured' | 'daily' | 'history'

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
  const gross = item.base_salary + item.position_allowance + item.overtime_pay + item.other_income
  const deduction = item.personal_tax + item.social_security + item.ewf + item.savings + item.student_loan + item.company_loan + item.leave_deduction + item.other_deduction
  return { gross, deduction, net: gross - deduction }
}

const employeeOpeningBalances = (employee: HREmployee) => ({
  income_opening_balance: Number(employee.income_opening_balance) || 0,
  personal_tax_opening_balance: Number(employee.personal_tax_opening_balance) || 0,
  social_security_opening_balance: Number(employee.social_security_opening_balance) || 0,
  ewf_opening_balance: Number(employee.ewf_opening_balance) || 0,
  student_loan_opening_balance: Number(employee.student_loan_opening_balance) || 0,
  savings_opening_balance: Number(employee.savings_opening_balance) || 0,
  company_loan_opening_balance: Number(employee.company_loan_opening_balance) || 0,
  company_loan_opening_installments: Number(employee.company_loan_opening_installments) || 0,
})

const savingsPaidBeforeMonth = (history: PayrollRun[], employeeId: string, targetMonth: string) => history
  .filter((payrollRun) => payrollRun.payroll_month.slice(0, 7) < targetMonth)
  .flatMap((payrollRun) => payrollRun.items || [])
  .filter((item) => item.employee_id === employeeId)
  .reduce((sum, item) => sum + Number(item.savings || 0), 0)

const employeeSavingsForMonth = (employee: HREmployee, history: PayrollRun[], targetMonth: string) =>
  calculateCappedSavings({
    monthlySavings: Number(employee.monthly_savings) || 0,
    openingBalance: Number(employee.savings_opening_balance) || 0,
    priorSavings: savingsPaidBeforeMonth(history, employee.id, targetMonth),
    maximumBalance: employee.savings_maximum,
  })

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
  const [activeView, setActiveView] = useState<PayrollView>('scheduled')
  const [employeeSearch, setEmployeeSearch] = useState('')
  const [historySearch, setHistorySearch] = useState('')
  const [historyDateFrom, setHistoryDateFrom] = useState('')
  const [historyDateTo, setHistoryDateTo] = useState('')
  const [preview, setPreview] = useState<{ item: PayrollItem; url: string } | null>(null)
  const [zipLoading, setZipLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState<'confirm' | 'cancel-review' | 'reload' | 'switch' | null>(null)
  const [dirty, setDirty] = useState(false)
  const [pendingView, setPendingView] = useState<PayrollView | null>(null)
  const [wageDetailItem, setWageDetailItem] = useState<PayrollItem | null>(null)
  const [paidElsewhereCodes, setPaidElsewhereCodes] = useState<string[]>([])
  const [revisionOpen, setRevisionOpen] = useState(false)
  const [revisionReason, setRevisionReason] = useState('')
  const [revisions, setRevisions] = useState<PayrollRevision[]>([])
  const enrolledView = activeView !== 'uninsured'
  const groupLabel = enrolledView ? 'เข้า สปส.' : 'ไม่เข้า สปส.'
  const payrollType = enrolledView ? 'permanent' : 'monthly_uninsured'
  const loadVersion = useRef(0)
  const groupItems = useMemo(() => monthlyPayrollGroup(items, enrolledView), [items, enrolledView])
  const company = companies.find((c) => c.id === companyId)
  const ewfEnabled = company?.ewf_enabled !== false
  const locked = run?.status === 'confirmed'

  useEffect(() => {
    fetchHRCompanies().then((rows) => { setCompanies(rows); setCompanyId((id) => id || rows[0]?.id || '') }).catch((e) => setMessage(e.message))
  }, [])

  const load = useCallback(async () => {
    if (!companyId) return
    const version = ++loadVersion.current
    setLoading(true); setMessage(''); setItems([]); setRun(null); setDirty(false); setPaidElsewhereCodes([])
    try {
      const payrollEmployees = await fetchPayrollEmployees(companyId)
      const monthEnd = `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()}`
      const [savedRun, otherRun, historyRows, socialSecuritySettings, monthlyWages] = await Promise.all([
        fetchPayrollRun(month, companyId, payrollType), fetchPayrollRun(month, companyId, enrolledView ? 'monthly_uninsured' : 'permanent'), fetchPayrollHistory(companyId), fetchSocialSecuritySettings(), fetchMonthlyWageSummaries(month, payrollEmployees),
      ])
      const paidElsewhere = new Set(otherRun?.status === 'confirmed' ? (otherRun.items || []).map(item => item.employee_id) : [])
      const employees = payrollEmployees.filter(employee => (monthlyWages[employee.id]?.calendarDays || 0) > 0
        && isEmployeeSocialSecurityEnabled(employee) === enrolledView && !paidElsewhere.has(employee.id)
        && (!employee.hire_date || employee.hire_date <= monthEnd) && (!employee.contract_end_date || employee.contract_end_date >= `${month}-01`))
      const [leaveMap, overtimeByEmployee, revisionRows] = await Promise.all([
        fetchPayrollLeaveDeductions(month, employees), fetchPayrollOvertime(month, employees, 'permanent'), savedRun ? fetchPayrollRevisions(savedRun.id) : Promise.resolve([]),
      ])
      if (version !== loadVersion.current) return
      setPaidElsewhereCodes(payrollEmployees.filter(employee => employee.contract_type !== 'daily' && isEmployeeSocialSecurityEnabled(employee) === enrolledView && paidElsewhere.has(employee.id)).map(employee => employee.employee_code))
      setHistory(historyRows)
      setRun(savedRun)
      setRevisions(revisionRows)
      setPaymentDate(savedRun?.payment_date || `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()}`)
      const newEmployeeItem = (employee: HREmployee): PayrollItem => ({
        employee_id: employee.id, employee_code: employee.employee_code,
        employee_name: employeeFullName(employee),
        employee_nickname: employee.nickname || null,
        department_position: [employee.department?.name, employee.position?.name].filter(Boolean).join(' / '),
        pay_type: 'permanent' as const,
        social_security_enabled: isEmployeeSocialSecurityEnabled(employee),
        monthly_rate: monthlyWages[employee.id]?.monthlyRate || 0, monthly_payable_days: monthlyWages[employee.id]?.payableDays || 0, monthly_wage_details: monthlyWages[employee.id]?.details || [],
        base_salary: monthlyWages[employee.id]?.baseSalary || 0, position_allowance: monthlyWages[employee.id]?.positionAllowance || 0,
        ot_normal_hours: overtimeByEmployee[employee.id]?.normalHours || 0,
        ot_holiday_hours: overtimeByEmployee[employee.id]?.holidayHours || 0,
        overtime_pay: overtimeByEmployee[employee.id]?.overtimePay || 0,
        personal_tax: Number(employee.monthly_personal_tax) || 0,
        social_security: calculateEmployeeSocialSecurity(employee, monthlyWages[employee.id]?.baseSalary || 0, socialSecuritySettings),
        ewf: calculateEmployeeEwf(employee.employee_code, (monthlyWages[employee.id]?.baseSalary || 0) + (monthlyWages[employee.id]?.positionAllowance || 0), ewfEnabled),
        savings: employeeSavingsForMonth(employee, historyRows, month),
        student_loan: Number(employee.monthly_student_loan) || 0, company_loan: Number(employee.monthly_company_loan) || 0,
        leave_deduction: leaveMap[employee.id] || 0, other_income: 0, other_deduction: 0,
        ...employeeOpeningBalances(employee),
      })
      const transferItems = savedRun?.status !== 'confirmed' && otherRun?.status === 'draft'
        ? (otherRun.items || []).filter(item => employees.some(employee => employee.id === item.employee_id) && !(savedRun?.items || []).some(saved => saved.employee_id === item.employee_id)) : []
      const sourceItems = [...(savedRun?.items || []), ...transferItems]
      if (sourceItems.length) {
        const employeesById = new Map(employees.map((employee) => [employee.id, employee]))
        const refreshedItems: PayrollItem[] = sourceItems
          .filter(item => item.pay_type !== 'daily' && (savedRun?.status === 'confirmed' || (!payrollEmployees.some(employee => employee.id === item.employee_id) || employees.some(employee => employee.id === item.employee_id))))
          .map((item) => {
          const employee = employeesById.get(item.employee_id)
          const savedBaseSalary = Number(item.base_salary)
          const savedPositionAllowance = Number(item.position_allowance)
          const wage = employee ? monthlyWages[employee.id] : undefined
          // Draft payroll must follow the employee's latest salary settings.
          // Confirmed runs remain immutable snapshots for payroll history.
          const baseSalary = savedRun?.status === 'confirmed' || !employee
            ? savedBaseSalary
            : wage?.baseSalary || 0
          const positionAllowance = savedRun?.status === 'confirmed' || !employee
            ? savedPositionAllowance
            : wage?.positionAllowance || 0
          const savedOpeningBalances = {
            income_opening_balance: Number(item.income_opening_balance),
            personal_tax_opening_balance: Number(item.personal_tax_opening_balance),
            social_security_opening_balance: Number(item.social_security_opening_balance),
            ewf_opening_balance: Number(item.ewf_opening_balance),
            student_loan_opening_balance: Number(item.student_loan_opening_balance),
            savings_opening_balance: Number(item.savings_opening_balance),
            company_loan_opening_balance: Number(item.company_loan_opening_balance),
            company_loan_opening_installments: Number(item.company_loan_opening_installments),
          }
          const openingBalances = savedRun?.status === 'confirmed' || !employee
            ? savedOpeningBalances
            : employeeOpeningBalances(employee)
          const openingBalancesChanged = savedRun?.status !== 'confirmed' && employee
            ? Object.entries(openingBalances).some(([key, value]) => value !== savedOpeningBalances[key as keyof typeof savedOpeningBalances])
            : false
          const savings = savedRun?.status === 'confirmed' || !employee
            ? Number(item.savings)
            : employeeSavingsForMonth(employee, historyRows, month)
          const ewf = savedRun?.status === 'confirmed'
            ? Number(item.ewf)
            : calculateEmployeeEwf(item.employee_code, baseSalary + positionAllowance, ewfEnabled)
          const overtime = savedRun?.status === 'confirmed' || !employee
            ? {
              normalHours: Number(item.ot_normal_hours) || 0,
              holidayHours: Number(item.ot_holiday_hours) || 0,
              overtimePay: Number(item.overtime_pay) || 0,
            }
            : overtimeByEmployee[item.employee_id] || { normalHours: 0, holidayHours: 0, overtimePay: 0 }
          const leaveDeduction = resolvePayrollLeaveDeduction(savedRun?.status === 'confirmed' ? 'confirmed' : 'draft', item.leave_deduction, leaveMap[item.employee_id])
          const enrollment = savedRun?.status === 'confirmed' || !employee ? item.social_security_enabled : isEmployeeSocialSecurityEnabled(employee)
          const socialSecurity = savedRun?.status === 'confirmed' || !employee
            ? Number(item.social_security)
            : calculateEmployeeSocialSecurity(employee, baseSalary, socialSecuritySettings)
          const monthlyMetadata = savedRun?.status === 'confirmed' || !wage
            ? { monthly_rate: item.monthly_rate, monthly_payable_days: item.monthly_payable_days, monthly_wage_details: item.monthly_wage_details }
            : { monthly_rate: wage.monthlyRate, monthly_payable_days: wage.payableDays, monthly_wage_details: wage.details }
          const payrollInputsChanged = openingBalancesChanged || leaveDeduction.changed
            || (savedRun?.status !== 'confirmed' && (
              JSON.stringify(monthlyMetadata.monthly_wage_details) !== JSON.stringify(item.monthly_wage_details)
              || baseSalary !== savedBaseSalary
              || positionAllowance !== savedPositionAllowance
              || enrollment !== item.social_security_enabled
              || socialSecurity !== Number(item.social_security)
              || savings !== Number(item.savings)
              || ewf !== Number(item.ewf)
              || overtime.normalHours !== Number(item.ot_normal_hours || 0)
              || overtime.holidayHours !== Number(item.ot_holiday_hours || 0)
              || overtime.overtimePay !== Number(item.overtime_pay || 0)
            ))
          return { ...item, ...monthlyMetadata, employee_name: employee ? employeeFullName(employee) : item.employee_name, employee_nickname: item.employee_nickname || employee?.nickname || null, base_salary: baseSalary, position_allowance: positionAllowance, ot_normal_hours: overtime.normalHours, ot_holiday_hours: overtime.holidayHours, overtime_pay: overtime.overtimePay, personal_tax: Number(item.personal_tax), social_security_enabled: enrollment, social_security: socialSecurity, ewf, savings, student_loan: Number(item.student_loan), company_loan: Number(item.company_loan), leave_deduction: leaveDeduction.amount, other_income: Number(item.other_income), other_deduction: Number(item.other_deduction), ...openingBalances, reviewed_at: payrollInputsChanged ? null : item.reviewed_at, reviewed_by: payrollInputsChanged ? null : item.reviewed_by }
          })
        if (savedRun?.status !== 'confirmed') {
          setItems(sortPayrollItems(appendMissingMonthlyEmployees(refreshedItems, employees, newEmployeeItem)))
        } else {
          setItems(sortPayrollItems(refreshedItems))
        }
      }
      else if (!savedRun || savedRun.status === 'draft') setItems(sortPayrollItems(employees.map(newEmployeeItem)))
      else {
        setItems([])
        setMessage(`ไม่พบข้อมูลเงินเดือนที่บันทึกไว้สำหรับ${monthLabel(month)}`)
      }
    } catch (e) { if (version === loadVersion.current) setMessage(e instanceof Error ? e.message : 'โหลดข้อมูลเงินเดือนไม่สำเร็จ') }
    finally { if (version === loadVersion.current) setLoading(false) }
  }, [companyId, ewfEnabled, month, payrollType, enrolledView])
  useEffect(() => { load() }, [load])

  const totals = useMemo(() => groupItems.reduce((sum, item) => { const c = calc(item); return { salary: sum.salary + c.gross, overtime: sum.overtime + item.overtime_pay, tax: sum.tax + item.personal_tax, social: sum.social + item.social_security, ewf: sum.ewf + item.ewf, savings: sum.savings + item.savings, student: sum.student + item.student_loan, companyLoan: sum.companyLoan + item.company_loan, leave: sum.leave + item.leave_deduction, net: sum.net + c.net } }, { salary: 0, overtime: 0, tax: 0, social: 0, ewf: 0, savings: 0, student: 0, companyLoan: 0, leave: 0, net: 0 }), [groupItems])
  const visibleItems = useMemo(() => {
    const query = employeeSearch.trim().toLocaleLowerCase('th-TH')
    if (!query) return groupItems
    return groupItems.filter((item) => [item.employee_code, item.employee_name, item.employee_nickname, item.department_position]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('th-TH')
      .includes(query))
  }, [employeeSearch, groupItems])

  const financialProgress = (item: PayrollItem, cutoffMonth = month, includeDraft = !locked) => {
    const confirmedRows = history
      .filter((h) => h.payroll_month.slice(0, 7) <= cutoffMonth)
      .flatMap((h) => h.items || [])
      .filter((row) => row.employee_id === item.employee_id)
    const rows = includeDraft ? [...confirmedRows.filter((row) => row.payroll_run_id !== run?.id), item] : confirmedRows
    const ewfPaid = rows.reduce((sum, row) => sum + Number(row.ewf || 0), 0)
    const savingsPaid = rows.reduce((sum, row) => sum + Number(row.savings || 0), 0)
    const loanPaid = rows.reduce((sum, row) => sum + Number(row.company_loan || 0), 0)
    const paidInstallments = rows.filter((row) => Number(row.company_loan || 0) > 0).length
    return {
      accumulatedEwf: Number(item.ewf_opening_balance || 0) + ewfPaid,
      accumulatedSavings: Number(item.savings_opening_balance || 0) + savingsPaid,
      companyLoanBalance: Math.max(0, Number(item.company_loan_opening_balance || 0) - loanPaid),
      companyLoanInstallments: Math.max(0, Number(item.company_loan_opening_installments || 0) - paidInstallments),
    }
  }

  const requestView = (next: PayrollView) => {
    if (saving || next === activeView) return
    if (dirty) { setPendingView(next); setPendingAction('switch'); return }
    setActiveView(next); setEmployeeSearch('')
  }
  const update = (employeeId: string, key: keyof PayrollItem, value: number) => {
    setDirty(true)
    setItems(rows => rows.map(row => row.employee_id === employeeId ? { ...row, [key]: value, reviewed_at: null, reviewed_by: null } : row))
  }
  const save = async (confirm: boolean, approved = false) => {
    if (!company || loading || saving) return
    if (confirm && items.some((item) => !item.reviewed_at)) {
      setMessage('กรุณาพรีวิวและกด “ตรวจสอบแล้ว” ให้ครบทุกคนก่อนยืนยันยอด')
      return
    }
    if (confirm && !approved) { setPendingAction('confirm'); return }
    setPendingAction(null)
    setSaving(true)
    try {
      if (confirm) {
        const employees = await fetchPayrollEmployees(companyId)
        const [currentLeave, settings, currentWages] = await Promise.all([fetchPayrollLeaveDeductions(month, employees), fetchSocialSecuritySettings(), fetchMonthlyWageSummaries(month, employees)])
        const employeesById = new Map(employees.map(employee => [employee.id, employee]))
        if (items.some(item => { const employee = employeesById.get(item.employee_id); return employee && isEmployeeSocialSecurityEnabled(employee) !== enrolledView })) {
          setMessage('มีพนักงานเปลี่ยนกลุ่ม สปส. กรุณากดโหลดข้อมูลใหม่ก่อนยืนยันกลุ่มนี้')
          return
        }
        let changed = false
        const refreshed = items.map((item) => {
          const deduction = resolvePayrollLeaveDeduction('draft', item.leave_deduction, currentLeave[item.employee_id])
          const employee = employeesById.get(item.employee_id)
          const enrollment = employee ? isEmployeeSocialSecurityEnabled(employee) : item.social_security_enabled
          const wage = employee ? currentWages[employee.id] : undefined
          if (wage && !wage.calendarDays) throw new Error('ช่วงค่าจ้างเปลี่ยนแล้ว กรุณาโหลดข้อมูลใหม่ก่อนยืนยัน')
          const baseSalary = wage?.baseSalary ?? item.base_salary
          const allowance = wage?.positionAllowance ?? item.position_allowance
          const metadata = wage ? { monthly_rate: wage.monthlyRate, monthly_payable_days: wage.payableDays, monthly_wage_details: wage.details } : {}
          const ewf = employee ? calculateEmployeeEwf(employee.employee_code, baseSalary + allowance, ewfEnabled) : item.ewf
          const social = employee ? calculateEmployeeSocialSecurity(employee, baseSalary, settings) : item.social_security
          if (!deduction.changed && enrollment === item.social_security_enabled && social === item.social_security && baseSalary === item.base_salary && allowance === item.position_allowance && ewf === item.ewf && (!wage || JSON.stringify(wage.details) === JSON.stringify(item.monthly_wage_details))) return item
          changed = true
          return { ...item, ...metadata, base_salary: baseSalary, position_allowance: allowance, ewf, social_security_enabled: enrollment, social_security: social, leave_deduction: deduction.amount, reviewed_at: null, reviewed_by: null }
        })
        if (changed) {
          setItems(refreshed)
          setMessage('ข้อมูลค่าจ้าง การลา หรือประกันสังคมเปลี่ยนแปลง อัปเดตแล้ว กรุณาตรวจสอบสลิปที่เปลี่ยนแปลงก่อนยืนยันกลุ่มนี้อีกครั้ง')
          return
        }
      }
      const saved = await savePayrollRun({ expectedVersion: run?.version || 0, month, company, paymentDate, items, confirm, payrollType, userId: user?.id })
      setDirty(false); setRun(saved); setItems(sortPayrollItems(saved.items || items))
      setMessage(confirm ? 'ยืนยันยอดเงินเดือนเรียบร้อย' : 'บันทึกร่างเรียบร้อย')
      setHistory(await fetchPayrollHistory(companyId))
    }
    catch (e) { setMessage(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  const openRevision = async () => {
    if (loading || saving) return
    if (!run || !revisionReason.trim()) { setMessage('กรุณาระบุเหตุผลปรับปรุงยอด'); return }
    setSaving(true)
    try {
      await reopenMonthlyPayroll(run.id, revisionReason.trim())
      setRevisionOpen(false); setRevisionReason('')
      await load()
      setMessage('เปิดปรับปรุงกลุ่มนี้แล้ว เก็บยอดเดิมไว้ในประวัติ กรุณาตรวจสลิปและยืนยันกลุ่มนี้ใหม่')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'เปิดปรับปรุงยอดไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  const ytdFor = (item: PayrollItem): PayrollYtd => {
    const year = month.slice(0, 4)
    const previous = history.filter((h) => h.payroll_month.startsWith(year) && h.payroll_month.slice(0, 7) <= month).flatMap((h) => h.items || []).filter((x) => x.employee_id === item.employee_id)
    const rows = run?.status === 'confirmed' ? previous : [...previous.filter((x) => x.payroll_run_id !== run?.id), item]
    const yearly = rows.reduce((sum, row) => { const c = calc(row); return { income: sum.income + c.gross, personalTax: sum.personalTax + Number(row.personal_tax), socialSecurity: sum.socialSecurity + Number(row.social_security), ewf: sum.ewf + Number(row.ewf), studentLoan: sum.studentLoan + Number(row.student_loan), companyLoan: sum.companyLoan + Number(row.company_loan) } }, { income: 0, personalTax: 0, socialSecurity: 0, ewf: 0, studentLoan: 0, companyLoan: 0 })
    return {
      ...yearly,
      income: Number(item.income_opening_balance || 0) + yearly.income,
      personalTax: Number(item.personal_tax_opening_balance || 0) + yearly.personalTax,
      socialSecurity: Number(item.social_security_opening_balance || 0) + yearly.socialSecurity,
      ewf: Number(item.ewf_opening_balance || 0) + yearly.ewf,
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

  const closePreview = () => setPreview((old) => {
    if (old) URL.revokeObjectURL(old.url)
    return null
  })

  const downloadAllSlipsZip = async () => {
    if (!company || !locked || !groupItems.length) return
    setZipLoading(true); setMessage('')
    try {
      const zip = new JSZip()
      for (const item of sortPayrollItems(groupItems)) {
        const blob = await createSlipBlob(item)
        if (blob) zip.file(slipFileName(item, month), blob)
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `สลิปเงินเดือน_${company.company_key}_${month}_${groupLabel}.zip`; a.click(); URL.revokeObjectURL(url)
      setMessage(`ดาวน์โหลดสลิปเงินเดือน ${groupItems.length} รายการเรียบร้อย`)
    } catch (e) { setMessage(e instanceof Error ? e.message : 'สร้างไฟล์ ZIP ไม่สำเร็จ') }
    finally { setZipLoading(false) }
  }

  const markReviewed = async () => {
    if (!preview || !company || !user?.id || locked) return
    const reviewedAt = new Date().toISOString()
    const nextItems = items.map((item) => item.employee_id === preview.item.employee_id ? { ...item, reviewed_at: reviewedAt, reviewed_by: user.id } : item)
    setSaving(true)
    try {
      const saved = await savePayrollRun({ expectedVersion: run?.version || 0, month, company, paymentDate, items: nextItems, confirm: false, payrollType, userId: user.id })
      setDirty(false); setRun(saved); setItems(sortPayrollItems(saved.items || nextItems)); closePreview()
      setHistory(await fetchPayrollHistory(companyId)); setMessage(`ตรวจสอบสลิป ${preview.item.employee_code} แล้ว`)
    } catch (e) { setMessage(e instanceof Error ? e.message : 'บันทึกผลตรวจสอบไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  const cancelReviewed = async (approved = false) => {
    if (!preview || !company || locked || !preview.item.reviewed_at) return
    if (!approved) { setPendingAction('cancel-review'); return }
    setPendingAction(null)
    const employeeCode = preview.item.employee_code
    const nextItems = items.map((item) => item.employee_id === preview.item.employee_id
      ? { ...item, reviewed_at: null, reviewed_by: null }
      : item)
    setSaving(true)
    try {
      const saved = await savePayrollRun({ expectedVersion: run?.version || 0, month, company, paymentDate, items: nextItems, confirm: false, payrollType, userId: user?.id })
      setDirty(false); setRun(saved); setItems(sortPayrollItems(saved.items || nextItems)); closePreview()
      setHistory(await fetchPayrollHistory(companyId)); setMessage(`ยกเลิกการตรวจสอบสลิป ${employeeCode} แล้ว`)
    } catch (e) { setMessage(e instanceof Error ? e.message : 'ยกเลิกการตรวจสอบไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  const exportExcel = (targetRun: PayrollRun | null = null) => {
    const exportItems = targetRun?.items || groupItems
    const exportCompany = targetRun?.company || company
    const exportMonth = targetRun?.payroll_month.slice(0, 7) || month
    const isDaily = targetRun?.payroll_type === 'daily'
    const rows = exportItems.map((item) => {
      const c = calc(item)
      if (isDaily) return { 'รหัสพนักงาน': item.employee_code, 'ชื่อ-สกุล': item.employee_name, 'แผนก/ตำแหน่ง': item.department_position || '', 'ค่าแรง/วัน': item.daily_rate, 'วันเต็ม': item.full_days, 'ครึ่งวัน': item.half_days, 'วันหยุดจ่าย': item.paid_holiday_days, 'วันลาไม่จ่าย': item.unpaid_leave_days, 'จำนวนวันจ่าย': item.payable_days, 'ค่าจ้าง': item.base_salary, 'OT วันทำงาน (ชม.)': item.ot_normal_hours, 'OT วันหยุด (ชม.)': item.ot_holiday_hours, 'เงิน OT': item.overtime_pay, 'เงินกองทุนสงเคราะห์ลูกจ้าง': item.ewf, 'รายได้อื่น': item.other_income, 'หักอื่น': item.other_deduction, 'เงินสุทธิ': c.net }
      const progress = financialProgress(item, exportMonth, targetRun ? false : !locked)
      return { 'รหัสพนักงาน': item.employee_code, 'ชื่อ-สกุล': item.employee_name, 'แผนก/ตำแหน่ง': item.department_position || '', 'ฐานเงินเดือนเต็ม': item.monthly_rate ?? '', 'วันคำนวณเงินเดือน': item.monthly_payable_days ?? '', 'เงินเดือน': item.base_salary, 'เงินพิเศษ': item.position_allowance, 'OT วันทำงาน (ชม.)': item.ot_normal_hours, 'OT วันหยุด (ชม.)': item.ot_holiday_hours, 'เงิน OT': item.overtime_pay, 'รายได้อื่น': item.other_income, 'รวมรายได้': c.gross, 'ภาษี': item.personal_tax, 'ประกันสังคม': item.social_security, 'เงินกองทุนสงเคราะห์ลูกจ้างเดือนนี้': item.ewf, 'เงินกองทุนสงเคราะห์ลูกจ้างสะสมรวม': progress.accumulatedEwf, 'เงินสะสมเดือนนี้': item.savings, 'เงินสะสมรวม': progress.accumulatedSavings, 'กยศ.': item.student_loan, 'เงินกู้บริษัทฯ เดือนนี้': item.company_loan, 'เงินกู้บริษัทฯ คงเหลือ': progress.companyLoanBalance, 'งวดคงเหลือ': progress.companyLoanInstallments, 'ลาเกินสิทธิ์': item.leave_deduction, 'หักอื่น': item.other_deduction, 'รวมหัก': c.deduction, 'เงินสุทธิ': c.net }
    })
    const ws = XLSX.utils.json_to_sheet(rows); ws['!cols'] = [12, 26, 24, ...Array(21).fill(14)].map((wch) => ({ wch }))
    const reportName = isDaily ? 'ค่าจ้างรายวัน' : 'เงินเดือน'
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, reportName); XLSX.writeFile(wb, `รายงาน${reportName}_${exportCompany?.company_key || 'company'}_${exportMonth}${targetRun ? (isDaily ? '' : targetRun.payroll_type === 'monthly_uninsured' ? '_ไม่เข้า สปส.' : '_เข้า สปส.') : `_${groupLabel}`}.xlsx`)
  }

  const cards = [['ยอดเงินเดือน', totals.salary, 'text-blue-700'], ['เงิน OT', totals.overtime, 'text-violet-700'], ['ภาษีส่วนบุคคล', totals.tax, 'text-amber-700'], ['ประกันสังคม', totals.social, 'text-purple-700'], ['เงินกองทุนสงเคราะห์ลูกจ้าง', totals.ewf, 'text-teal-700'], ['เงินสะสม', totals.savings, 'text-indigo-700'], ['กยศ.', totals.student, 'text-cyan-700'], ['เงินกู้บริษัทฯ', totals.companyLoan, 'text-orange-700'], ['ลาเกินสิทธิ์', totals.leave, 'text-red-700'], ['ยอดสุทธิ', totals.net, 'text-emerald-700']] as const
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
    <div className="flex gap-2 overflow-x-auto whitespace-nowrap border-b border-gray-200">
      <button type="button" disabled={saving} onClick={() => requestView('scheduled')} className={`px-4 py-3 font-medium border-b-2 ${activeView === 'scheduled' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-gray-500'}`}>รอบจ่าย / บันทึกจ่าย</button>
      <button type="button" disabled={saving} onClick={() => requestView('payroll')} className={`px-4 py-3 font-medium border-b-2 ${activeView === 'payroll' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-gray-500'}`}>เงินเดือนรายเดือน (เข้า สปส.)</button>
      <button type="button" disabled={saving} onClick={() => requestView('uninsured')} className={`px-4 py-3 font-medium border-b-2 ${activeView === 'uninsured' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-gray-500'}`}>เงินเดือนรายเดือน (ไม่เข้า สปส.)</button>
      <button type="button" disabled={saving} onClick={() => requestView('daily')} className={`px-4 py-3 font-medium border-b-2 ${activeView === 'daily' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-gray-500'}`}>ค่าจ้างรายวัน (ไม่เข้า สปส.)</button>
      <button type="button" disabled={saving} onClick={() => requestView('history')} className={`px-4 py-3 font-medium border-b-2 ${activeView === 'history' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-gray-500'}`}>รายงานย้อนหลัง</button>
    </div>
    {(activeView==='payroll'||activeView==='uninsured'||activeView==='daily')&&<p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">พนักงานที่กำหนดรอบจ่ายรายวัน รายสัปดาห์ หรือหลายงวด ให้จัดทำผ่านแท็บ “รอบจ่าย / บันทึกจ่าย” เพื่อแยกช่วงวันและยอดหักแต่ละงวด ส่วนงวดที่ยืนยันไว้เดิมยังเปิดดูและบันทึกผลการจ่ายได้จากแท็บนี้</p>}
    {activeView === 'scheduled' ? <PayrollPeriodWorkspace /> : activeView === 'history' ? <>
      <div className="rounded-xl border bg-white p-4 flex flex-wrap gap-3 items-end">
        <label className="text-sm">บริษัท<select value={companyId} disabled={saving} onChange={(e) => setCompanyId(e.target.value)} className="block mt-1 rounded-lg border px-3 py-2 min-w-64">{companies.map((c) => <option key={c.id} value={c.id}>{c.name_th}</option>)}</select></label>
        <label className="text-sm">เดือนเริ่มต้น<input type="month" value={historyDateFrom} onChange={(e) => setHistoryDateFrom(e.target.value)} className="block mt-1 rounded-lg border px-3 py-2" /></label>
        <label className="text-sm">เดือนสิ้นสุด<input type="month" value={historyDateTo} onChange={(e) => setHistoryDateTo(e.target.value)} className="block mt-1 rounded-lg border px-3 py-2" /></label>
        <label className="text-sm flex-1 min-w-64">ค้นหา<input type="search" value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} placeholder="เดือน บริษัท รหัส หรือชื่อพนักงาน" className="block mt-1 w-full rounded-lg border px-3 py-2" /></label>
      </div>
      {message && <div className="rounded-lg bg-blue-50 px-4 py-3 text-blue-700">{message}</div>}
      <div className="rounded-xl border bg-white overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-50"><tr><th className="p-3 text-left">เดือน</th><th className="p-3 text-left">บริษัท</th><th className="p-3 text-left">ประเภท</th><th className="p-3 text-right">พนักงาน</th><th className="p-3 text-right">ยอดสุทธิ</th><th className="p-3 text-right">รายงาน</th></tr></thead><tbody>{filteredHistory.map((h) => <tr key={h.id} className="border-t"><td className="p-3">{monthLabel(h.payroll_month.slice(0, 7))}</td><td className="p-3">{h.company?.name_th}</td><td className="p-3">{h.is_adjustment ? 'ปรับส่วนต่าง' : h.payroll_type === 'daily' ? 'รายวัน' : h.payroll_type === 'monthly_uninsured' ? 'รายเดือน (ไม่เข้า สปส.)' : 'รายเดือน (เข้า สปส.)'}</td><td className="p-3 text-right">{h.items?.length || 0}</td><td className="p-3 text-right font-semibold">{fmt((h.items || []).reduce((sum, item) => sum + calc(item).net, 0))}</td><td className="p-3 text-right"><button onClick={() => exportExcel(h)} className="text-emerald-700">ดาวน์โหลด Excel</button></td></tr>)}{!loading && !filteredHistory.length && <tr><td colSpan={6} className="p-10 text-center text-gray-500">ไม่พบรายงาน</td></tr>}</tbody></table></div>
    </> : activeView === 'daily' ? <DailyPayrollSection /> : <>
    <div className="rounded-xl border bg-white p-4 flex flex-wrap gap-3 items-end"><label className="text-sm">บริษัท<select value={companyId} disabled={saving} onChange={(e) => setCompanyId(e.target.value)} className="block mt-1 rounded-lg border px-3 py-2 min-w-72">{companies.map((c) => <option key={c.id} value={c.id}>{c.name_th}</option>)}</select></label><label className="text-sm">เดือน<input type="month" value={month} disabled={saving} onChange={(e) => setMonth(e.target.value)} className="block mt-1 rounded-lg border px-3 py-2" /></label><label className="text-sm">วันที่จ่าย<input type="date" value={paymentDate} onChange={(e) => { setPaymentDate(e.target.value); setDirty(true) }} disabled={locked || loading || saving} className="block mt-1 rounded-lg border px-3 py-2 disabled:bg-gray-100" /></label><label className="text-sm flex-1 min-w-56 max-w-sm">ค้นหาพนักงาน<input type="search" value={employeeSearch} onChange={(e) => setEmployeeSearch(e.target.value)} placeholder="ชื่อ ชื่อเล่น หรือรหัสพนักงาน" className="block mt-1 w-full rounded-lg border px-3 py-2" /></label><span className={`rounded-full px-3 py-2 text-sm font-semibold ${locked ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{locked ? 'ยืนยันยอดแล้ว' : `กลุ่มนี้ตรวจแล้ว ${items.filter((item) => item.reviewed_at).length}/${items.length}`}</span><div className="ml-auto flex gap-2"><button type="button" disabled={loading || saving} onClick={() => setPendingAction('reload')} className="rounded-lg border px-4 py-2">โหลดข้อมูลใหม่</button><button onClick={() => exportExcel()} disabled={loading || !groupItems.length} className="rounded-lg border border-emerald-600 px-4 py-2 text-emerald-700">ดาวน์โหลด Excel</button>{locked && <button type="button" onClick={() => { setMessage(''); setRevisionOpen(true) }} disabled={saving || loading} className="rounded-lg border border-amber-500 px-4 py-2 text-amber-700">ปรับปรุงกลุ่มนี้</button>}{locked && <button onClick={downloadAllSlipsZip} disabled={loading || zipLoading || !groupItems.length} className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{zipLoading ? 'กำลังสร้าง ZIP...' : 'ดาวน์โหลด ZIP'}</button>}{!locked && <><button onClick={() => save(false)} disabled={saving || loading || !items.length} className="rounded-lg border px-4 py-2 disabled:opacity-50">บันทึกร่างกลุ่มนี้</button><button onClick={() => save(true)} disabled={saving || loading || !items.length || items.some((item) => !item.reviewed_at)} title={items.some((item) => !item.reviewed_at) ? 'ต้องตรวจสอบสลิปกลุ่มนี้ให้ครบก่อน' : undefined} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">ยืนยันกลุ่มนี้</button></>}</div></div>
    {message && <div className="rounded-lg bg-blue-50 px-4 py-3 text-blue-700">{message}</div>}
    <div className="text-sm text-gray-600">กลุ่ม{groupLabel} · {groupItems.length} คน · บันทึกและยืนยันแยกจากอีกกลุ่ม</div>
    {paidElsewhereCodes.length > 0 && <p className="text-sm text-amber-700">{paidElsewhereCodes.join(', ')} ยืนยันเงินเดือนในอีกกลุ่มแล้ว จึงไม่นำมาจ่ายซ้ำ หากต้องแก้ไขให้ปรับปรุงงวดเดิมก่อน</p>}
    {locked && items.some(item => item.social_security_enabled == null) && <p className="text-xs text-amber-700">งวดเก่าที่ไม่มีสถานะ สปส. แยกกลุ่มตามยอดหักที่บันทึกไว้ โดยไม่ใช้สถานะปัจจุบันของพนักงาน</p>}
    <div className="grid grid-cols-2 md:grid-cols-5 xl:grid-cols-10 gap-3">{cards.map(([label, value, color]) => <div key={label} className="rounded-xl border bg-white p-4"><div className="text-xs text-gray-500">{label}</div><div className={`mt-1 text-xl font-bold ${color}`}>{fmt(value)}</div></div>)}</div>
    <div className="rounded-xl border bg-white overflow-x-auto">{loading ? <div className="p-12 text-center">กำลังโหลด...</div> : <table className="w-full text-sm whitespace-nowrap"><thead className="bg-gray-50"><tr>{['พนักงาน','เงินเดือน','OT','ภาษี','ประกันสังคม','EWF','เงินสะสม','กยศ.','กู้บริษัทฯ','ลาเกินสิทธิ์','รายได้อื่นๆ','หักอื่นๆ','สุทธิ','สลิป'].map((h) => <th key={h} className="p-3 text-right first:text-left">{h}</th>)}</tr></thead><tbody>{visibleItems.map((item) => { const c = calc(item); const progress = financialProgress(item); return <tr key={item.employee_id} className="border-t"><td className="p-3"><div className="flex items-center gap-2"><b>{item.employee_code}</b>{locked ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">ยืนยันยอดแล้ว</span> : item.reviewed_at ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">ตรวจสอบแล้ว</span> : null}</div><div>{item.employee_name}{item.employee_nickname?.trim() ? ` (${item.employee_nickname.trim()})` : ''}</div><div className="text-xs text-gray-500">{item.department_position}</div></td><td className="p-3 text-right">{fmt(item.base_salary + item.position_allowance)}{item.monthly_rate != null && <div className="text-xs text-gray-500">ฐาน {fmt(item.monthly_rate)} บาท/เดือน</div>}{item.monthly_payable_days != null && <button type="button" onClick={() => setWageDetailItem(item)} className="block ml-auto text-xs text-blue-700">คิดค่าจ้าง {fmt(item.monthly_payable_days)} วัน</button>}</td><td className="p-2 text-right"><div>{fmt(item.overtime_pay)}</div><div className="text-xs text-violet-600"><div>ปกติ {fmt(item.ot_normal_hours)} ชม.</div><div>วันหยุด {fmt(item.ot_holiday_hours)} ชม.</div></div></td>{(['personal_tax','social_security','ewf','savings','student_loan','company_loan','leave_deduction','other_income','other_deduction'] as const).map((key) => <td key={key} className="p-2 text-right">{key === 'ewf' ? <><div>{fmt(item.ewf)}</div><div className="text-xs text-teal-600">สะสม {fmt(progress.accumulatedEwf)}</div></> : key === 'savings' ? <><div>{fmt(item.savings)}</div><div className="text-xs text-indigo-600">สะสม {fmt(progress.accumulatedSavings)}</div></> : key === 'company_loan' ? <><div>{fmt(item.company_loan)}</div><div className="text-xs text-orange-600">เหลือ {fmt(progress.companyLoanBalance)} ({progress.companyLoanInstallments} งวด)</div></> : locked || !['personal_tax','student_loan','other_income','other_deduction'].includes(key) ? fmt(item[key]) : <input type="text" inputMode="decimal" value={item[key]} onChange={(e) => { const value = e.target.value.replace(/,/g, '').replace(/[^\d.]/g, ''); update(item.employee_id, key, Number(value) || 0) }} className="w-24 rounded border px-2 py-1 text-right" />}</td>)}<td className="p-3 text-right font-bold text-emerald-700">{fmt(c.net)}</td><td className="p-3 text-right"><div className="flex justify-end gap-2"><button onClick={() => previewSlip(item)} className="rounded-lg bg-gray-100 text-gray-700 px-3 py-2">ดู</button><button onClick={() => downloadSlip(item)} className="rounded-lg bg-blue-50 text-blue-700 px-3 py-2">ดาวน์โหลด</button></div></td></tr> })}{visibleItems.length === 0 && <tr><td colSpan={14} className="p-10 text-center text-gray-500">ไม่พบพนักงานที่ค้นหา</td></tr>}</tbody></table>}</div>
    {company && run?.status==='confirmed' && <PayrollPaymentsPanel company={company} run={run} items={items}/>}
    {revisions.length > 0 && <details className="rounded-xl border bg-white p-4 text-sm">
      <summary className="cursor-pointer font-medium">ประวัติก่อนปรับปรุงยอด ({revisions.length} ครั้ง)</summary>
      {revisions.map(revision => <details key={revision.id} className="mt-3 rounded-lg border p-3">
        <summary className="cursor-pointer">{new Date(revision.created_at).toLocaleString('th-TH')} · {revision.reason}</summary>
        <div className="mt-2 overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-2 text-left">พนักงานในกลุ่ม{groupLabel} ณ งวดเดิม</th><th className="p-2 text-right">สุทธิเดิม</th></tr></thead><tbody>{monthlyPayrollGroup(revision.items_before, enrolledView).map(item => <tr key={item.employee_id} className="border-t"><td className="p-2">{item.employee_code} {item.employee_name}</td><td className="p-2 text-right">{fmt(Number(item.net_pay))}</td></tr>)}</tbody></table></div>
      </details>)}
    </details>}
    <Modal open={!!wageDetailItem} onClose={() => setWageDetailItem(null)} contentClassName="max-w-3xl">
      <div className="space-y-3 p-5"><h3 className="pr-8 text-lg font-semibold">รายละเอียดเงินเดือน — {wageDetailItem?.employee_code}</h3>
        <p className="text-sm text-gray-600">เต็มเดือนจ่ายเต็มอัตรา ส่วนเดือนที่ไม่เต็มคิดตามวันปฏิทินในช่วงจ้างและประเภทค่าจ้าง โดยใช้ฐานหาร 30 วัน</p>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-2 text-left">ช่วงวันที่</th><th className="p-2 text-right">ฐาน/เดือน</th><th className="p-2 text-right">วันคำนวณ</th><th className="p-2 text-right">เงินเดือน</th></tr></thead><tbody>{(wageDetailItem?.monthly_wage_details || []).map(detail => <tr key={detail.startDate} className="border-t"><td className="p-2">{detail.startDate} – {detail.endDate}</td><td className="p-2 text-right">{fmt(detail.monthlyRate)}</td><td className="p-2 text-right">{fmt(detail.payableDays)}</td><td className="p-2 text-right">{fmt(detail.amount)}</td></tr>)}</tbody></table></div>
        <div className="text-right font-semibold">เงินเดือนที่ได้รับ {fmt(wageDetailItem?.base_salary || 0)} บาท</div>
      </div>
    </Modal>
    <Modal open={revisionOpen} onClose={() => setRevisionOpen(false)} contentClassName="max-w-md">
      <div className="space-y-4 p-6">
        <h3 className="pr-8 text-lg font-semibold">ปรับปรุงเงินเดือนกลุ่มนี้</h3>
        <p className="text-sm text-gray-600">เก็บยอดเดิมของกลุ่มนี้ไว้ในประวัติ แล้วคำนวณร่างจากข้อมูลล่าสุด ต้องตรวจสลิปและยืนยันกลุ่มนี้ใหม่</p>
        <label className="block text-sm">เหตุผลปรับปรุงยอด<textarea value={revisionReason} onChange={event => setRevisionReason(event.target.value)} rows={3} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        {message && <p className="text-sm text-red-600">{message}</p>}
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setRevisionOpen(false)} className="rounded-lg border px-4 py-2">ยกเลิก</button><button type="button" onClick={() => void openRevision()} disabled={saving || !revisionReason.trim()} className="rounded-lg bg-amber-600 px-4 py-2 text-white disabled:opacity-50">เปิดปรับปรุงกลุ่มนี้</button></div>
      </div>
    </Modal>
    <Modal open={!!pendingAction} onClose={() => setPendingAction(null)} contentClassName="max-w-md" stackClassName="z-[60]">
      <div className="space-y-4 p-6">
        <h3 className="pr-8 text-lg font-semibold">{pendingAction === 'confirm' ? `ยืนยันเงินเดือนกลุ่ม${groupLabel}` : pendingAction === 'reload' ? 'โหลดข้อมูลใหม่' : pendingAction === 'switch' ? 'เปลี่ยนแท็บ' : 'ยกเลิกการตรวจสอบสลิป'}</h3>
        <p className="text-sm text-gray-600">{pendingAction === 'confirm'
          ? `ยืนยันเงินเดือน ${monthLabel(month)} ของ ${company?.name_th} กลุ่ม${groupLabel} จำนวน ${items.length} คน ยอดสุทธิรวม ${fmt(items.reduce((sum, item) => sum + calc(item).net, 0))} บาท หลังยืนยันจะล็อกยอดเฉพาะกลุ่มนี้`
          : pendingAction === 'switch' ? 'มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการเปลี่ยนแท็บและทิ้งการแก้ไขหรือไม่?' : pendingAction === 'reload' ? 'โหลดข้อมูลพนักงานและสถานะล่าสุด การแก้ไขที่ยังไม่ได้บันทึกจะถูกแทนที่' : `คืนสถานะสลิป ${preview?.item.employee_code} เป็นยังไม่ตรวจสอบหรือไม่?`}</p>
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setPendingAction(null)} className="rounded-lg border px-4 py-2">ยกเลิก</button><button type="button" disabled={saving} onClick={() => { if (pendingAction === 'switch' && pendingView) { setDirty(false); setActiveView(pendingView); setEmployeeSearch(''); setPendingView(null); setPendingAction(null); void load() } else if (pendingAction === 'reload') { setPendingAction(null); void load() } else void (pendingAction === 'confirm' ? save(true, true) : cancelReviewed(true)) }} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">ยืนยัน</button></div>
      </div>
    </Modal>
    <Modal open={!!preview} onClose={closePreview} contentClassName="max-w-none h-full flex flex-col rounded-xl">
      {preview && <div className="flex h-full min-h-0 flex-col"><div className="flex items-center justify-between gap-3 border-b p-4"><div><div className="font-semibold">พรีวิวสลิปเงินเดือน — {preview.item.employee_code}</div><div className="text-sm text-gray-500">{preview.item.employee_name} · {monthLabel(month)}</div></div><div className="flex items-center gap-2">{!locked && !preview.item.reviewed_at && <button type="button" onClick={markReviewed} disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">ตรวจสอบแล้ว</button>}{!locked && preview.item.reviewed_at && <button type="button" onClick={() => void cancelReviewed()} disabled={saving} className="rounded-lg border border-amber-500 bg-amber-50 px-4 py-2 text-amber-700 hover:bg-amber-100 disabled:opacity-50">ยกเลิกการตรวจสอบ</button>}<button type="button" onClick={() => downloadSlip(preview.item)} className="rounded-lg bg-blue-50 px-4 py-2 text-blue-700">ดาวน์โหลด</button><button type="button" aria-label="ปิดพรีวิวสลิปเงินเดือน" title="ปิด" onClick={closePreview} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-600 text-white hover:bg-red-700"><svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg></button></div></div><iframe title={`สลิป ${preview.item.employee_code}`} src={`${preview.url}#zoom=150`} className="min-h-0 flex-1 w-full" /></div>}
    </Modal>
    </>}
  </div>
}
