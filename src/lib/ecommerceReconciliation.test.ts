import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  parseShopeeWorkbook,
  parseTikTokWorkbook,
  TIKTOK_REPORT_FEE_TYPE,
  TIKTOK_REPORT_TOTAL_TYPE,
  TIKTOK_WITHDRAWAL_TYPE,
} from './ecommerceReconciliation'

function workbook(sheetName: string, rows: unknown[][]): XLSX.WorkBook {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheetName)
  return book
}

describe('Shopee reconciliation imports', () => {
  it('aggregates item rows without duplicating order-level money', () => {
    const parsed = parseShopeeWorkbook(workbook('orders', [
      [
        'หมายเลขคำสั่งซื้อ', 'สถานะการสั่งซื้อ', 'เลขอ้างอิง SKU (SKU Reference No.)', 'ชื่อสินค้า',
        'ชื่อตัวเลือก', 'จำนวน', 'จำนวนที่ส่งคืน', 'ราคาตั้งต้น', 'ราคาขาย', 'ราคาขายสุทธิ',
        'จำนวนเงินทั้งหมด', 'ค่าคอมมิชชั่น', 'Transaction Fee', 'ค่าบริการ',
      ],
      ['ORDER-1', 'จัดส่งสำเร็จแล้ว', 'SKU-A', 'สินค้า A', 'แดง', 2, 0, 100, 90, 180, 230, 30, 7, 12],
      ['ORDER-1', 'จัดส่งสำเร็จแล้ว', 'SKU-B', 'สินค้า B', 'ฟ้า', 1, 0, 50, 50, 50, 230, 30, 7, 12],
    ]))

    expect(parsed.kind).toBe('orders')
    if (parsed.kind !== 'orders') return
    expect(parsed.orders).toHaveLength(1)
    expect(parsed.orders[0].lines).toHaveLength(2)
    expect(parsed.orders[0].merchandiseTotal).toBe(230)
    expect(parsed.orders[0].orderTotal).toBe(230)
    expect(parsed.orders[0].estimatedCommission).toBe(30)
    expect(parsed.orders[0].deliveryStatus).toBe('delivered')
  })

  it('keeps each Shopee fee category and calculates payout costs', () => {
    const parsed = parseShopeeWorkbook(workbook('Income', [
      [
        'หมายเลขคำสั่งซื้อ', 'สินค้าราคาปกติ', 'ส่วนลดสินค้าจากผู้ขาย', 'ค่าคอมมิชชั่น',
        'ค่าบริการ', 'ค่าธรรมเนียมโครงสร้างพื้นฐานแพลตฟอร์ม', 'ค่าธุรกรรมการชำระเงิน',
        'วันที่โอนชำระเงินสำเร็จ', 'จำนวนเงินทั้งหมดที่โอนแล้ว (฿)',
      ],
      ['ORDER-1', 200, -10, -30, -15, -1, -6, '2026-09-19', 138],
    ]))

    expect(parsed.kind).toBe('income')
    if (parsed.kind !== 'income') return
    expect(parsed.settlements).toHaveLength(1)
    expect(parsed.settlements[0].platformFeeTotal).toBe(52)
    expect(parsed.settlements[0].sellerCostTotal).toBe(62)
    expect(parsed.settlements[0].feeCategoryCount).toBe(4)
    expect(parsed.settlements[0].payoutAmount).toBe(138)
  })

  it('reads wallet transactions independently from settlement rows', () => {
    const parsed = parseShopeeWorkbook(workbook('Transaction Report', [
      ['วันที่', 'ประเภทการทำธุรกรรม', 'คำอธิบาย', 'รหัสคำสั่งซื้อ', 'รูปแบบธุรกรรม', 'จำนวนเงิน', 'สถานะ', 'ยอดเงินหลังทำธุรกรรมเสร็จสิ้น'],
      ['2026-09-19 10:00:00', 'รายรับจากคำสั่งซื้อ', 'ORDER-1', 'ORDER-1', 'เงินเข้า', 138, 'ทำรายการสำเร็จ', 1000],
    ]))

    expect(parsed.kind).toBe('balance')
    if (parsed.kind !== 'balance') return
    expect(parsed.transactions).toHaveLength(1)
    expect(parsed.transactions[0].orderNo).toBe('ORDER-1')
    expect(parsed.transactions[0].amount).toBe(138)
  })
})

describe('TikTok reconciliation imports', () => {
  it('accepts an empty delivered-order export', () => {
    const parsed = parseTikTokWorkbook(workbook('OrderSKUList', [['Order ID']]))

    expect(parsed.kind).toBe('orders')
    if (parsed.kind !== 'orders') return
    expect(parsed.orders).toEqual([])
  })

  it('groups TikTok order item rows and treats this export as shipped', () => {
    const parsed = parseTikTokWorkbook(workbook('OrderSKUList', [
      ['Order ID', 'Seller SKU', 'Product Name', 'Quantity', 'SKU Subtotal After Discount', 'Order Amount', 'Created Time', 'Delivered Time'],
      ['586115903910807017', 'SKU-A', 'สินค้า A', 1, 40, 62, '17/09/2026 12:30:00', '19/09/2026 09:00:00'],
      ['586115903910807017', 'SKU-B', 'สินค้า B', 2, 22, 62, '17/09/2026 12:30:00', '19/09/2026 09:00:00'],
    ]))

    expect(parsed.kind).toBe('orders')
    if (parsed.kind !== 'orders') return
    expect(parsed.orders).toHaveLength(1)
    expect(parsed.orders[0].lines).toHaveLength(2)
    expect(parsed.orders[0].deliveryStatus).toBe('shipping')
    expect(parsed.orders[0].merchandiseTotal).toBe(62)
    expect(parsed.orders[0].orderTotal).toBe(62)
  })

  it('reads TikTok income, fees and the order-level account credit from one file', () => {
    const parsed = parseTikTokWorkbook(workbook('รายละเอียดคำสั่งซื้อ', [
      [
        'หมายเลขคำสั่งซื้อ/การปรับ', 'ประเภทธุรกรรม', 'เวลาที่สร้างคำสั่งซื้อ', 'เวลาที่ชำระคำสั่งซื้อ',
        'ยอดการชำระเงินทั้งหมด', 'ยอดรวมค่าสินค้าก่อนหักส่วนลด', 'ส่วนลดจากร้านค้า',
        'ยอดรวมเงินคืนก่อนหักส่วนลดจากร้านค้า', 'ค่าธรรมเนียมทั้งหมด', 'ค่าธรรมเนียมคำสั่งซื้อ',
        'ค่าคอมมิชชัน TikTok Shop',
      ],
      ['586115903910807017', 'คำสั่งซื้อ', '2026/09/17', '2026/09/19', 50, 62, -4.02, 0, -8, -3, -5],
    ]))

    expect(parsed.kind).toBe('income')
    if (parsed.kind !== 'income') return
    expect(parsed.settlements).toHaveLength(1)
    expect(parsed.settlements[0].grossSales).toBe(62)
    expect(parsed.settlements[0].sellerDiscounts).toBe(-4.02)
    expect(parsed.settlements[0].platformFeeTotal).toBe(8)
    expect(parsed.settlements[0].payoutAmount).toBe(50)
    expect(parsed.settlements[0].settledAt).toBe('2026-09-19T00:00:00+07:00')
    expect(parsed.walletTransactions).toHaveLength(1)
    expect(parsed.walletTransactions?.[0].orderNo).toBe('586115903910807017')
    expect(parsed.walletTransactions?.[0].amount).toBe(50)
  })

  it('reads TikTok report total and completed withdrawal without assigning them to an order', () => {
    const book = workbook('รายละเอียดคำสั่งซื้อ', [
      ['หมายเลขคำสั่งซื้อ/การปรับ', 'ประเภทธุรกรรม', 'เวลาที่สร้างคำสั่งซื้อ', 'เวลาที่ชำระคำสั่งซื้อ', 'ยอดการชำระเงินทั้งหมด', 'ค่าธรรมเนียมทั้งหมด'],
      ['586115903910807017', 'คำสั่งซื้อ', '2026/09/17', '2026/09/19', 0, 0],
    ])
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['', 'ช่วงเวลา', '', '', '', '2026/09/19-2026/09/19'],
      ['', 'ยอดการชำระเงินทั้งหมด', '', '', '', 2619.75],
      ['', '', 'ค่าธรรมเนียมทั้งหมด', '', '', -935.98],
    ]), 'รายงาน')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['ประเภทธุรกรรม', 'ID อ้างอิง', 'เวลาส่งคำขอ', 'จำนวน', 'สถานะ', 'เวลาที่สำเร็จ'],
      ['Earnings', '3705390239404098983', '2026/09/19', 2619.75, 'Transferred', '2026/09/19'],
    ]), 'บันทึกการถอน')

    const parsed = parseTikTokWorkbook(book)
    expect(parsed.kind).toBe('income')
    if (parsed.kind !== 'income') return
    expect(parsed.reportFrom).toBe('2026-09-19')
    expect(parsed.reportTo).toBe('2026-09-19')
    expect(parsed.walletTransactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ transactionType: TIKTOK_REPORT_TOTAL_TYPE, orderNo: null, amount: 2619.75 }),
      expect.objectContaining({ transactionType: TIKTOK_REPORT_FEE_TYPE, orderNo: null, amount: 935.98 }),
      expect.objectContaining({ transactionType: TIKTOK_WITHDRAWAL_TYPE, orderNo: null, amount: 2619.75, status: 'Transferred' }),
    ]))
  })

  it('repairs an incorrect TikTok worksheet dimension before reading detail rows', () => {
    const book = workbook('รายละเอียดคำสั่งซื้อ', [
      ['หมายเลขคำสั่งซื้อ/การปรับ', 'ประเภทธุรกรรม', 'เวลาที่สร้างคำสั่งซื้อ', 'เวลาที่ชำระคำสั่งซื้อ', 'ยอดการชำระเงินทั้งหมด', 'ค่าธรรมเนียมทั้งหมด'],
      ['586100000000000001', 'คำสั่งซื้อ', '2026/09/18', '2026/09/20', 100, -20],
      ['586100000000000002', 'คำสั่งซื้อ', '2026/09/18', '2026/09/20', 200, -40],
    ])
    book.Sheets['รายละเอียดคำสั่งซื้อ']['!ref'] = 'A1:F2'

    const parsed = parseTikTokWorkbook(book)
    expect(parsed.kind).toBe('income')
    if (parsed.kind !== 'income') return
    expect(parsed.settlements).toHaveLength(2)
    expect(parsed.settlements.reduce((sum, row) => sum + row.payoutAmount, 0)).toBe(300)
  })
})
