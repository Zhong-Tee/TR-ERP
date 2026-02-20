import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer'
import './fontConfig'
import { mm, colors, bahtText, formatCurrency } from './styles'
import type { BillHeaderSetting } from '../../../types'

/* ─── Types ─── */
export interface TaxInvoiceItem {
  description: string
  quantity: number
  unitPrice: number
  amount: number
}

export interface TaxInvoicePDFProps {
  companyData: BillHeaderSetting
  invoiceNo: string
  invoiceDate: string
  orderNo?: string
  customerName: string
  customerAddress: string
  customerTaxId: string
  customerBranch?: string
  customerPhone?: string
  items: TaxInvoiceItem[]
  discount: number
  subtotal: number
  netAmount: number
  vatRate: number
  vatAmount: number
  grandTotal: number
  refDocNo?: string
  refDocDate?: string
  isCopy?: boolean
}

const TOTAL_ROWS = 18
const BLUE = '#2980b9'

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

  /* Header */
  headerSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: mm(4),
  },
  logoAndInfo: {
    flexDirection: 'row',
    width: '60%',
    alignItems: 'flex-start',
    gap: mm(3),
  },
  logo: {
    width: mm(20),
    height: mm(20),
    objectFit: 'contain' as const,
  },
  sellerBlock: {
    flex: 1,
  },
  sellerName: {
    fontSize: 12,
    fontWeight: 'bold',
    color: colors.accentDark,
    marginBottom: 1,
  },
  sellerNameEn: {
    fontSize: 8,
    color: colors.mediumGray,
    marginBottom: 3,
  },
  sellerDetail: {
    fontSize: 8,
    lineHeight: 1.8,
    color: colors.darkGray,
    marginBottom: 1,
  },
  titleBlock: {
    width: '38%',
    alignItems: 'flex-end',
  },
  docTypeBadge: {
    backgroundColor: BLUE,
    paddingHorizontal: mm(5),
    paddingVertical: mm(2),
    borderRadius: 3,
    marginBottom: mm(1),
  },
  docTypeText: {
    fontSize: 13,
    fontWeight: 'bold',
    color: colors.white,
    textAlign: 'center',
  },
  docTypeSubText: {
    fontSize: 8,
    color: colors.white,
    textAlign: 'center',
  },
  copyBadge: {
    fontSize: 8,
    color: colors.accent,
    fontWeight: 'bold',
    textAlign: 'right',
    marginBottom: 2,
  },
  orderNoBlock: {
    marginTop: mm(1),
    alignItems: 'flex-end',
  },
  orderNoLabel: {
    fontSize: 8,
    color: colors.mediumGray,
  },
  orderNoValue: {
    fontSize: 10,
    fontWeight: 'bold',
  },

  /* Document Info + Buyer side by side */
  infoSection: {
    flexDirection: 'row',
    marginBottom: mm(3),
    gap: mm(3),
  },
  buyerSection: {
    flex: 1,
    borderWidth: 0.5,
    borderColor: colors.border,
    borderRadius: 3,
    padding: mm(3),
    backgroundColor: '#fcfcfc',
  },
  docInfoBox: {
    width: mm(65),
    borderWidth: 0.5,
    borderColor: colors.border,
    borderRadius: 3,
    padding: mm(3),
    backgroundColor: '#fcfcfc',
  },
  docInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
    borderBottomWidth: 0.3,
    borderBottomColor: colors.border,
  },
  docInfoLabel: {
    fontSize: 8,
    fontWeight: 'bold',
    color: colors.mediumGray,
  },
  docInfoValue: {
    fontSize: 8,
    textAlign: 'right',
  },

  /* Ref Doc */
  refDocSection: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: mm(3),
  },
  refDocTable: {
    width: mm(65),
  },
  refDocRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
    borderBottomWidth: 0.3,
    borderBottomColor: colors.border,
  },
  refDocLabel: {
    fontSize: 8,
    fontWeight: 'bold',
    color: colors.mediumGray,
  },
  refDocValue: {
    fontSize: 8,
    textAlign: 'right',
  },

  /* Items Table */
  table: {
    width: '100%',
    borderWidth: 1,
    borderColor: colors.black,
    marginBottom: mm(3),
  },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: BLUE,
    borderBottomWidth: 1,
    borderBottomColor: colors.black,
  },
  thCell: {
    paddingVertical: 5,
    paddingHorizontal: 3,
    borderRightWidth: 1,
    borderRightColor: colors.black,
  },
  thCellLast: {
    paddingVertical: 5,
    paddingHorizontal: 3,
  },
  thText: {
    color: colors.white,
    fontSize: 8,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  tbRow: {
    flexDirection: 'row',
    minHeight: 18,
  },
  tdCell: {
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRightWidth: 1,
    borderRightColor: colors.black,
  },
  tdCellLast: {
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  tdText: {
    fontSize: 8,
  },

  /* Column widths */
  colNo: { width: '8%' },
  colDesc: { width: '42%' },
  colUnit: { width: '18%' },
  colQty: { width: '12%' },
  colAmount: { width: '20%' },

  /* Summary */
  summarySection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: mm(5),
  },
  bahtTextBox: {
    width: '50%',
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
    fontSize: 10,
    fontWeight: 'bold',
    color: colors.accentDark,
  },
  summaryTable: {
    width: '45%',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2.5,
    borderBottomWidth: 0.3,
    borderBottomColor: colors.border,
  },
  summaryLabel: {
    fontSize: 8,
    color: colors.darkGray,
  },
  summaryValue: {
    fontSize: 8,
    textAlign: 'right',
    fontWeight: 'bold',
  },
  grandTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
    backgroundColor: BLUE,
    paddingHorizontal: mm(2),
    borderRadius: 2,
    marginTop: 2,
  },
  grandTotalLabel: {
    fontSize: 10,
    fontWeight: 'bold',
    color: colors.white,
  },
  grandTotalValue: {
    fontSize: 10,
    fontWeight: 'bold',
    color: colors.white,
    textAlign: 'right',
  },

})

const Z = '\u200B'

/* ─── Component ─── */
export default function TaxInvoicePDF(props: TaxInvoicePDFProps) {
  const {
    companyData: comp,
    invoiceNo,
    invoiceDate,
    orderNo,
    customerName,
    customerAddress,
    customerTaxId,
    customerBranch,
    customerPhone,
    items,
    discount,
    subtotal,
    netAmount,
    vatRate,
    vatAmount,
    grandTotal,
    refDocNo,
    refDocDate,
    isCopy = false,
  } = props

  const filledItems: TaxInvoiceItem[] = [...items]
  while (filledItems.length < TOTAL_ROWS) {
    filledItems.push({ description: '', quantity: 0, unitPrice: 0, amount: 0 })
  }

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
          <View style={s.logoAndInfo}>
            {comp.logo_url && (
              <Image src={comp.logo_url} style={s.logo} />
            )}
            <View style={s.sellerBlock}>
              <Text style={s.sellerName}>{comp.company_name + Z}</Text>
              {comp.company_name_en && <Text style={s.sellerNameEn}>{comp.company_name_en + Z}</Text>}
              <Text style={s.sellerDetail}>{comp.address + Z}</Text>
              <Text style={s.sellerDetail}>{'เลขประจำตัวผู้เสียภาษีอากร ' + comp.tax_id + (comp.branch ? ' (' + comp.branch + ') ' : ' ') + Z}</Text>
              {comp.phone && <Text style={s.sellerDetail}>{'โทร: ' + comp.phone + Z}</Text>}
            </View>
          </View>

          <View style={s.titleBlock}>
            <View style={s.docTypeBadge}>
              <Text style={s.docTypeText}>{'ใบเสร็จรับเงิน/ใบกำกับภาษี' + Z}</Text>
              <Text style={s.docTypeSubText}>{'Receipt/Tax Invoice' + Z}</Text>
            </View>
            {isCopy && <Text style={s.copyBadge}>{'สำเนา / COPY' + Z}</Text>}
            {!isCopy && <Text style={s.copyBadge}>{'ต้นฉบับ / ORIGINAL' + Z}</Text>}
            {orderNo && (
              <View style={s.orderNoBlock}>
                <Text style={s.orderNoLabel}>{'ใบสั่งซื้อเลขที่ / ORDER NO.' + Z}</Text>
                <Text style={s.orderNoValue}>{orderNo + Z}</Text>
              </View>
            )}
          </View>
        </View>

        {/* ─── Buyer Info + Doc Info ─── */}
        <View style={s.infoSection}>
          <View style={s.buyerSection}>
            <View style={{ flexDirection: 'row', marginBottom: 4 }}>
              <Text style={{ fontSize: 8, fontWeight: 'bold', color: colors.accent }}>{'ผู้ซื้อ / BUYER : ' + Z}</Text>
              <Text style={{ fontSize: 8, flex: 1 }}>{customerName + Z}</Text>
            </View>
            <Text style={{ fontSize: 8, fontWeight: 'bold', color: colors.mediumGray, marginBottom: 2 }}>{'ที่อยู่ / ADDRESS : ' + Z}</Text>
            <Text style={{ fontSize: 8, lineHeight: 1.6, marginBottom: 4 }}>{customerAddress + Z}</Text>
            <View style={{ flexDirection: 'row', marginBottom: 4 }}>
              <View style={{ flexDirection: 'row', width: '50%' }}>
                <Text style={{ fontSize: 8, fontWeight: 'bold', color: colors.mediumGray }}>{'เลขผู้เสียภาษี : ' + Z}</Text>
                <Text style={{ fontSize: 8 }}>{(customerTaxId || '-') + Z}</Text>
              </View>
              <View style={{ flexDirection: 'row', width: '50%' }}>
                <Text style={{ fontSize: 8, fontWeight: 'bold', color: colors.mediumGray }}>{'สาขา : ' + Z}</Text>
                <Text style={{ fontSize: 8 }}>{(customerBranch || 'สำนักงานใหญ่') + Z}</Text>
              </View>
            </View>
            {customerPhone && (
              <View style={{ flexDirection: 'row' }}>
                <Text style={{ fontSize: 8, fontWeight: 'bold', color: colors.mediumGray }}>{'โทร : ' + Z}</Text>
                <Text style={{ fontSize: 8 }}>{customerPhone + Z}</Text>
              </View>
            )}
          </View>

          <View style={s.docInfoBox}>
            <View style={s.docInfoRow}>
              <Text style={s.docInfoLabel}>{'เลขที่เอกสาร / NO.' + Z}</Text>
              <Text style={s.docInfoValue}>{invoiceNo + Z}</Text>
            </View>
            <View style={s.docInfoRow}>
              <Text style={s.docInfoLabel}>{'วันที่ / DATE' + Z}</Text>
              <Text style={s.docInfoValue}>{fmtDate(invoiceDate) + Z}</Text>
            </View>
            {refDocNo && (
              <>
                <View style={{ marginTop: mm(2) }} />
                <View style={s.docInfoRow}>
                  <Text style={s.docInfoLabel}>{'อ้างอิงเอกสาร / REF. DOC NO.' + Z}</Text>
                  <Text style={s.docInfoValue}>{refDocNo + Z}</Text>
                </View>
                {refDocDate && (
                  <View style={s.docInfoRow}>
                    <Text style={s.docInfoLabel}>{'วันที่ / DATE' + Z}</Text>
                    <Text style={s.docInfoValue}>{fmtDate(refDocDate) + Z}</Text>
                  </View>
                )}
              </>
            )}
          </View>
        </View>

        {/* ─── Items Table ─── */}
        <View style={s.table}>
          <View style={s.tableHeaderRow}>
            <View style={[s.thCell, s.colNo]}><Text style={s.thText}>{'ลำดับ\nITEM' + Z}</Text></View>
            <View style={[s.thCell, s.colDesc]}><Text style={s.thText}>{'รายการ\nDESCRIPTION' + Z}</Text></View>
            <View style={[s.thCell, s.colUnit]}><Text style={s.thText}>{'ราคาต่อหน่วย\nUNIT PRICE' + Z}</Text></View>
            <View style={[s.thCell, s.colQty]}><Text style={s.thText}>{'จำนวน\nQUANTITY' + Z}</Text></View>
            <View style={[s.thCellLast, s.colAmount]}><Text style={s.thText}>{'จำนวนเงิน\nAMOUNT' + Z}</Text></View>
          </View>

          {filledItems.map((row, idx) => {
            const hasData = row.description && row.quantity > 0
            return (
              <View key={idx} style={s.tbRow}>
                <View style={[s.tdCell, s.colNo]}>
                  <Text style={[s.tdText, { textAlign: 'center' }]}>{hasData ? String(idx + 1) : ' '}</Text>
                </View>
                <View style={[s.tdCell, s.colDesc]}>
                  <Text style={s.tdText}>{(row.description || ' ') + Z}</Text>
                </View>
                <View style={[s.tdCell, s.colUnit]}>
                  <Text style={[s.tdText, { textAlign: 'center' }]}>{hasData ? formatCurrency(row.unitPrice) : ' '}</Text>
                </View>
                <View style={[s.tdCell, s.colQty]}>
                  <Text style={[s.tdText, { textAlign: 'center' }]}>{hasData ? String(row.quantity) : ' '}</Text>
                </View>
                <View style={[s.tdCellLast, s.colAmount]}>
                  <Text style={[s.tdText, { textAlign: 'center' }]}>{hasData ? formatCurrency(row.amount) : ' '}</Text>
                </View>
              </View>
            )
          })}
        </View>

        {/* ─── Summary ─── */}
        <View style={s.summarySection}>
          <View style={s.bahtTextBox}>
            <Text style={s.bahtTextLabel}>{'จำนวนเงินรวมทั้งสิ้น (ตัวอักษร)' + Z}</Text>
            <Text style={s.bahtTextValue}>{bahtText(grandTotal) + Z}</Text>
          </View>

          <View style={s.summaryTable}>
            {discount > 0 && (
              <View style={s.summaryRow}>
                <Text style={s.summaryLabel}>{'ส่วนลด / DISCOUNT' + Z}</Text>
                <Text style={s.summaryValue}>{formatCurrency(discount) + Z}</Text>
              </View>
            )}
            <View style={s.summaryRow}>
              <Text style={s.summaryLabel}>{'รวมเป็นเงิน / AMOUNT' + Z}</Text>
              <Text style={s.summaryValue}>{formatCurrency(subtotal) + Z}</Text>
            </View>
            <View style={s.summaryRow}>
              <Text style={s.summaryLabel}>{'มูลค่าสินค้าที่นำมาคิดภาษี / NET AMOUNT' + Z}</Text>
              <Text style={s.summaryValue}>{formatCurrency(netAmount) + Z}</Text>
            </View>
            <View style={s.summaryRow}>
              <Text style={s.summaryLabel}>{'ภาษีมูลค่าเพิ่ม / VAT ' + vatRate + '%' + Z}</Text>
              <Text style={s.summaryValue}>{formatCurrency(vatAmount) + Z}</Text>
            </View>
            <View style={s.grandTotalRow}>
              <Text style={s.grandTotalLabel}>{'รวมจำนวนเงิน / TOTAL AMOUNT' + Z}</Text>
              <Text style={s.grandTotalValue}>{formatCurrency(grandTotal) + Z}</Text>
            </View>
          </View>
        </View>

      </Page>
    </Document>
  )
}
