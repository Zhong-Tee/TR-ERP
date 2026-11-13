import { describe, expect, it } from 'vitest'
import { groupManualSlipRows } from './manualSlipGroups'

const row = (id: string, status: string, submitted_at: string, amount = 200) => ({
  id, order_id: 'bill-1', status, submitted_at, transfer_amount: amount,
  approval_revoked_at: null as string | null,
})

describe('manual slip queue and history', () => {
  it('excludes rejected and revoked submissions from the new decision and total', () => {
    const current = row('new', 'pending', '2026-11-13')
    const rejected = row('rejected', 'rejected', '2026-11-11')
    const revoked = { ...row('revoked', 'rejected', '2026-11-12'), approval_revoked_at: '2026-11-12T10:00:00Z' }
    const groups = groupManualSlipRows([current, revoked, rejected])
    const pending = groups.filter(group => group.status === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0].entries.map(entry => entry.id)).toEqual(['new'])
    expect(pending[0].entries.reduce((sum, entry) => sum + entry.transfer_amount, 0)).toBe(200)
    expect(groups.filter(group => group.status !== 'pending').map(group => group.entries[0].id)).toEqual(['revoked', 'rejected'])
  })

  it('keeps multiple pending slips together while separating past submissions and bills', () => {
    const groups = groupManualSlipRows([
      row('new-1', 'pending', '2026-11-13', 200),
      row('new-2', 'pending', '2026-11-13', 100),
      row('old-1', 'approved', '2026-11-10'),
      row('old-2', 'approved', '2026-11-10'),
      row('old-3', 'approved', '2026-11-11'),
      { ...row('other', 'pending', '2026-11-13'), order_id: 'bill-2' },
    ])
    expect(groups.map(group => group.entries.length)).toEqual([2, 2, 1, 1])
    expect(groups[0].entries.reduce((sum, entry) => sum + entry.transfer_amount, 0)).toBe(300)
  })
})
