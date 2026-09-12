import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer'
import './fontConfig'
import { mm, bahtText, formatCurrency } from './styles'
import type { BillHeaderSetting } from '../../../types'

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
  companyData: BillHeaderSetting
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
    width: mm(70),
    padding: mm(2),
    justifyContent: 'center',
  },
  companyName: {
    fontSize: 9,
    fontWeight: 'bold',
    marginBottom: 3,
  },
  companyDetail: {
    fontSize: 8,
    lineHeight: 1.8,
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
    borderWidth: 1,
    borderColor: cbColors.black,
  },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: cbColors.brightBlue,
    borderBottomWidth: 1,
    borderBottomColor: cbColors.black,
  },
  thCell: {
    paddingVertical: 5,
    paddingHorizontal: 3,
    borderRightWidth: 1,
    borderRightColor: cbColors.black,
  },
  thCellLast: {
    paddingVertical: 5,
    paddingHorizontal: 3,
  },
  thText: {
    color: cbColors.white,
    fontSize: 8.5,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  tbRow: {
    flexDirection: 'row',
    minHeight: 18,
  },
  tdCell: {
    paddingVertical: 2,
    paddingHorizontal: 3,
    borderRightWidth: 1,
    borderRightColor: cbColors.black,
  },
  tdCellLast: {
    paddingVertical: 2,
    paddingHorizontal: 3,
  },
  tdText: {
    fontSize: 8.5,
  },
  tableFooterRow: {
    flexDirection: 'row',
    minHeight: 22,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: cbColors.black,
    backgroundColor: cbColors.summaryBg,
  },
  tableFooterCell: {
    fontSize: 9,
    fontWeight: 'bold',
    paddingVertical: 3,
    paddingHorizontal: 3,
  },

  /* Column widths */
  colNo: { width: '8%' },
  colDesc: { width: '47%' },
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
    companyData: comp,
    invoiceNo,
    refNo,
    invoiceDate,
    customerName,
    customerAddress1,
    customerAddress2,
    items,
    grandTotal,
  } = props

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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: mm(2), marginBottom: 2 }}>
              {comp.logo_url && (
                <Image src={comp.logo_url} style={{ width: mm(12), height: mm(12), objectFit: 'contain' as const }} />
              )}
              <View style={{ flex: 1 }}>
                <Text style={s.companyName}>{comp.company_name + Z}</Text>
              </View>
            </View>
            <Text style={s.companyDetail}>{comp.address + Z}</Text>
            <Text style={s.companyDetail}>{'เบอร์โทร: ' + (comp.phone || '') + Z}</Text>
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
            <View style={[s.thCell, s.colNo]}><Text style={s.thText}>{'ลำดับ' + Z}</Text></View>
            <View style={[s.thCell, s.colDesc]}><Text style={s.thText}>{'รายการ / DESCRIPTION' + Z}</Text></View>
            <View style={[s.thCell, s.colQty]}><Text style={s.thText}>{'จำนวน' + Z}</Text></View>
            <View style={[s.thCell, s.colPrice]}><Text style={s.thText}>{'หน่วยละ' + Z}</Text></View>
            <View style={[s.thCellLast, s.colAmount]}><Text style={s.thText}>{'จำนวนเงิน' + Z}</Text></View>
          </View>

          {/* Body */}
          {filledItems.map((row, idx) => {
            const lineTotal = (row.qty || 0) * (row.price || 0)
            const hasData = row.desc && row.qty > 0
            return (
              <View key={idx} style={s.tbRow}>
                <View style={[s.tdCell, s.colNo]}><Text style={[s.tdText, { textAlign: 'center' }]}>{hasData ? String(idx + 1) : ' '}</Text></View>
                <View style={[s.tdCell, s.colDesc]}><Text style={[s.tdText, { paddingLeft: mm(2) }]}>{(row.desc || ' ') + Z}</Text></View>
                <View style={[s.tdCell, s.colQty]}><Text style={[s.tdText, { textAlign: 'center' }]}>{hasData ? row.qty.toString() : ' '}</Text></View>
                <View style={[s.tdCell, s.colPrice]}><Text style={[s.tdText, { textAlign: 'center' }]}>{hasData ? formatCurrency(row.price) : ' '}</Text></View>
                <View style={[s.tdCellLast, s.colAmount]}><Text style={[s.tdText, { textAlign: 'center' }]}>{hasData ? formatCurrency(lineTotal) : ' '}</Text></View>
              </View>
            )
          })}

          {/* Footer */}
          <View style={s.tableFooterRow}>
            <View style={[s.tdCell, { width: '55%' }]}><Text style={[s.tableFooterCell, { textAlign: 'center' }]}>{bahtText(grandTotal) + Z}</Text></View>
            <View style={[s.tdCell, { width: '15%' }]}><Text style={s.tableFooterCell}> </Text></View>
            <View style={[s.tdCell, { width: '15%' }]}><Text style={[s.tableFooterCell, { textAlign: 'center' }]}>{'รวมเงิน' + Z}</Text></View>
            <View style={[s.tdCellLast, { width: '15%' }]}><Text style={[s.tableFooterCell, { textAlign: 'center' }]}>{grandTotal > 0 ? formatCurrency(grandTotal) : '0.00'}</Text></View>
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
