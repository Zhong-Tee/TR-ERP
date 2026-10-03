/** Grace determines whether an arrival is late; duration starts at the actual work start. */
export function lateDurationMinutes(actual: number, expected: number, grace: number): number {
  const delay = actual - expected
  return delay > grace ? delay : 0
}
