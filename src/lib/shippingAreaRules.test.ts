import { describe, expect, it } from 'vitest'
import { calculateShippingCharge, findShippingAreaRule, shippingAreaRuleMatches, type ShippingAreaRule } from './shippingAreaRules'

const base: ShippingAreaRule = {
  id: 'r1', carrier: 'Flash Express', area_type: 'remote', channel_codes: [], postal_code: '71180',
  province: 'กาญจนบุรี', district: 'ทองผาภูมิ', sub_district: null, surcharge: 50,
  is_forever: true, start_date: null, end_date: null, is_active: true,
}

describe('shipping area rules', () => {
  it('จับคู่ชื่อที่มีคำนำหน้าและช่องว่างต่างกันได้', () => {
    expect(shippingAreaRuleMatches(base, {
      carrier: 'Flash Express', channel_code: 'FBTR', postal_code: '71180', province: 'จังหวัดกาญจนบุรี',
      district: 'อำเภอทองผาภูมิ', sub_district: 'ปิล๊อก', order_date: '2026-09-18',
    })).toBe(true)
  })

  it('เลือกกฎระดับตำบลก่อนกฎทั้งอำเภอ', () => {
    const subDistrictRule: ShippingAreaRule = { ...base, id: 'r2', sub_district: 'ปิล๊อก', surcharge: 80 }
    const matched = findShippingAreaRule([base, subDistrictRule], {
      channel_code: 'FBTR', postal_code: '71180', province: 'กาญจนบุรี', district: 'ทองผาภูมิ', sub_district: 'ปิล๊อก',
    })
    expect(matched?.id).toBe('r2')
  })

  it('เลือกกฎเฉพาะช่องทางก่อนกฎทุกช่องทาง', () => {
    const channelRule: ShippingAreaRule = { ...base, id: 'r2', channel_codes: ['OATR'], surcharge: 70 }
    expect(findShippingAreaRule([base, channelRule], {
      channel_code: 'OATR', postal_code: '71180', province: 'กาญจนบุรี', district: 'ทองผาภูมิ',
    })?.id).toBe('r2')
    expect(findShippingAreaRule([base, channelRule], {
      channel_code: 'FBTR', postal_code: '71180', province: 'กาญจนบุรี', district: 'ทองผาภูมิ',
    })?.id).toBe('r1')
  })

  it('ไม่ใช้กฎนอกช่วงวันที่และกฎที่ปิด', () => {
    expect(shippingAreaRuleMatches({ ...base, is_forever: false, start_date: '2026-10-01', end_date: '2026-10-31' }, {
      postal_code: '71180', province: 'กาญจนบุรี', district: 'ทองผาภูมิ', order_date: '2026-09-18',
    })).toBe(false)
    expect(shippingAreaRuleMatches({ ...base, is_active: false }, {
      postal_code: '71180', province: 'กาญจนบุรี', district: 'ทองผาภูมิ',
    })).toBe(false)
  })

  it('ไม่ใช้กฎของผู้ให้บริการอื่นเมื่อระบุผู้ให้บริการของช่องทาง', () => {
    expect(shippingAreaRuleMatches(base, {
      carrier: 'OTHER', postal_code: '71180', province: 'กาญจนบุรี', district: 'ทองผาภูมิ',
    })).toBe(false)
    expect(shippingAreaRuleMatches(base, {
      carrier: 'FLASH', postal_code: '71180', province: 'กาญจนบุรี', district: 'ทองผาภูมิ',
    })).toBe(true)
  })

  it('ส่งฟรีลดเฉพาะค่าส่งตามยอดซื้อและยังเก็บค่าพื้นที่พิเศษ', () => {
    expect(calculateShippingCharge(30, 50, true)).toEqual({
      standard_shipping_fee: 30,
      charged_standard_fee: 0,
      special_area_surcharge: 50,
      total_shipping_fee: 50,
    })
  })
})
