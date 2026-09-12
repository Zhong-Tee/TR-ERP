import { describe, expect, it } from 'vitest'
import { getMissingCustomerShippingFields } from './orderCustomerValidation'

describe('getMissingCustomerShippingFields', () => {
  it('ไม่แจ้งช่องขาดเมื่อข้อมูลที่อยู่และเบอร์โทรครบ', () => {
    expect(getMissingCustomerShippingFields({
      address_line: '350 ถนน เจดีย์หัก',
      sub_district: 'เจดีย์หัก',
      district: 'เมืองราชบุรี',
      province: 'ราชบุรี',
      postal_code: '70000',
      mobile_phone: '0963924385',
    })).toEqual([])
  })

  it('แจ้งทุกช่องที่ว่างหรือมีแต่ช่องว่าง', () => {
    expect(getMissingCustomerShippingFields({
      address_line: '350 ถนน เจดีย์หัก',
      sub_district: '',
      district: '   ',
      province: '',
      postal_code: null,
      mobile_phone: '0963924385',
    })).toEqual(['แขวง/ตำบล', 'เขต/อำเภอ', 'จังหวัด', 'รหัสไปรษณีย์'])
  })

  it('บังคับชื่อผู้รับสำหรับช่องทางที่แยกชื่อช่องทางออกจากชื่อผู้รับ', () => {
    expect(getMissingCustomerShippingFields({
      recipient_name: '   ',
      address_line: '29/15 ซอยแปประสานสุข',
      sub_district: 'สะเตง',
      district: 'เมืองยะลา',
      province: 'ยะลา',
      postal_code: '95000',
      mobile_phone: '0848608431',
    }, { requireRecipientName: true })).toEqual(['ชื่อผู้รับ'])
  })
})
