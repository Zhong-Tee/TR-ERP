/**
 * แปลข้อความ error จาก Supabase Auth เป็นภาษาไทย
 *
 * Supabase คืน message เป็นภาษาอังกฤษเสมอ (เช่น "Invalid login credentials")
 * ซึ่งผู้ใช้งานหน้าร้าน/โรงงานอ่านไม่เข้าใจ จึงจับคู่เป็นข้อความไทยก่อนแสดงผล
 * รูปแบบใหม่ของ supabase-js มี error.code มาด้วย จึงเช็ค code ก่อน แล้วค่อย fallback ที่ message
 */

/** code → ข้อความไทย (supabase-js v2.x ขึ้นไปส่ง code มาให้) */
const BY_CODE: Record<string, string> = {
  invalid_credentials: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  email_not_confirmed: 'อีเมลนี้ยังไม่ได้ยืนยัน กรุณาติดต่อผู้ดูแลระบบ',
  user_not_found: 'ไม่พบผู้ใช้นี้ในระบบ',
  user_banned: 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
  email_provider_disabled: 'ระบบปิดการเข้าสู่ระบบด้วยอีเมลชั่วคราว กรุณาติดต่อผู้ดูแลระบบ',
  over_request_rate_limit: 'พยายามบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
  over_email_send_rate_limit: 'ส่งอีเมลถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
  weak_password: 'รหัสผ่านคาดเดาง่ายเกินไป กรุณาตั้งรหัสผ่านที่ปลอดภัยกว่านี้',
  same_password: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม',
  otp_expired: 'รหัส/ลิงก์หมดอายุแล้ว กรุณาขอใหม่อีกครั้ง',
  mfa_verification_failed: 'รหัส OTP ไม่ถูกต้อง กรุณาลองใหม่',
  mfa_challenge_expired: 'รหัส OTP หมดอายุ กรุณากรอกรหัสใหม่จากแอป',
  session_not_found: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  session_expired: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
}

/** ข้อความบางส่วน (ตัวพิมพ์เล็ก) → ข้อความไทย สำหรับ error ที่ไม่มี code */
const BY_MESSAGE: [string, string][] = [
  ['invalid login credentials', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'],
  ['email not confirmed', 'อีเมลนี้ยังไม่ได้ยืนยัน กรุณาติดต่อผู้ดูแลระบบ'],
  ['user not found', 'ไม่พบผู้ใช้นี้ในระบบ'],
  ['user is banned', 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ'],
  ['email logins are disabled', 'ระบบปิดการเข้าสู่ระบบด้วยอีเมลชั่วคราว กรุณาติดต่อผู้ดูแลระบบ'],
  ['email rate limit exceeded', 'ส่งอีเมลถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'],
  ['for security purposes', 'พยายามบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่'],
  ['request rate limit', 'พยายามบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่'],
  ['password should be at least', 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร'],
  ['new password should be different', 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม'],
  ['invalid totp code', 'รหัส OTP ไม่ถูกต้อง กรุณาลองใหม่'],
  ['invalid one-time password', 'รหัส OTP ไม่ถูกต้อง กรุณาลองใหม่'],
  ['token has expired or is invalid', 'รหัส/ลิงก์หมดอายุแล้ว กรุณาขอใหม่อีกครั้ง'],
  ['auth session missing', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'],
  ['session from session id claim in jwt does not exist', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'],
  // เน็ตหลุด/เข้าเซิร์ฟเวอร์ไม่ได้ — fetch โยน TypeError ข้อความนี้
  ['failed to fetch', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'],
  ['network', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'],
]

/**
 * @param err  error จาก supabase.auth.*
 * @param fallback ข้อความเมื่อไม่รู้จัก error นั้น
 */
export function authErrorMessage(err: any, fallback = 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง'): string {
  const code = typeof err?.code === 'string' ? err.code : ''
  if (code && BY_CODE[code]) return BY_CODE[code]

  const message = typeof err?.message === 'string' ? err.message.toLowerCase() : ''
  if (message) {
    const hit = BY_MESSAGE.find(([needle]) => message.includes(needle))
    if (hit) return hit[1]
  }

  return fallback
}
