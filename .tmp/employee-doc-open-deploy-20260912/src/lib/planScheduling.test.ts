import { describe, expect, it } from 'vitest'
import { getCutReadySec, getQcReadySec } from './planScheduling'

describe('Plan scheduling dependencies', () => {
  it.each(['เบิก', 'STK', 'CTT', 'CTT&SUB', 'TUBE'])('starts %s five minutes after cut time', (department) => {
    expect(getCutReadySec(department, 10 * 60)).toBe(15 * 60)
  })

  it('does not add the cut delay to STAMP or LASER', () => {
    expect(getCutReadySec('STAMP', 10 * 60)).toBe(10 * 60)
    expect(getCutReadySec('LASER', 10 * 60)).toBe(10 * 60)
  })

  it('waits for the latest required production department before QC', () => {
    expect(getQcReadySec([11 * 60, 18 * 60, 14 * 60])).toBe(18 * 60)
  })

  it('returns no QC dependency when no department has a finish time', () => {
    expect(getQcReadySec([])).toBeNull()
  })
})
