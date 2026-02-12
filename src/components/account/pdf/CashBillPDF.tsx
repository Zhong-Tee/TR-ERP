import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'
import './fontConfig'
import { mm, bahtText, formatCurrency, companyData } from './styles'

/* ─── Bright blue color palette for Cash Bill ─── */
const cbColors = {
  black: '#1a1a1a',
  darkGray: '#333333',
  mediumGray: '#666666',
  lightGray: '#999999',
  border: '#cccccc',
  /** สีฟ้าสดใส */
  brightBlue: '#0EA5E9',
  brightBlueDark: '#0284C7',
  tableHeaderText: '#ffffff',
  tableStripeBg: '#f0f9ff',
  summaryBg: '#e0f2fe',
  white: '#ffffff',
}

/* ─── Types ─── */
export interface CashBillItem {
  desc: string
  qty: number
  price: number
}

export interface CashBillPDFProps {
  company: 'tr' | 'odf'
  invoiceNo: string
  refNo: string
  invoiceDate: string
  customerName: string
  customerAddress1: string
  customerAddress2: string
  items: CashBillItem[]
  grandTotal: number
}

const TOTAL_ROWS = 12

/* ─── Styles ─── */
const s = StyleSheet.create({
  page: {
    fontFamily: 'Sarabun',
    fontSize: 9,
    letterSpacing: 0.3,
    color: cbColors.black,
    backgroundColor: cbColors.white,
    paddingHorizontal: mm(6),
    paddingVertical: mm(6),
    display: 'flex',
    flexDirection: 'column',
  },

  /* Header */
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: mm(2),
  },
  companyBox: {
    borderWidth: 0.5,
    borderColor: cbColors.black,
    width: mm(70),
    height: mm(28),
    padding: mm(2),
    justifyContent: 'center',
  },
  companyName: {
    fontSize: 9,
    fontWeight: 'bold',
    marginBottom: 1,
  },
  companyDetail: {
    fontSize: 8,
    lineHeight: 1.4,
    color: cbColors.darkGray,
  },
  titleBlock: {
    textAlign: 'right',
    width: '48%',
  },
  titleMain: {
    fontSize: 20,
    fontWeight: 'bold',
    color: cbColors.brightBlue,
  },
  titleSub: {
    fontSize: 10,
    fontWeight: 'bold',
    color: cbColors.mediumGray,
    marginBottom: mm(2),
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginBottom: 2,
  },
  infoLabel: {
    fontSize: 9,
    fontWeight: 'bold',
    width: mm(22),
    textAlign: 'right',
    marginRight: mm(2),
  },
  infoValue: {
    fontSize: 9,
    width: mm(25),
    textAlign: 'center',
    borderBottomWidth: 0.5,
    borderBottomColor: cbColors.lightGray,
    paddingBottom: 1,
  },
  infoValueWide: {
    fontSize: 9,
    width: mm(38),
    textAlign: 'center',
    borderBottomWidth: 0.5,
    borderBottomColor: cbColors.lightGray,
    paddingBottom: 1,
  },

  /* Customer details */
  customerSection: {
    marginBottom: mm(2),
  },
  customerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },
  customerLabel: {
    fontSize: 9,
    fontWeight: 'bold',
    width: mm(28),
  },
  customerValue: {
    fontSize: 9,
    flex: 1,
    borderBottomWidth: 0.5,
    borderBottomColor: cbColors.lightGray,
    borderBottomStyle: 'dashed' as const,
    paddingBottom: 1,
    paddingLeft: 2,
  },

  /* Table */
  table: {
    width: '100%',
    borderWidth: 0.5,
    borderColor: cbColors.darkGray,
  },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: cbColors.brightBlue,
    minHeight: 22,
    alignItems: 'center',
  },
  tableHeaderCell: {
    color: cbColors.tableHeaderText,
    fontSize: 8.5,
    fontWeight: 'bold',
    textAlign: 'center',
    paddingVertical: 3,
    paddingHorizontal: 2,
  },
  tableBodyRow: {
    flexDirection: 'row',
    minHeight: 18,
    alignItems: 'center',
    borderTopWidth: 0.3,
    borderTopColor: '#ddd',
  },
  tableBodyRowAlt: {
    flexDirection: 'row',
    minHeight: 18,
    alignItems: 'center',
    borderTopWidth: 0.3,
    borderTopColor: '#ddd',
    backgroundColor: cbColors.tableStripeBg,
  },
  tableCell: {
    fontSize: 8.5,
    paddingVertical: 2,
    paddingHorizontal: 3,
  },
  tableFooterRow: {
    flexDirection: 'row',
    minHeight: 22,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: cbColors.brightBlue,
    backgroundColor: cbColors.summaryBg,
  },
  tableFooterCell: {
    fontSize: 9,
    fontWeight: 'bold',
    paddingVertical: 3,
    paddingHorizontal: 3,
  },

  /* Column widths */
  colDesc: { width: '55%' },
  colQty: { width: '15%' },
  colPrice: { width: '15%' },
  colAmount: { width: '15%' },

  /* Footer / Signature */
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 'auto' as const,
    paddingTop: mm(5),
  },
  signatureBlock: {
    alignItems: 'center',
    width: '40%',
  },
  signatureLine: {
    width: '85%',
    borderTopWidth: 0.5,
    borderTopColor: cbColors.black,
    borderTopStyle: 'dashed' as const,
    marginTop: 24,
    paddingTop: 3,
  },
  signatureLabel: {
    fontSize: 8,
    color: cbColors.mediumGray,
    textAlign: 'center',
  },
})

/** Zero-width space — appended to Thai text to prevent last-char clipping in @react-pdf */
const Z = '\u200B'

/* ─── Component ─── */
export default function CashBillPDF(props: CashBillPDFProps) {
  const {
    company,
    invoiceNo,
    refNo,
    invoiceDate,
    customerName,
    customerAddress1,
    customerAddress2,
    items,
    grandTotal,
  } = props

  const comp = companyData[company]

  /* Fill items to TOTAL_ROWS */
  const filledItems: CashBillItem[] = [...items]
  while (filledItems.length < TOTAL_ROWS) {
    filledItems.push({ desc: '', qty: 0, price: 0 })
  }

  /* Format date */
  const displayDate = invoiceDate
    ? new Date(invoiceDate).toLocaleDateString('th-TH', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : ''

  return (
    <Document>
      <Page size={[mm(148), mm(210)]} style={s.page}>
        {/* ─── Header ─── */}
        <View style={s.header}>
          {/* Company Stamp */}
          <View style={s.companyBox}>
            <Text style={s.companyName}>{comp.name + Z}</Text>
            <Text style={s.companyDetail}>{comp.address + Z}</Text>
            <Text style={s.companyDetail}>{'เบอร์โทร: ' + comp.phone + Z}</Text>
          </View>

          {/* Title + Bill Numbers */}
          <View style={s.titleBlock}>
            <Text style={s.titleMain}>{'บิลเงินสด' + Z}</Text>
            <Text style={s.titleSub}>CASH SALE</Text>

            <View style={s.infoRow}>
              <Text style={s.infoLabel}>{'เลขที่:' + Z}</Text>
              <Text style={s.infoValueWide}>{invoiceNo}</Text>
            </View>
            <View style={s.infoRow}>
              <Text style={s.infoLabel}>{'เลขที่อ้างอิง:' + Z}</Text>
              <Text style={s.infoValueWide}>{refNo}</Text>
            </View>
          </View>
        </View>

        {/* ─── Customer Details ─── */}
        <View style={s.customerSection}>
          <View style={s.customerRow}>
            <Text style={s.customerLabel}>{'วันที่ / Date:' + Z}</Text>
            <Text style={s.customerValue}>{displayDate + Z}</Text>
          </View>
          <View style={s.customerRow}>
            <Text style={s.customerLabel}>{'นาม / Customer:' + Z}</Text>
            <Text style={s.customerValue}>{customerName + Z}</Text>
          </View>
          <View style={s.customerRow}>
            <Text style={s.customerLabel}>{'ที่อยู่ / Address:' + Z}</Text>
            <Text style={s.customerValue}>{customerAddress1 + Z}</Text>
          </View>
          {customerAddress2 ? (
            <View style={s.customerRow}>
              <Text style={s.customerLabel}> </Text>
              <Text style={s.customerValue}>{customerAddress2 + Z}</Text>
            </View>
          ) : null}
        </View>

        {/* ─── Items Table ─── */}
        <View style={s.table}>
          {/* Header */}
          <View style={s.tableHeaderRow}>
            <Text style={[s.tableHeaderCell, s.colDesc]}>{'รายการ / DESCRIPTION' + Z}</Text>
            <Text style={[s.tableHeaderCell, s.colQty]}>{'จำนวน' + Z}</Text>
            <Text style={[s.tableHeaderCell, s.colPrice]}>{'หน่วยละ' + Z}</Text>
            <Text style={[s.tableHeaderCell, s.colAmount]}>{'จำนวนเงิน' + Z}</Text>
          </View>

          {/* Body */}
          {filledItems.map((row, idx) => {
            const lineTotal = (row.qty || 0) * (row.price || 0)
            const rowStyle = idx % 2 === 1 ? s.tableBodyRowAlt : s.tableBodyRow
            return (
              <View key={idx} style={rowStyle}>
                <Text style={[s.tableCell, s.colDesc, { paddingLeft: mm(4) }]}>
                  {(row.desc || ' ') + Z}
                </Text>
                <Text style={[s.tableCell, s.colQty, { textAlign: 'center' }]}>
                  {row.qty > 0 ? row.qty.toString() : ' '}
                </Text>
                <Text style={[s.tableCell, s.colPrice, { textAlign: 'center' }]}>
                  {row.price > 0 ? formatCurrency(row.price) : ' '}
                </Text>
                <Text style={[s.tableCell, s.colAmount, { textAlign: 'right', paddingRight: mm(2) }]}>
                  {lineTotal > 0 ? formatCurrency(lineTotal) : ' '}
                </Text>
              </View>
            )
          })}

          {/* Footer */}
          <View style={s.tableFooterRow}>
            <Text style={[s.tableFooterCell, { width: '55%', textAlign: 'center', fontSize: 9 }]}>
              {bahtText(grandTotal) + Z}
            </Text>
            <Text style={[s.tableFooterCell, { width: '15%' }]}> </Text>
            <Text style={[s.tableFooterCell, { width: '15%', textAlign: 'center' }]}>{'รวมเงิน' + Z}</Text>
            <Text style={[s.tableFooterCell, { width: '15%', textAlign: 'right', paddingRight: mm(2) }]}>
              {grandTotal > 0 ? formatCurrency(grandTotal) : '0.00'}
            </Text>
          </View>
        </View>

        {/* ─── Signature ─── */}
        <View style={s.footer}>
          <View style={s.signatureBlock}>
            <View style={s.signatureLine} />
            <Text style={s.signatureLabel}>{'ผู้รับเงิน / COLLECTOR' + Z}</Text>
          </View>
          <View style={s.signatureBlock}>
            <View style={s.signatureLine} />
            <Text style={s.signatureLabel}>{'วันที่รับเงิน' + Z}</Text>
          </View>
        </View>
      </Page>
    </Document>
  )
}
