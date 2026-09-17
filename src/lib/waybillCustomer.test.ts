import { describe, expect, it } from 'vitest'
import { resolveWaybillCustomer } from './waybillCustomer'

describe('resolveWaybillCustomer', () => {
  it('uses the latest raw text for preview and reviewed fields for shipment', () => {
    const legacyBilling = {
      original_customer_address: 'น.ส.ณัสนันท์ บัวแจ้ง ที่อยู่เก่าจากการวางครั้งแรก 86000 โทร. 0825385140',
      address_line: '29/15 ซ.แปประสานสุข',
      sub_district: 'สะเตง',
      district: 'เมืองยะลา',
      province: 'ยะลา',
      postal_code: '95000',
      mobile_phone: '0848608431',
    }
    const result = resolveWaybillCustomer({
      customerAddress: 'ซูมิยะห์ อัซซอมาดีย์ 29/15 ยะลา 95000 โทร. 0848608431',
      recipientName: 'ซูมิยะห์ อัซซอมาดีย์',
      customerName: 'ช่องทาง FBTR',
      // Extra legacy JSON is ignored even before migration 532 removes it.
      billingDetails: legacyBilling,
      parsedAddress: '29/15 ซ.แปประสานสุข สะเตง เมืองยะลา ยะลา',
      parsedPostalCode: '95000',
      parsedPhones: ['0848608431'],
    })

    expect(result).toEqual({
      addressRaw: 'ซูมิยะห์ อัซซอมาดีย์ 29/15 ยะลา 95000 โทร. 0848608431',
      consigneeName: 'ซูมิยะห์ อัซซอมาดีย์',
      address: '29/15 ซ.แปประสานสุข สะเตง เมืองยะลา ยะลา',
      postalCode: '95000',
      phone1: '0848608431',
      phone2: '',
    })
  })

  it('keeps the phone from a legacy claim billing snapshot when exporting a waybill', () => {
    const result = resolveWaybillCustomer({
      customerAddress: '99/9 ต.ในเมือง อ.เมือง ขอนแก่น 40000',
      recipientName: 'ลูกค้าเคลม',
      customerName: 'ลูกค้าเดิม',
      billingDetails: {
        address_line: '99/9',
        sub_district: 'ในเมือง',
        district: 'เมืองขอนแก่น',
        province: 'ขอนแก่น',
        postal_code: '40000',
        mobilePhone: '0812345678',
      },
      parsedAddress: '99/9 ต.ในเมือง อ.เมือง ขอนแก่น',
      parsedPostalCode: '40000',
      parsedPhones: [],
    })

    expect(result.phone1).toBe('0812345678')
  })

  it('uses the newly confirmed claim address instead of inherited structured address fields', () => {
    const result = resolveWaybillCustomer({
      customerAddress: '88/8 ต.ใหม่ อ.เมือง เชียงใหม่ 50000',
      recipientName: 'ผู้รับเคลม',
      customerName: 'ลูกค้าเดิม',
      billingDetails: {
        address_line: '11/1 ที่อยู่บิลต้นฉบับ',
        district: 'เมืองขอนแก่น',
        province: 'ขอนแก่น',
        postal_code: '40000',
        mobile_phone: '0891234567',
      },
      parsedAddress: '88/8 ต.ใหม่ อ.เมือง เชียงใหม่',
      parsedPostalCode: '50000',
      parsedPhones: [],
      preferParsedAddress: true,
    })

    expect(result.address).toBe('88/8 ต.ใหม่ อ.เมือง เชียงใหม่')
    expect(result.postalCode).toBe('50000')
    expect(result.phone1).toBe('0891234567')
  })
})
