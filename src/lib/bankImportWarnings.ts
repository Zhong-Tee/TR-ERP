/** Statement parsers save text warnings; the matcher also saves structured review warnings. */
export function formatBankImportWarning(warning: unknown): string {
  if (typeof warning === 'string') return warning
  if (warning && typeof warning === 'object') {
    const row = warning as { code?: string; message?: string }
    if (row.code === 'auto_match_failed') return 'นำเข้าข้อมูลแล้ว แต่จับคู่อัตโนมัติไม่สำเร็จ กรุณาตรวจสอบและลองจับคู่ใหม่'
    if (row.code === 'auto_match_skipped') return `ข้ามรายการจับคู่ที่ไม่สามารถบันทึกได้ กรุณาตรวจสอบ${row.message ? `: ${row.message}` : ''}`
    if (typeof row.message === 'string') return row.message
  }
  return 'พบคำเตือนจากการนำเข้า กรุณาตรวจสอบรายการ'
}
