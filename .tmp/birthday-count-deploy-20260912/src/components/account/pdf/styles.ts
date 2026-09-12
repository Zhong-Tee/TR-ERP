import { StyleSheet } from '@react-pdf/renderer'

/* ─── mm → pt conversion (1mm = 2.835pt) ─── */
export const mm = (v: number) => v * 2.835

/* ─── Color Palette ─── */
export const colors = {
  black: '#1a1a1a',
  darkGray: '#333333',
  mediumGray: '#666666',
  lightGray: '#999999',
  border: '#cccccc',
  headerBg: '#f5f5f5',
  tableHeaderBg: '#2c3e50',
  tableHeaderText: '#ffffff',
  tableStripeBg: '#fafafa',
  accent: '#2980b9',
  accentDark: '#1a5276',
  summaryBg: '#ecf0f1',
  white: '#ffffff',
}

/* ─── Shared Styles ─── */
export const baseStyles = StyleSheet.create({
  /* Page */
  page: {
    fontFamily: 'Sarabun',
    fontSize: 10,
    color: colors.black,
    backgroundColor: colors.white,
  },

  /* Text */
  textBold: {
    fontWeight: 'bold',
  },
  textItalic: {
    fontStyle: 'italic',
  },
  textCenter: {
    textAlign: 'center',
  },
  textRight: {
    textAlign: 'right',
  },
  textSmall: {
    fontSize: 8,
  },
  textMedium: {
    fontSize: 10,
  },
  textLarge: {
    fontSize: 14,
  },
  textXL: {
    fontSize: 18,
  },
  textXXL: {
    fontSize: 22,
  },

  /* Layout */
  row: {
    flexDirection: 'row',
  },
  spaceBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  flexGrow: {
    flexGrow: 1,
  },

  /* Borders */
  borderBottom: {
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  borderAll: {
    borderWidth: 0.5,
    borderColor: colors.border,
  },

  /* Signature Section */
  signatureBlock: {
    alignItems: 'center',
    width: '40%',
  },
  signatureLine: {
    width: '80%',
    borderTopWidth: 0.5,
    borderTopColor: colors.black,
    borderTopStyle: 'dashed' as const,
    marginTop: 30,
    paddingTop: 4,
  },
  signatureLabel: {
    fontSize: 9,
    color: colors.mediumGray,
    textAlign: 'center',
  },
})

/* ─── Table Styles (professional look) ─── */
export const tableStyles = StyleSheet.create({
  table: {
    width: '100%',
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  headerRow: {
    flexDirection: 'row',
    backgroundColor: colors.tableHeaderBg,
    minHeight: 24,
    alignItems: 'center',
  },
  headerCell: {
    color: colors.tableHeaderText,
    fontSize: 9,
    fontWeight: 'bold',
    textAlign: 'center',
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  bodyRow: {
    flexDirection: 'row',
    minHeight: 20,
    alignItems: 'center',
    borderTopWidth: 0.3,
    borderTopColor: colors.border,
  },
  bodyRowStripe: {
    flexDirection: 'row',
    minHeight: 20,
    alignItems: 'center',
    borderTopWidth: 0.3,
    borderTopColor: colors.border,
    backgroundColor: colors.tableStripeBg,
  },
  bodyCell: {
    fontSize: 9,
    paddingVertical: 3,
    paddingHorizontal: 4,
  },
  footerRow: {
    flexDirection: 'row',
    minHeight: 24,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.tableHeaderBg,
    backgroundColor: colors.summaryBg,
  },
  footerCell: {
    fontSize: 10,
    fontWeight: 'bold',
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
})

/* ─── Thai Baht Text Conversion ─── */
function convertDigits(s: string): string {
  const n = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า']
  const d = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน', 'ล้าน']
  let o = ''
  const l = s.length
  for (let i = 0; i < l; i++) {
    const v = parseInt(s[i])
    const p = l - i - 1
    if (v > 0) {
      if (p === 1 && v === 1) o += 'สิบ'
      else if (p === 1 && v === 2) o += 'ยี่สิบ'
      else if (p === 0 && v === 1 && l > 1 && s[l - 2] !== '0') o += 'เอ็ด'
      else o += n[v] + d[p]
    }
  }
  return o
}

export function bahtText(num: number): string {
  if (isNaN(num) || num <= 0) return '-'
  const s = num.toFixed(2)
  const [intPart, decPart] = s.split('.')
  const t = convertDigits(intPart)
  return t ? t + 'บาท' + (decPart === '00' ? 'ถ้วน' : convertDigits(decPart) + 'สตางค์') : ''
}

/* ─── Number formatting ─── */
export function formatCurrency(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * @deprecated Use bill_header_settings from DB instead.
 * Kept as fallback until DB data is confirmed stable.
 */
export const companyData: Record<string, {
  name: string
  nameEn?: string
  address: string
  taxId: string
  phone: string
  branch: string
}> = {
  tr: {
    name: 'ห้างหุ้นส่วนจำกัด ทีอาร์ คิดส์ช็อป',
    nameEn: 'TR Kidsshop Limited Partnership',
    address: '1641,1643 ชั้นที่ 3 ถนนเพชรเกษม แขวงหลักสอง เขตบางแค กรุงเทพมหานคร 10160',
    taxId: '0103563005345',
    phone: '082-934-1288',
    branch: 'สำนักงานใหญ่',
  },
  odf: {
    name: 'บริษัท ออนดีมานด์ แฟคตอรี่ จำกัด',
    nameEn: 'Ondemand Factory Co., Ltd.',
    address: '1641,1643 ถนนเพชรเกษม แขวงหลักสอง เขตบางแค กรุงเทพมหานคร 10160',
    taxId: '0105564109286',
    phone: '082-934-1288',
    branch: 'สำนักงานใหญ่',
  },
}
