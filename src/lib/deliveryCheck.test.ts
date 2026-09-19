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
})
