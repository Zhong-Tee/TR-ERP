import { describe, expect, it } from 'vitest'
import { formatAuditCreateError } from './auditApi'

describe('formatAuditCreateError', () => {
  it('แปลง Bad Request เป็นข้อความที่ผู้ใช้งานเข้าใจได้', () => {
    expect(formatAuditCreateError('snapshot', { message: 'Bad Request' }))
      .toBe('ระบบไม่สามารถส่งข้อมูล Audit จำนวนมากได้ในครั้งเดียว กรุณาลองใหม่อีกครั้ง')
  })

  it('ระบุขั้นตอนที่ทำงานไม่สำเร็จเมื่อ API ส่งรายละเอียดกลับมา', () => {
    expect(formatAuditCreateError('items', { message: 'connection timeout' }))
      .toBe('ไม่สามารถสร้างรายการตรวจนับในใบ Audit ได้: connection timeout')
  })

  it('แสดงปัญหาสิทธิ์เป็นภาษาไทย', () => {
    expect(formatAuditCreateError('header', { message: 'new row violates row-level security policy' }))
      .toBe('บัญชีนี้ไม่มีสิทธิ์สร้างหรือแก้ไขใบ Audit กรุณาตรวจสอบสิทธิ์ผู้ใช้งาน')
  })
})
