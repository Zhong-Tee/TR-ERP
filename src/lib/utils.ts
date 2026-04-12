export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('th-TH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

export function formatDateTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleString('th-TH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const BANGKOK_IANA = 'Asia/Bangkok'

/**
 * Inclusive UTC ISO bounds for one calendar day in Asia/Bangkok (timestamptz filters, e.g. created_at).
 */
export function getBangkokCalendarDayUtcBoundsISO(referenceDate: Date = new Date()): { startIso: string; endIso: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BANGKOK_IANA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = formatter.formatToParts(referenceDate)
  const y = parts.find((p) => p.type === 'year')?.value
  const m = parts.find((p) => p.type === 'month')?.value
  const d = parts.find((p) => p.type === 'day')?.value
  if (!y || !m || !d) {
    const fallback = referenceDate.toISOString().slice(0, 10)
    const start = `${fallback}T00:00:00+07:00`
    const end = `${fallback}T23:59:59.999+07:00`
    return { startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() }
  }
  const startLocal = `${y}-${m}-${d}T00:00:00+07:00`
  const endLocal = `${y}-${m}-${d}T23:59:59.999+07:00`
  return { startIso: new Date(startLocal).toISOString(), endIso: new Date(endLocal).toISOString() }
}
