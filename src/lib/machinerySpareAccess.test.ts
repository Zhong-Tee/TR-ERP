import { describe, expect, it } from 'vitest'
import {
  canAccessMachinerySpareStock,
  canConfirmMachinerySpareTransfer,
  canManageMachinerySpares,
  canUseMachinerySpares,
} from './machinerySpareAccess'

describe('Machinery spare-part permissions', () => {
  it.each(['superadmin', 'admin'])('%s can perform every spare-part action', (role) => {
    expect(canManageMachinerySpares(role)).toBe(true)
    expect(canConfirmMachinerySpareTransfer(role)).toBe(true)
    expect(canUseMachinerySpares(role)).toBe(true)
  })

  it('allows store to confirm transfers only', () => {
    expect(canManageMachinerySpares('store')).toBe(false)
    expect(canConfirmMachinerySpareTransfer('store')).toBe(true)
    expect(canUseMachinerySpares('store')).toBe(false)
  })

  it('allows technician to use and return parts only', () => {
    expect(canManageMachinerySpares('technician')).toBe(false)
    expect(canConfirmMachinerySpareTransfer('technician')).toBe(false)
    expect(canUseMachinerySpares('technician')).toBe(true)
  })

  it.each(['production', 'manager', 'packing_staff', 'sales-tr', 'account', undefined])(
    'does not add spare-part access to %s',
    (role) => {
      expect(canAccessMachinerySpareStock(role)).toBe(false)
      expect(canManageMachinerySpares(role)).toBe(false)
      expect(canConfirmMachinerySpareTransfer(role)).toBe(false)
      expect(canUseMachinerySpares(role)).toBe(false)
    },
  )
})
