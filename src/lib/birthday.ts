const BANGKOK_MONTH_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Bangkok',
  month: 'numeric',
})

/** ตรวจว่าเดือนเกิดตรงกับเดือนปัจจุบันตามเวลาไทย โดยไม่ให้ timezone เปลี่ยนวันที่เกิด */
export function isBirthdayMonth(
  birthDate: string | null | undefined,
  referenceDate: Date = new Date(),
): boolean {
  const match = birthDate?.slice(0, 10).match(/^\d{4}-(\d{2})-\d{2}$/)
  if (!match) return false

  const birthMonth = Number(match[1])
  if (birthMonth < 1 || birthMonth > 12) return false

  return birthMonth === Number(BANGKOK_MONTH_FORMATTER.format(referenceDate))
}
