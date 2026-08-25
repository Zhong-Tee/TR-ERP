const CUT_DELAY_DEPARTMENTS = new Set(['เบิก', 'STK', 'CTT', 'TUBE'])

/** Earliest department start derived from the work-order cut time. */
export function getCutReadySec(department: string, cutSec: number): number | null {
  if (!Number.isFinite(cutSec)) return null
  return cutSec + (CUT_DELAY_DEPARTMENTS.has(department) ? 5 * 60 : 0)
}

/** QC can start only after every required production department has finished. */
export function getQcReadySec(finishTimes: number[]): number | null {
  const validTimes = finishTimes.filter((time) => Number.isFinite(time) && time > 0)
  return validTimes.length > 0 ? Math.max(...validTimes) : null
}
