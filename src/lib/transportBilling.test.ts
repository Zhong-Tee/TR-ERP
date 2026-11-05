import { describe, expect, it } from 'vitest'
import { billingSourceMetadata, isBillingSummaryRow, detectBillingColumns, groupWanyenShipments, parseBillingAmount, reconcileBilling, type BillingLine } from './transportBilling'
const line: BillingLine = { file: 'bill.xlsx', sheet: 'Sheet1', row: 2, tracking: 'ABC', order: '', amount: 100, consignment: false }
describe('transport billing reconciliation', () => {
  it('does not treat missing or invalid amounts as zero', () => {
    expect(parseBillingAmount('')).toBeNull()
    expect(parseBillingAmount('abc')).toBeNull()
    expect(parseBillingAmount('1,200.50')).toBe(1200.5)
    expect(parseBillingAmount('0')).toBe(0)
  })
  it('keeps shipment matching separate from rate verification', () => {
    const [result] = reconcileBilling([line], [], [{ id: '1', bill_no: 'FB1', channel_order_no: null, tracking_number: 'abc', status: 'จัดส่งแล้ว' }], [])
    expect(result.status).toBe('พบรายการจัดส่ง')
    expect(result.amountStatus).toBe('รอตรวจอัตรา')
  })
  it('compares Wanyen cost and detects unknown shipments', () => {
    expect(reconcileBilling([line], [{ ...line, amount: 80 }], [], [])[0].difference).toBe(20)
    expect(reconcileBilling([line], [], [], [])[0].status).toBe('ไม่พบใน ERP + Wanyen')
  })
  it('flags duplicate charges and preserves consignment evidence', () => {
    const result = reconcileBilling([line, { ...line, file: 'second.xlsx' }], [], [], [{ tracking_no: 'ABC', order_no: null }])
    expect(result.every(row => row.status === 'เรียกเก็บซ้ำ / ต้องตรวจ' && row.consignment)).toBe(true)
  })
  it('does not select arbitrary rates from ambiguous references', () => {
    const [result] = reconcileBilling([line], [line, { ...line, amount: 80 }], [], [])
    expect(result.status).toBe('ข้อมูลขัดแย้ง / ต้องตรวจ')
    expect(result.reference).toBeNull()
  })
})

describe('sample export formats', () => {
  it('detects Wanyen shipment columns without using quantities as costs', () => {
    expect(detectBillingColumns(['รหัสรายการจัดส่ง', 'สาขาปลายทาง', 'วันที่สร้าง', 'วันที่จัดส่ง', 'สถานะ', 'เลขพัสดุ', 'สินค้า', 'จำนวน', 'หน่วย', 'จำนวนแผ่นรายม้วน', 'หมายเหตุ'], 'wanyen')).toEqual({ tracking: '6', order: '2', amount: '', note: '11', shipment: '1' })
    expect(detectBillingColumns(['PU time', 'Order No.', 'Tracking No.', 'Sender', 'Consignee', 'Consignee phone', 'Consignee address', 'Freight'], 'bill').amount).toBe('8')
  })
  it('combines product rows for one shipment, including overlapping exports', () => {
    const product = { ...line, shipmentId: 'shipment-1', amount: null }
    const grouped = groupWanyenShipments([product, { ...product, row: 3 }, { ...product, file: 'overlap.xlsx' }])
    expect(grouped).toHaveLength(1)
    const [result] = reconcileBilling([line], [product, { ...product, row: 3 }], [], [])
    expect(result.source).toBe('Wanyen')
    expect(result.status).toBe('พบรายการจัดส่ง')
    expect(result.amountStatus).toBe('รอตรวจอัตรา')
  })
  it('preserves conflicts from different shipments sharing a tracking and repeated costs', () => {
    const product = { ...line, shipmentId: 'shipment-1', amount: null }
    expect(reconcileBilling([line], [product, { ...product, shipmentId: 'shipment-2' }], [], [])[0].status).toBe('ข้อมูลขัดแย้ง / ต้องตรวจ')
    expect(groupWanyenShipments([{ ...product, amount: 20 }, { ...product, amount: 20 }])).toHaveLength(2)
  })
})

describe('billing summary rows', () => {
  const columns = { tracking: '3', order: '2', amount: '8' }
  it('skips amount-only and labelled total rows', () => {
    expect(isBillingSummaryRow(['', '', '', '', '', '', '', '11873'], columns)).toBe(true)
    expect(isBillingSummaryRow(['ยอดรวม', '', '', '', '', '', '', '11873'], columns)).toBe(true)
  })
  it('keeps shipments including incomplete references for review', () => {
    expect(isBillingSummaryRow(['', '', 'TH123', '', '', '', '', '23'], columns)).toBe(false)
    expect(isBillingSummaryRow(['2026-10-31', '', '', '', 'ผู้รับ', '', '', '23'], columns)).toBe(false)
    expect(isBillingSummaryRow(['', '', '', '', '', '', '', 'invalid'], columns)).toBe(false)
  })
})

describe('billing source metadata', () => {
  it('preserves sender and the Bangkok pickup date from the carrier file', () => {
    expect(billingSourceMetadata(['PU time', 'Sender'], ['\t2026-10-31 18:51:38', ' Pump21 '])).toEqual({ sender: 'Pump21', pickupDate: '2026-10-31' })
  })
  it('does not invent missing metadata', () => {
    expect(billingSourceMetadata(['Tracking'], ['TH1'])).toEqual({ sender: '', pickupDate: '' })
  })
})
