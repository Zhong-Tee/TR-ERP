import { describe, expect, it } from 'vitest'
import {
  canOperationalRoleSeeIssue,
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

  it.each(['sales-tr', 'sales-pump'] as const)('shows %s-created tickets to operational staff', (creatorRole) => {
    expect(canOperationalRoleSeeIssue('viewer', 'sales-user', creatorRole)).toBe(true)
  })

  it('shows an operational user their own ticket but hides another operational user ticket', () => {
    expect(canOperationalRoleSeeIssue('viewer', 'viewer', 'packing_staff')).toBe(true)
    expect(canOperationalRoleSeeIssue('viewer', 'other', 'packing_staff')).toBe(false)
  })

  it('does not expose Issue chat to unrelated roles', () => {
    expect(canUseIssueChat('store')).toBe(false)
    expect(getIssueVisibilityScope('store')).toBe('none')
  })
})
