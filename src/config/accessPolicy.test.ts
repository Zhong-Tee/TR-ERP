import { describe, expect, it } from 'vitest'
import {
  canUseIssueChat,
  getIssueVisibilityScope,
  isOperationalIssueRole,
} from './accessPolicy'

describe('operational Issue visibility', () => {
  it.each(['production', 'qc_staff', 'packing_staff'] as const)(
    '%s can use Issue chat and receives the operational scope',
    (role) => {
      expect(isOperationalIssueRole(role)).toBe(true)
      expect(canUseIssueChat(role)).toBe(true)
      expect(getIssueVisibilityScope(role)).toBe('operational')
    },
  )

  it('keeps sales-tr team visibility unchanged', () => {
    expect(getIssueVisibilityScope('sales-tr')).toBe('salesTrTeam')
  })

  it('does not expose Issue chat to unrelated roles', () => {
    expect(canUseIssueChat('store')).toBe(false)
    expect(getIssueVisibilityScope('store')).toBe('none')
  })
})
