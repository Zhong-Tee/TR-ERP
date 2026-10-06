export const BORROW_OPEN_STATUSES = ['pending', 'approved', 'partial_returned', 'overdue']

export function borrowLocalDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function borrowDefaultStartDate(oldestCreatedAt?: string | null, now = new Date()): string {
  const monthStart = `${borrowLocalDate(now).slice(0, 7)}-01`
  const oldestDate = oldestCreatedAt ? borrowLocalDate(new Date(oldestCreatedAt)) : null
  return oldestDate && oldestDate < monthStart ? oldestDate : monthStart
}

export function isBorrowOverdue(dueDate: string, status: string, today = borrowLocalDate()): boolean {
  return BORROW_OPEN_STATUSES.includes(status) && dueDate < today
}
