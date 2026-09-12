/**
 * YYYY-MM-DD in the user's local calendar — matches <input type="date"> value.
 * Prefer this over Date#toISOString().slice(0, 10) for "business dates" (avoids UTC day skew).
 */
export function localISODate(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
