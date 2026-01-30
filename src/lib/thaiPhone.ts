/**
 * Thai mobile phone: normalize, extract candidates, E.164 output.
 * Thai mobile: 0[6-9] + 8 digits (10 digits). With country: +66/66 + 9 digits.
 */

/** ลบช่องว่าง ยัติภังค์ วงเล็บ จุด ออกจากข้อความ */
export function normalizePhoneString(s: string): string {
  return (s ?? '').replace(/[\s\-\.()]/g, '')
}

/** E.164: +66xxxxxxxxx (9 หลักหลัง 66, ตัด 0 หน้าออกถ้าเป็นแบบ 0x) */
export function toE164(raw: string): string {
  const n = normalizePhoneString(raw)
  if (!n) return ''
  if (n.startsWith('+66')) return n.length >= 12 ? `+${n.slice(1, 12)}` : ''
  if (n.startsWith('66') && n.length >= 11) return `+${n.slice(0, 11)}`
  if (n.startsWith('0') && n.length >= 10 && /^0[6-9]\d{8}$/.test(n.slice(0, 10))) return `+66${n.slice(1, 10)}` // ตัด 0 หน้า
  return ''
}

/** แปลง E.164 (+66xxxxxxxxx) เป็นรูปแบบกรอกในฟอร์ม: 0 ตามด้วย 9 หลัก */
export function e164ToLocal(e164: string): string {
  if (!e164 || !e164.startsWith('+66')) return e164
  const nine = e164.slice(3).replace(/\D/g, '')
  return nine.length === 9 ? '0' + nine : e164
}

/** รูปแบบเบอร์ไทย 0[6-9] ตามด้วย 8 หลัก (รวม 10 หลัก) */
const THAI_MOBILE_REGEX = /(?:^|[^0-9])(0[6-9]\d{8})(?!\d)/g
/** รูปแบบรหัสประเทศ +66 หรือ 66 ตามด้วย 9 หลัก (ตัวแรก 6-9) */
const COUNTRY_CODE_REGEX = /(?:\+66|66)([6-9]\d{8})(?!\d)/g

/**
 * ดึงเบอร์โทรที่เป็น candidate จากข้อความ คืนค่า E.164 ไม่ซ้ำ ลำดับตามที่พบ
 * แยกรหัสไปรษณีย์ 5 หลักกับเบอร์ที่ติดกัน (เช่น 111200835671234) ให้มีช่องว่างก่อน match
 */
export function extractPhoneCandidates(text: string): string[] {
  let normalized = normalizePhoneString(text)
  if (!normalized) return []
  normalized = normalized.replace(/(\d{5})(0[6-9]\d{8})/g, '$1 $2')

  const seen = new Set<string>()
  const out: string[] = []

  let m: RegExpExecArray | null
  THAI_MOBILE_REGEX.lastIndex = 0
  while ((m = THAI_MOBILE_REGEX.exec(normalized)) !== null) {
    const e = toE164(m[1])
    if (e && !seen.has(e)) {
      seen.add(e)
      out.push(e)
    }
  }

  COUNTRY_CODE_REGEX.lastIndex = 0
  while ((m = COUNTRY_CODE_REGEX.exec(normalized)) !== null) {
    const full = m[0]
    const e = full.startsWith('+') ? (full.length >= 12 ? `+${full.slice(1, 12)}` : '') : toE164(full)
    if (e && !seen.has(e)) {
      seen.add(e)
      out.push(e)
    }
  }

  return out
}

/** สร้าง regex ที่ยอมรับช่องว่าง/ขีด/จุดระหว่างหลัก สำหรับ E.164 (เช่น +66812345678) */
function patternForE164(e164: string): RegExp {
  const digits = e164.replace(/\D/g, '')
  if (digits.length < 11) return /(?!)/ // never match
  const nine = digits.slice(2)
  const sep = '[\\s\\-\\.]*'
  const part = nine.split('').join(sep)
  return new RegExp(
    `(?:0|\\+?\\s*66\\s*)${sep}${part}|\\+?\\s*66\\s*${sep}${part}`,
    'gi'
  )
}

/** คำนำหน้าเบอร์: Tel / โทร (มีหรือไม่มีโคลอน) — ใช้เฉพาะเมื่ออยู่ติดหน้าหมายเลข */
const PHONE_PREFIX = '(?:Tel|โทร)\\s*:?\\s*'

/**
 * แยกเบอร์โทรจากข้อความ และคืนข้อความที่ตัดเบอร์ออกแล้ว (เหลือที่อยู่)
 * รองรับ: (1) มีแต่เบอร์ไม่มีคำว่าโทร (2) มี Tel หรือ โทร อยู่ด้านหน้าเบอร์
 * คืนค่า: { candidates: E.164[], rest: string } — default เลือก candidates[0]
 */
export function extractPhonesFromText(text: string): { candidates: string[]; rest: string } {
  const raw = (text ?? '').replace(/\r\n/g, '\n').replace(/\n/g, ' ').trim()
  if (!raw) return { candidates: [], rest: '' }

  const candidates = extractPhoneCandidates(raw)
  let rest = raw

  for (const e164 of candidates) {
    const phoneRe = patternForE164(e164)
    const withPrefix = new RegExp(PHONE_PREFIX + phoneRe.source, 'gi')
    rest = rest.replace(withPrefix, ' ')
    rest = rest.replace(phoneRe, ' ')
  }
  rest = rest.replace(/\s+/g, ' ').trim()

  return { candidates, rest }
}
