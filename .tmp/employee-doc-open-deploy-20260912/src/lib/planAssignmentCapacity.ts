export const MANPOWER_OVERLAP_TOLERANCE_MINUTES = 5

export type MinuteInterval = { start: number; end: number }

function overlapMinutes(a: MinuteInterval, b: MinuteInterval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

/**
 * Returns whether one more assignment can be added without exceeding the
 * employee's configured concurrent-job capacity. Pairwise overlaps up to the
 * tolerance are treated as hand-off time and do not consume another slot.
 */
export function canAcceptManpowerAssignment(
  existing: MinuteInterval[],
  target: MinuteInterval,
  maxConcurrentJobs = 1,
  toleranceMinutes = MANPOWER_OVERLAP_TOLERANCE_MINUTES,
): boolean {
  const capacity = Math.max(1, Math.floor(Number(maxConcurrentJobs) || 1))
  const relevant = existing
    .filter((slot) => slot.end > slot.start && overlapMinutes(slot, target) > toleranceMinutes)
    .map((slot) => ({ start: Math.max(slot.start, target.start), end: Math.min(slot.end, target.end) }))

  const events = relevant.flatMap((slot) => [
    { at: slot.start, delta: 1 },
    { at: slot.end, delta: -1 },
  ]).sort((a, b) => a.at - b.at || a.delta - b.delta)

  let active = 0
  for (const event of events) {
    active += event.delta
    if (active >= capacity) return false
  }
  return true
}
