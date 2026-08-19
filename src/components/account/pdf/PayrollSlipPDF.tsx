import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import './fontConfig'
import type { HRCompany } from '../../../types'
import type { PayrollItem } from '../../../lib/payrollApi'

const navy = '#203b68'
const gold = '#d9a928'
const green = '#2f8047'
const red = '#aa3d3d'
const fmt = (value: number) => Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// React PDF can clip the final Thai glyph because its advance width is calculated too narrowly.
// A non-breaking space keeps the final glyph inside the text layout box without changing the visible value.
const pdfText = (value: string) => `${value}\u00a0`

const s = StyleSheet.create({
  page: { fontFamily: 'Sarabun', fontSize: 10, padding: 28, color: '#20252d' },
  header: { backgroundColor: navy, color: 'white', padding: 22, flexDirection: 'row', justifyContent: 'space-between', minHeight: 115 },
  logo: { width: 88, height: 62, objectFit: 'contain', marginRight: 14 },
  companyWrap: { flexDirection: 'row', alignItems: 'center', width: '72%' },
  companyName: { fontSize: 17, fontWeight: 'bold', marginBottom: 5 },
  companyLine: { fontSize: 8.5, color: '#d7dfec', lineHeight: 1.5 },
  title: { color: gold, fontSize: 21, fontWeight: 'bold', textAlign: 'right' },
  subtitle: { color: '#d7dfec', fontSize: 9, textAlign: 'right', marginTop: 5 },
  info: { marginTop: 14, border: '1 solid #d6dde8', borderRadius: 5 },
  infoRow: { flexDirection: 'row', minHeight: 34, alignItems: 'stretch' },
  infoRowDivider: { borderBottomWidth: 1, borderBottomColor: '#d6dde8' },
  infoLabel: { width: '17%', backgroundColor: '#e8eef7', padding: 7, fontSize: 8.5, lineHeight: 1.25, fontWeight: 'bold' },
  infoValue: { width: '33%', padding: 7, fontSize: 8.5, lineHeight: 1.35 },
  columns: { flexDirection: 'row', gap: 12, marginTop: 16 },
  column: { width: '50%' },
  sectionTitleIncome: { backgroundColor: green, color: 'white', fontWeight: 'bold', fontSize: 12, padding: 8 },
  sectionTitleDeduction: { backgroundColor: red, color: 'white', fontWeight: 'bold', fontSize: 12, padding: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, paddingHorizontal: 8 },
  alt: { backgroundColor: '#f8e9e9' },
  totalIncome: { backgroundColor: green, color: 'white', fontWeight: 'bold' },
  totalDeduction: { backgroundColor: red, color: 'white', fontWeight: 'bold' },
  net: { marginTop: 16, backgroundColor: navy, color: 'white', borderRadius: 5, padding: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  netLabel: { fontSize: 17, fontWeight: 'bold' },
  netValue: { color: gold, fontSize: 18, fontWeight: 'bold' },
  ytd: { marginTop: 16, padding: 14, borderRadius: 5, backgroundColor: '#f6f7f9' },
  ytdTitle: { color: navy, fontSize: 12, fontWeight: 'bold', paddingBottom: 7, borderBottom: '1 solid #d9dfe8', marginBottom: 7 },
  sign: { marginTop: 22, alignItems: 'flex-end', minHeight: 72 },
  signature: { width: 180, height: 38, objectFit: 'contain' },
  signText: { width: 180, textAlign: 'center', fontSize: 8.5 },
  footer: { position: 'absolute', left: 28, right: 28, bottom: 14, color: '#999', fontSize: 7.5, fontStyle: 'italic', textAlign: 'center' },
})

export interface PayrollYtd {
  income: number
  personalTax: number
  socialSecurity: number
  studentLoan: number
  companyLoan: number
  accumulatedSavings: number
  companyLoanBalance: number
  companyLoanInstallments: number
}

export default function PayrollSlipPDF({ company, item, monthLabel, paymentDate, ytd }: { company: HRCompany; item: PayrollItem; monthLabel: string; paymentDate: string; ytd: PayrollYtd }) {
  const positionOnly = item.department_position?.includes(' / ')
    ? item.department_position.split(' / ').slice(1).join(' / ')
    : item.department_position || '-'
  const incomes = [
    ['เงินเดือน', item.base_salary], ['เงินพิเศษ/ประจำตำแหน่ง', item.position_allowance], ['รายได้อื่น', item.other_income],
  ].filter(([, value]) => Number(value) !== 0) as [string, number][]
  const deductions = [
    ['ภาษีส่วนบุคคล', item.personal_tax], ['ประกันสังคม', item.social_security], ['เงินสะสม', item.savings], ['เงินกู้ยืม กยศ.', item.student_loan],
    ['เงินกู้บริษัทฯ', item.company_loan], ['ลาเกินสิทธิ์', item.leave_deduction], ['รายการหักอื่น', item.other_deduction],
  ].filter(([, value]) => Number(value) !== 0) as [string, number][]
  const gross = item.gross_income ?? item.base_salary + item.position_allowance + item.other_income
  const totalDeduction = item.total_deduction ?? item.personal_tax + item.social_security + item.savings + item.student_loan + item.company_loan + item.leave_deduction + item.other_deduction
  const net = item.net_pay ?? gross - totalDeduction
  return <Document><Page size={[595.28, 841.89]} style={s.page} wrap={false}>
    <View style={s.header}>
      <View style={s.companyWrap}>{company.logo_url && <Image src={company.logo_url} style={s.logo} />}<View><Text style={s.companyName}>{company.name_th}</Text>{company.name_en && <Text style={s.companyLine}>{company.name_en}</Text>}<Text style={s.companyLine}>{company.address || '-'}</Text><Text style={s.companyLine}>โทร {company.phone || '-'} · เลขผู้เสียภาษี {company.tax_id || '-'}</Text></View></View>
      <View><Text style={s.title}>สลิปเงินเดือน</Text><Text style={s.subtitle}>PAYSLIP / SALARY SLIP</Text></View>
    </View>
    <View style={s.info}><View style={[s.infoRow, s.infoRowDivider]}><Text style={s.infoLabel}>{pdfText('ชื่อ-สกุล')}</Text><Text style={s.infoValue}>{pdfText(item.employee_name || '-')}</Text><Text style={s.infoLabel}>{pdfText('ตำแหน่ง')}</Text><Text style={s.infoValue}>{pdfText(positionOnly)}</Text></View><View style={s.infoRow}><Text style={s.infoLabel}>{pdfText('ประจำเดือน')}</Text><Text style={s.infoValue}>{pdfText(monthLabel)}</Text><Text style={s.infoLabel}>{pdfText('วันที่จ่าย')}</Text><Text style={s.infoValue}>{pdfText(paymentDate || '-')}</Text></View></View>
    <View style={s.columns}>
      <View style={s.column}><Text style={s.sectionTitleIncome}>รายการได้</Text>{incomes.map(([label, value]) => <View key={label} style={s.row}><Text>{label}</Text><Text>{fmt(value)}</Text></View>)}<View style={[s.row, s.totalIncome]}><Text>รวมเงินได้</Text><Text>{fmt(gross)}</Text></View></View>
      <View style={s.column}><Text style={s.sectionTitleDeduction}>รายการหัก</Text>{deductions.map(([label, value], index) => <View key={label} style={[s.row, index % 2 ? s.alt : {}]}><Text>{label}</Text><Text>{fmt(value)}</Text></View>)}<View style={[s.row, s.totalDeduction]}><Text>รวมเงินหัก</Text><Text>{fmt(totalDeduction)}</Text></View></View>
    </View>
    <View style={s.net}><Text style={s.netLabel}>เงินเดือนสุทธิ (NET PAY)</Text><Text style={s.netValue}>{fmt(net)} บาท</Text></View>
    <View style={s.ytd}><Text style={s.ytdTitle}>ข้อมูลสะสมต่อปี</Text><View style={s.row}><Text>รวมรายรับทั้งหมดต่อปี</Text><Text>{fmt(ytd.income)}</Text></View><View style={s.row}><Text>ภาษีสะสมรวม</Text><Text>{fmt(ytd.personalTax)}</Text></View><View style={s.row}><Text>ประกันสังคมสะสมรวม</Text><Text>{fmt(ytd.socialSecurity)}</Text></View><View style={s.row}><Text>เงินสะสมรวม</Text><Text>{fmt(ytd.accumulatedSavings)}</Text></View><View style={s.row}><Text>กยศ. สะสมรวม</Text><Text>{fmt(ytd.studentLoan)}</Text></View><View style={s.row}><Text>เงินกู้บริษัทฯ คงเหลือ</Text><Text>{fmt(ytd.companyLoanBalance)} ({ytd.companyLoanInstallments} งวด)</Text></View></View>
    <View style={s.sign}>{company.signature_url && <Image src={company.signature_url} style={s.signature} />}<Text style={s.signText}>({company.signatory_name || 'ผู้มีอำนาจลงนาม'})</Text><Text style={s.signText}>{company.signatory_title || 'ผู้จ่ายเงิน'}</Text></View>
    <Text style={s.footer}>เอกสารนี้จัดทำโดยระบบ ไม่ต้องลงลายมือชื่อกำกับหากส่งในรูปแบบอิเล็กทรอนิกส์</Text>
  </Page></Document>
}
