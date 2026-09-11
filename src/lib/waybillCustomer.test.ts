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
})
