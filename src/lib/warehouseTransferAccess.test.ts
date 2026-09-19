import { describe, expect, it } from 'vitest'
import { canManageWarehouseTransfers } from './warehouseTransferAccess'

describe('warehouse transfer access', () => {
  it.each(['superadmin', 'admin', 'account', 'store'])('allows %s', (role) => {
    expect(canManageWarehouseTransfers(role)).toBe(true)
  })

  it.each(['sales-tr', 'sales-pump', 'production', 'qc_staff', 'auditor'])('denies %s', (role) => {
    expect(canManageWarehouseTransfers(role)).toBe(false)
  })
})
