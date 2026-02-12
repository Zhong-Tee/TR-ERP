import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer'
import './fontConfig'
import { mm, colors, bahtText, formatCurrency, companyData } from './styles'

/* ─── Types ─── */
export interface TaxInvoiceItem {
  description: string
  quantity: number
  unitPrice: number
  amount: number
}

export interface TaxInvoicePDFProps {
  company: 'tr' | 'odf'
  invoiceNo: string
  invoiceDate: string
  dueDate?: string
  paymentTerms?: string
  customerName: string
  customerAddress: string
  customerTaxId: string
  customerBranch?: string
  customerPhone?: string
  customerEmail?: string
  items: TaxInvoiceItem[]
  subtotal: number
  vatRate: number
  vatAmount: number
  grandTotal: number
  refBillNo?: string
  isCopy?: boolean
}

const TOTAL_ROWS = 10

/* ─── Styles ─── */
const s = StyleSheet.create({
  page: {
    fontFamily: 'Sarabun',
    fontSize: 10,
    letterSpacing: 0.3,
    color: colors.black,
    backgroundColor: colors.white,
    paddingHorizontal: mm(15),
    paddingTop: mm(12),
    paddingBottom: mm(15),
    display: 'flex',
    flexDirection: 'column',
  },

  /* ─── Header / Title ─── */
  headerSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: mm(4),
  },
  sellerBlock: {
    width: '58%',
  },
  sellerName: {
    fontSize: 13,
    fontWeight: 'bold',
    color: colors.accentDark,
    marginBottom: 2,
  },
  sellerNameEn: {
    fontSize: 9,
    color: colors.mediumGray,
    marginBottom: 3,
  },
  sellerDetail: {
    fontSize: 9,
    lineHeight: 1.5,
    color: colors.darkGray,
  },
  titleBlock: {
    width: '40%',
    alignItems: 'flex-end',
  },
  docTypeBadge: {
    backgroundColor: colors.tableHeaderBg,
    paddingHorizontal: mm(6),
    paddingVertical: mm(2),
    borderRadius: 3,
    marginBottom: mm(2),
  },
  docTypeText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: colors.white,
    textAlign: 'center',
  },
  docTypeSubText: {
    fontSize: 9,
    color: colors.white,
    textAlign: 'center',
  },
  copyBadge: {
    fontSize: 8,
    color: colors.accent,
    fontWeight: 'bold',
    textAlign: 'right',
    marginBottom: 3,
  },

  /* ─── Document Info ─── */
  docInfoSection: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: mm(3),
  },
  docInfoTable: {
    width: mm(75),
  },
  docInfoRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.3,
    borderBottomColor: colors.border,
    paddingVertical: 3,
  },
  docInfoLabel: {
    fontSize: 9,
    fontWeight: 'bold',
    width: mm(28),
    color: colors.darkGray,
  },
  docInfoValue: {
    fontSize: 9,
    flex: 1,
    textAlign: 'right',
  },

  /* ─── Buyer Info ─── */
  buyerSection: {
    borderWidth: 0.5,
    borderColor: colors.border,
    borderRadius: 3,
    padding: mm(3),
    marginBottom: mm(4),
    backgroundColor: '#fcfcfc',
  },
  buyerTitle: {
    fontSize: 9,
    fontWeight: 'bold',
    color: colors.accent,
    marginBottom: 4,
  },
  buyerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  buyerRow: {
    flexDirection: 'row',
    width: '100%',
    marginBottom: 3,
  },
  buyerHalfRow: {
    flexDirection: 'row',
    width: '50%',
    marginBottom: 3,
  },
  buyerLabel: {
    fontSize: 9,
    fontWeight: 'bold',
    width: mm(24),
    color: colors.mediumGray,
  },
  buyerHalfLabel: {
    fontSize: 9,
    fontWeight: 'bold',
    width: mm(20),
    color: colors.mediumGray,
  },
  buyerValue: {
    fontSize: 9,
    flex: 1,
  },

  /* ─── Items Table ─── */
  table: {
    width: '100%',
    borderWidth: 0.5,
    borderColor: colors.border,
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: mm(3),
  },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: colors.tableHeaderBg,
    minHeight: 26,
    alignItems: 'center',
  },
  tableHeaderCell: {
    color: colors.tableHeaderText,
    fontSize: 9,
    fontWeight: 'bold',
    textAlign: 'center',
    paddingVertical: 5,
    paddingHorizontal: 3,
  },
  tableBodyRow: {
    flexDirection: 'row',
    minHeight: 22,
    alignItems: 'center',
    borderTopWidth: 0.3,
    borderTopColor: '#eee',
  },
  tableBodyRowAlt: {
    flexDirection: 'row',
    minHeight: 22,
    alignItems: 'center',
    borderTopWidth: 0.3,
    borderTopColor: '#eee',
    backgroundColor: '#f8f9fa',
  },
  tableCell: {
    fontSize: 9,
    paddingVertical: 3,
    paddingHorizontal: 4,
  },

  /* Column widths */
  colNo: { width: '7%' },
  colDesc: { width: '43%' },
  colQty: { width: '12%' },
  colUnit: { width: '13%' },
  colAmount: { width: '13%' },
  colVat: { width: '12%' },

  /* ─── Summary ─── */
  summarySection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: mm(5),
  },
  bahtTextBox: {
    width: '55%',
    borderWidth: 0.5,
    borderColor: colors.border,
    borderRadius: 3,
    padding: mm(2.5),
    backgroundColor: colors.summaryBg,
    justifyContent: 'center',
  },
  bahtTextLabel: {
    fontSize: 8,
    color: colors.mediumGray,
    marginBottom: 2,
  },
  bahtTextValue: {
    fontSize: 11,
    fontWeight: 'bold',
    color: colors.accentDark,
  },
  summaryTable: {
    width: '40%',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    borderBottomWidth: 0.3,
    borderBottomColor: colors.border,
  },
  summaryLabel: {
    fontSize: 9,
    color: colors.darkGray,
  },
  summaryValue: {
    fontSize: 9,
    textAlign: 'right',
    fontWeight: 'bold',
  },
  grandTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    backgroundColor: colors.tableHeaderBg,
    paddingHorizontal: mm(2),
    borderRadius: 2,
    marginTop: 2,
  },
  grandTotalLabel: {
    fontSize: 11,
    fontWeight: 'bold',
    color: colors.white,
  },
  grandTotalValue: {
    fontSize: 11,
    fontWeight: 'bold',
    color: colors.white,
    textAlign: 'right',
  },

  /* ─── Signature ─── */
  signatureSection: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 'auto' as const,
    paddingTop: mm(8),
  },
  signatureBlock: {
    alignItems: 'center',
    width: '35%',
  },
  signatureLine: {
    width: '90%',
    borderTopWidth: 0.5,
    borderTopColor: colors.black,
    borderTopStyle: 'dashed' as const,
    marginTop: 28,
    paddingTop: 4,
  },
  signatureLabel: {
    fontSize: 9,
    fontWeight: 'bold',
    color: colors.darkGray,
    textAlign: 'center',
  },
  signatureSub: {
    fontSize: 8,
    color: colors.lightGray,
    textAlign: 'center',
  },

  /* ─── Footer ─── */
  pageFooter: {
    position: 'absolute',
    bottom: mm(5),
    left: mm(15),
    right: mm(15),
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 0.5,
    borderTopColor: colors.border,
    paddingTop: 4,
  },
  footerText: {
    fontSize: 7,
    color: colors.lightGray,
  },
})

/** Zero-width space — appended to Thai text to prevent last-char clipping in @react-pdf */
const Z = '\u200B'

/* ─── Component ─── */
export default function TaxInvoicePDF(props: TaxInvoicePDFProps) {
  const {
    company,
    invoiceNo,
    invoiceDate,
    dueDate,
    paymentTerms,
    customerName,
    customerAddress,
    customerTaxId,
    customerBranch,
    customerPhone,
    customerEmail,
    items,
    subtotal,
    vatRate,
    vatAmount,
    grandTotal,
    refBillNo,
    isCopy = false,
  } = props

  const comp = companyData[company]

  /* Fill items to TOTAL_ROWS */
  const filledItems: TaxInvoiceItem[] = [...items]
  while (filledItems.length < TOTAL_ROWS) {
    filledItems.push({ description: '', quantity: 0, unitPrice: 0, amount: 0 })
  }

  /* Format date */
  const fmtDate = (d?: string) =>
    d
      ? new Date(d).toLocaleDateString('th-TH', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : '-'

  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* ─── Header ─── */}
        <View style={s.headerSection}>
          {/* Seller Info */}
          <View style={s.sellerBlock}>
            <Text style={s.sellerName}>{comp.name + Z}</Text>
            {comp.nameEn && <Text style={s.sellerNameEn}>{comp.nameEn + Z}</Text>}
            <Text style={s.sellerDetail}>{comp.address + Z}</Text>
            <Text style={s.sellerDetail}>{'เลขประจำตัวผู้เสียภาษี: ' + comp.taxId + Z}</Text>
            <Text style={s.sellerDetail}>
              {comp.branch + ' | โทร: ' + comp.phone + Z}
            </Text>
          </View>

          {/* Document Type Badge */}
          <View style={s.titleBlock}>
            <View style={s.docTypeBadge}>
              <Text style={s.docTypeText}>{'ใบกำกับภาษี' + Z}</Text>
              <Text style={s.docTypeSubText}>{'TAX INVOICE' + Z}</Text>
            </View>
            {isCopy && <Text style={s.copyBadge}>{'สำเนา / COPY' + Z}</Text>}
            {!isCopy && <Text style={s.copyBadge}>{'ต้นฉบับ / ORIGINAL' + Z}</Text>}
          </View>
        </View>

        {/* ─── Document Info ─── */}
        <View style={s.docInfoSection}>
          <View style={s.docInfoTable}>
            <View style={s.docInfoRow}>
              <Text style={s.docInfoLabel}>{'เลขที่ / No.' + Z}</Text>
              <Text style={s.docInfoValue}>{invoiceNo + Z}</Text>
            </View>
            <View style={s.docInfoRow}>
              <Text style={s.docInfoLabel}>{'วันที่ / Date' + Z}</Text>
              <Text style={s.docInfoValue}>{fmtDate(invoiceDate) + Z}</Text>
            </View>
            {dueDate && (
              <View style={s.docInfoRow}>
                <Text style={s.docInfoLabel}>{'ครบกำหนด / Due' + Z}</Text>
                <Text style={s.docInfoValue}>{fmtDate(dueDate) + Z}</Text>
              </View>
            )}
            {paymentTerms && (
              <View style={s.docInfoRow}>
                <Text style={s.docInfoLabel}>{'เงื่อนไข / Terms' + Z}</Text>
                <Text style={s.docInfoValue}>{paymentTerms + Z}</Text>
              </View>
            )}
            {refBillNo && (
              <View style={s.docInfoRow}>
                <Text style={s.docInfoLabel}>{'อ้างอิง / Ref.' + Z}</Text>
                <Text style={s.docInfoValue}>{refBillNo + Z}</Text>
              </View>
            )}
          </View>
        </View>

        {/* ─── Buyer Info ─── */}
        <View style={s.buyerSection}>
          <Text style={s.buyerTitle}>{'ข้อมูลผู้ซื้อ / BUYER INFORMATION' + Z}</Text>
          <View style={s.buyerGrid}>
            <View style={s.buyerRow}>
              <Text style={s.buyerLabel}>{'ชื่อ / Name:' + Z}</Text>
              <Text style={s.buyerValue}>{customerName + Z}</Text>
            </View>
            <View style={s.buyerRow}>
              <Text style={s.buyerLabel}>{'ที่อยู่ / Address:' + Z}</Text>
              <Text style={s.buyerValue}>{customerAddress + Z}</Text>
            </View>
            <View style={s.buyerHalfRow}>
              <Text style={s.buyerHalfLabel}>{'เลขผู้เสียภาษี:' + Z}</Text>
              <Text style={s.buyerValue}>{(customerTaxId || '-') + Z}</Text>
            </View>
            <View style={s.buyerHalfRow}>
              <Text style={s.buyerHalfLabel}>{'สาขา:' + Z}</Text>
              <Text style={s.buyerValue}>{(customerBranch || 'สำนักงานใหญ่') + Z}</Text>
            </View>
            {(customerPhone || customerEmail) && (
              <>
                <View style={s.buyerHalfRow}>
                  <Text style={s.buyerHalfLabel}>{'โทร:' + Z}</Text>
                  <Text style={s.buyerValue}>{(customerPhone || '-') + Z}</Text>
                </View>
                <View style={s.buyerHalfRow}>
                  <Text style={s.buyerHalfLabel}>{'อีเมล:' + Z}</Text>
                  <Text style={s.buyerValue}>{(customerEmail || '-') + Z}</Text>
                </View>
              </>
            )}
          </View>
        </View>

        {/* ─── Items Table ─── */}
        <View style={s.table}>
          {/* Header */}
          <View style={s.tableHeaderRow}>
            <Text style={[s.tableHeaderCell, s.colNo]}>{'#' + Z}</Text>
            <Text style={[s.tableHeaderCell, s.colDesc]}>{'รายละเอียด / Description' + Z}</Text>
            <Text style={[s.tableHeaderCell, s.colQty]}>{'จำนวน' + Z}</Text>
            <Text style={[s.tableHeaderCell, s.colUnit]}>{'ราคาต่อหน่วย' + Z}</Text>
            <Text style={[s.tableHeaderCell, s.colAmount]}>{'จำนวนเงิน' + Z}</Text>
            <Text style={[s.tableHeaderCell, s.colVat]}>{'ภาษี' + Z}</Text>
          </View>

          {/* Body */}
          {filledItems.map((row, idx) => {
            const hasData = row.description && row.quantity > 0
            const rowStyle = idx % 2 === 1 ? s.tableBodyRowAlt : s.tableBodyRow
            const rowVat = hasData ? (row.amount * vatRate) / 100 : 0
            return (
              <View key={idx} style={rowStyle}>
                <Text style={[s.tableCell, s.colNo, { textAlign: 'center' }]}>
                  {hasData ? (idx + 1).toString() : ' '}
                </Text>
                <Text style={[s.tableCell, s.colDesc, { paddingLeft: mm(2) }]}>
                  {(row.description || ' ') + Z}
                </Text>
                <Text style={[s.tableCell, s.colQty, { textAlign: 'center' }]}>
                  {hasData ? row.quantity.toString() : ' '}
                </Text>
                <Text style={[s.tableCell, s.colUnit, { textAlign: 'right', paddingRight: mm(1) }]}>
                  {hasData ? formatCurrency(row.unitPrice) : ' '}
                </Text>
                <Text style={[s.tableCell, s.colAmount, { textAlign: 'right', paddingRight: mm(1) }]}>
                  {hasData ? formatCurrency(row.amount) : ' '}
                </Text>
                <Text style={[s.tableCell, s.colVat, { textAlign: 'right', paddingRight: mm(1) }]}>
                  {hasData ? formatCurrency(rowVat) : ' '}
                </Text>
              </View>
            )
          })}
        </View>

        {/* ─── Summary ─── */}
        <View style={s.summarySection}>
          {/* Baht Text */}
          <View style={s.bahtTextBox}>
            <Text style={s.bahtTextLabel}>{'จำนวนเงินรวมทั้งสิ้น (ตัวอักษร)' + Z}</Text>
            <Text style={s.bahtTextValue}>{bahtText(grandTotal) + Z}</Text>
          </View>

          {/* Summary Table */}
          <View style={s.summaryTable}>
            <View style={s.summaryRow}>
              <Text style={s.summaryLabel}>{'รวมเป็นเงิน / Subtotal' + Z}</Text>
              <Text style={s.summaryValue}>{formatCurrency(subtotal) + ' บาท' + Z}</Text>
            </View>
            <View style={s.summaryRow}>
              <Text style={s.summaryLabel}>{'ภาษีมูลค่าเพิ่ม ' + vatRate + '%' + Z}</Text>
              <Text style={s.summaryValue}>{formatCurrency(vatAmount) + ' บาท' + Z}</Text>
            </View>
            <View style={s.grandTotalRow}>
              <Text style={s.grandTotalLabel}>{'จำนวนเงินรวมทั้งสิ้น' + Z}</Text>
              <Text style={s.grandTotalValue}>{formatCurrency(grandTotal) + ' บาท' + Z}</Text>
            </View>
          </View>
        </View>

        {/* ─── Signatures ─── */}
        <View style={s.signatureSection}>
          <View style={s.signatureBlock}>
            <View style={s.signatureLine} />
            <Text style={s.signatureLabel}>{'ผู้รับบริการ / ผู้ซื้อ' + Z}</Text>
            <Text style={s.signatureSub}>{'Customer' + Z}</Text>
          </View>
          <View style={s.signatureBlock}>
            <View style={s.signatureLine} />
            <Text style={s.signatureLabel}>{'ผู้จัดทำ' + Z}</Text>
            <Text style={s.signatureSub}>{'Prepared by' + Z}</Text>
          </View>
          <View style={s.signatureBlock}>
            <View style={s.signatureLine} />
            <Text style={s.signatureLabel}>{'ผู้อนุมัติ' + Z}</Text>
            <Text style={s.signatureSub}>{'Approved by' + Z}</Text>
          </View>
        </View>

        {/* ─── Page Footer ─── */}
        <View style={s.pageFooter}>
          <Text style={s.footerText}>
            {comp.name + ' | เลขผู้เสียภาษี: ' + comp.taxId + Z}
          </Text>
          <Text style={s.footerText}>{'เอกสารนี้ออกโดยระบบอิเล็กทรอนิกส์' + Z}</Text>
        </View>
      </Page>
    </Document>
  )
}
