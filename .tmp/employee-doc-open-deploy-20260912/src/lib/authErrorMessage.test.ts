import { describe, it, expect } from 'vitest'
import { authErrorMessage } from './authErrorMessage'

describe('authErrorMessage', () => {
  it('รหัสผ่านผิด → ข้อความไทย', () => {
    expect(authErrorMessage({ message: 'Invalid login credentials' })).toBe('อีเมลหรือรหัสผ่านไม่ถูกต้อง')
    expect(authErrorMessage({ code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe(
      'อีเมลหรือรหัสผ่านไม่ถูกต้อง'
    )
  })

  it('code มาก่อน message', () => {
    expect(authErrorMessage({ code: 'user_banned', message: 'Invalid login credentials' })).toBe(
      'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ'
    )
  })

  it('ข้อความที่มีรายละเอียดต่อท้าย → จับได้จากบางส่วน', () => {
    expect(authErrorMessage({ message: 'For security purposes, you can only request this after 44 seconds' })).toBe(
      'พยายามบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่'
    )
    expect(authErrorMessage({ message: 'Password should be at least 6 characters' })).toBe(
      'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร'
    )
  })

  it('อีเมลซ้ำ → อธิบายวิธีตรวจสอบบัญชีเดิมเป็นภาษาไทย', () => {
    const expected = 'อีเมลนี้มีบัญชีอยู่ในระบบแล้ว กรุณาตรวจสอบรายชื่อผู้ใช้ หากไม่พบ โปรดติดต่อผู้ดูแลระบบเพื่อตรวจสอบบัญชีค้าง'
    expect(authErrorMessage({ message: 'A user with this email address has already been registered' })).toBe(expected)
    expect(authErrorMessage({ code: 'email_exists', message: 'User already registered' })).toBe(expected)
  })

  it('ข้อผิดพลาดการสร้างผู้ใช้ทั่วไป → แสดงคำแนะนำภาษาไทย', () => {
    expect(authErrorMessage({ message: 'Invalid email format' })).toBe('รูปแบบอีเมลไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่')
    expect(authErrorMessage({ message: 'Permission denied: superadmin only' })).toBe(
      'เฉพาะ Superadmin เท่านั้นที่สามารถเพิ่มผู้ใช้ได้'
    )
  })

  it('เน็ตหลุด → บอกให้เช็คอินเทอร์เน็ต', () => {
    expect(authErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'
    )
  })

  it('error ที่ไม่รู้จัก / ว่างเปล่า → ใช้ fallback', () => {
    expect(authErrorMessage({ message: 'Something odd happened' }, 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ')).toBe(
      'เกิดข้อผิดพลาดในการเข้าสู่ระบบ'
    )
    expect(authErrorMessage(undefined, 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ')).toBe('เกิดข้อผิดพลาดในการเข้าสู่ระบบ')
  })
})
