export type CustomerShippingDetails = {
  address_line?: string | null
  sub_district?: string | null
  district?: string | null
  province?: string | null
  postal_code?: string | null
  mobile_phone?: string | null
}

const REQUIRED_CUSTOMER_SHIPPING_FIELDS: Array<{
  key: keyof CustomerShippingDetails
  label: string
}> = [
  { key: 'address_line', label: 'ที่อยู่' },
  { key: 'sub_district', label: 'แขวง/ตำบล' },
  { key: 'district', label: 'เขต/อำเภอ' },
  { key: 'province', label: 'จังหวัด' },
  { key: 'postal_code', label: 'รหัสไปรษณีย์' },
  { key: 'mobile_phone', label: 'เบอร์โทรมือถือ' },
]

/** รายการข้อมูลจัดส่งที่ยังว่าง สำหรับป้องกันการบันทึกออเดอร์เป็น "ข้อมูลครบ" */
export function getMissingCustomerShippingFields(details: CustomerShippingDetails): string[] {
  return REQUIRED_CUSTOMER_SHIPPING_FIELDS
    .filter(({ key }) => !String(details[key] ?? '').trim())
    .map(({ label }) => label)
}
