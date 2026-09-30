import { describe, expect, it } from 'vitest'
import {
  canUseIssueChat,
  getIssueVisibilityScope,
  isOperationalIssueRole,
  resolveMenuKeyFromPath,
} from './accessPolicy'

describe('operational Issue visibility', () => {
  it('uses GR menu permissions for receiving follow-up cases', () => {
    expect(resolveMenuKeyFromPath('/purchase/receiving-cases')).toBe('purchase-gr')
  })
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
