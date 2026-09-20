import { describe, expect, it } from 'vitest'
import {
  isConsignmentOrderNo,
  normalizeDeliveryKey,
  parseDeliveryWorksheetRows,
} from './deliveryCheck'

const headers = ['PU time', 'Order No.', 'Tracking No.', 'Sender', 'Consignee', 'Consignee phone', 'Consignee address']

describe('delivery check import', () => {
  it('cleans hidden whitespace and preserves leading zero in phone numbers', () => {
    const parsed = parseDeliveryWorksheetRows([
      headers,
      ['\t2026-09-04 19:03:42', '\tPUMP26090039', ' TH31019495UU8E ', 'Pump21', 'ลูกค้า', '\t0955032464', 'อุบลราชธานี'],
    ])
    expect(parsed.rows[0]).toMatchObject({
      order_no: 'PUMP26090039',
      tracking_no: 'TH31019495UU8E',
      consignee_phone: '0955032464',
      is_consignment: false,
      note: null,
    })
    expect(parsed.pickupDateFrom).toBe('2026-09-04')
  })

  it('classifies a blank order number as consignment with an empty note', () => {
    const parsed = parseDeliveryWorksheetRows([
      headers,
      ['2026-09-04 19:03:11', '\t', 'TH15019491Z53H', 'MIRAI', 'นิภาพร', '0930907482', 'นครปฐม'],
    ])
    expect(parsed.rows[0]).toMatchObject({ is_consignment: true, note: null })
  })

  it('uses the Moshi order text as the consignment note', () => {
    const parsed = parseDeliveryWorksheetRows([
      headers,
      ['2026-09-04 19:00:07', '46. Moshi อยุธยา', 'TH050194ADXT8Q', 'Wanyen', 'จิรัติกาล', '0928067279', 'อยุธยา'],
    ])
    expect(parsed.rows[0]).toMatchObject({ is_consignment: true, note: '46. Moshi อยุธยา' })
  })

  it('normalizes tracking keys consistently', () => {
    expect(normalizeDeliveryKey(' th 01\u200b 23 ')).toBe('TH0123')
    expect(isConsignmentOrderNo('PUMP26090039')).toBe(false)
  })

  it('reads the new Thai carrier export and preserves pickup status from column AH', () => {
    const newHeaders = [
      'เวลาสร้าง', 'Order status', 'เลขออเดอร์', 'เลขพัสดุ', 'เลขพัสดุย่อย',
      'ที่มา', 'ที่มารอง', 'ชื่อผู้ส่ง', 'เบอร์ผู้ส่ง', 'ที่อยู่ผู้ส่ง', 'ชื่อผู้รับ',
      'เบอร์ผู้รับ', 'เบอร์สำรองผู้รับ', 'ที่อยู่ที่รับ',
      ...Array.from({ length: 19 }, (_, index) => `คอลัมน์ ${index + 15}`),
      'สถานะงานรับ',
    ]
    const row = Array.from({ length: 34 }, () => '')
    row[0] = '2026-09-04 14:13:47'
    row[2] = 'FBTR26090034'
    row[3] = 'TH0140949TUE5B'
    row[7] = 'TRKIDSSHOP'
    row[10] = 'ปราณี ศิริโวหาร'
    row[11] = '0968918738'
    row[13] = 'ลาดพร้าว กรุงเทพ 10230'
    row[33] = 'ยังไม่ได้รับพัสดุ'

    const parsed = parseDeliveryWorksheetRows([newHeaders, row], '0')

    expect(parsed.rows[0]).toMatchObject({
      order_no: 'FBTR26090034',
      tracking_no: 'TH0140949TUE5B',
      pickup_status: 'ยังไม่ได้รับพัสดุ',
      is_consignment: false,
    })
    expect(parsed.rows[0].raw_data['สถานะงานรับ']).toBe('ยังไม่ได้รับพัสดุ')
    expect(parsed.pickupDateFrom).toBe('2026-09-04')
  })
})
