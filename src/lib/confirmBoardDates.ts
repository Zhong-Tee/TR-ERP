export function bangkokDateKey(value: Date | string = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value))
  const part = (type: string) => parts.find((item) => item.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function confirmBoardDefaultStart(oldestPendingAt?: string | null, today = bangkokDateKey()): string {
  const monthStart = `${today.slice(0, 7)}-01`
  const oldestDay = oldestPendingAt ? bangkokDateKey(oldestPendingAt) : monthStart
  return oldestDay < monthStart ? oldestDay : monthStart
}
