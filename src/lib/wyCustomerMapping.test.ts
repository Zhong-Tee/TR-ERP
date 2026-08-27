import { describe, expect, it } from 'vitest'
import { mapWyCustomerFields } from './wyCustomerMapping'

describe('mapWyCustomerFields', () => {
  it('maps WY customer and recipient to their separate ERP fields', () => {
    expect(mapWyCustomerFields({
      ชื่อลูกค้า: 'ร้านตัวอย่าง',
      ชื่อ: 'พรรณทิพย์',
      นามสกุล: 'บุญเกิด',
      'ชื่อที่อยู่-เบอร์โทรผู้รับ': 'พรรณทิพย์ บุญเกิด, 0873586654, อยุธยา',
    })).toEqual({
      customerName: 'ร้านตัวอย่าง',
      recipientName: 'พรรณทิพย์ บุญเกิด',
    })
  })

  it('falls back to the name at the start of the combined recipient field', () => {
    expect(mapWyCustomerFields({
      ชื่อลูกค้า: 'ช่องทาง A',
      'ชื่อที่อยู่-เบอร์โทรผู้รับ': 'สมชาย ใจดี, 0812345678, กรุงเทพฯ',
    })).toEqual({
      customerName: 'ช่องทาง A',
      recipientName: 'สมชาย ใจดี',
    })
  })

  it('does not copy the channel customer name into recipient when recipient data is absent', () => {
    expect(mapWyCustomerFields({ ชื่อลูกค้า: 'ช่องทาง A' })).toEqual({
      customerName: 'ช่องทาง A',
      recipientName: '',
    })
  })
})
