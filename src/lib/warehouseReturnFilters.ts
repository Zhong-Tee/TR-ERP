export type ReturnStatusFilter = 'all' | 'pending' | 'return_to_stock' | 'waste'
export interface ReturnDateRange { start: string; end: string }
interface ReturnFilterRow { created_at: string; status: string; disposition?: string | null }

export function returnDateBounds(range: ReturnDateRange) {
  const midnight = (value: string) => {
    const ms = Date.parse(`${value}T00:00:00+07:00`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(ms) || new Date(ms + 7 * 3600000).toISOString().slice(0, 10) !== value) throw new Error('กรุณาระบุวันที่ให้ถูกต้อง')
    return ms
  }
  const from = range.start ? midnight(range.start) : -Infinity
  const to = range.end ? midnight(range.end) + 86400000 : Infinity
  if (from >= to) throw new Error('วันที่เริ่มต้นต้องไม่มากกว่าวันที่สิ้นสุด')
  return { from, to }
}

export function filterReturnsByDate<T extends ReturnFilterRow>(rows: T[], range: ReturnDateRange): T[] {
  const { from, to } = returnDateBounds(range)
  if (!range.start && !range.end) return rows
  return rows.filter(row => { const time = Date.parse(row.created_at); return time >= from && time < to })
}

export function filterReturnsByStatus<T extends ReturnFilterRow>(rows: T[], status: ReturnStatusFilter): T[] {
  if (status === 'all') return rows
  if (status === 'pending') return rows.filter(row => row.status === 'pending')
  return rows.filter(row => row.status === 'received' && row.disposition === status)
}

export function returnStatusLabel(ret: Pick<ReturnFilterRow, 'status' | 'disposition'>) {
  if (ret.status !== 'received') return 'รอดำเนินการ'
  const labels: Record<string, string> = { return_to_stock: 'คืนกลับสต๊อค', waste: 'ตีเป็นของเสีย', lost: 'สูญหาย', mixed: 'แยกผลรายสินค้าแล้ว' }
  return labels[ret.disposition || ''] || 'รับแล้ว'
}

export function formatReturnDate(value: string) {
  if (!value) return '-'
  return new Date(value).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function returnExportFilename(status: ReturnStatusFilter, range: ReturnDateRange, now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const period = range.start || range.end ? `${range.start || 'เริ่มต้น'}_ถึง_${range.end || 'ล่าสุด'}` : 'ทุกช่วงเวลา'
  return `รับสินค้าตีกลับ_${status}_${period}_${date}.xlsx`
}
