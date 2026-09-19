export function canManageMachinerySpares(role: string | null | undefined): boolean {
  return role === 'superadmin' || role === 'admin'
}

export function canConfirmMachinerySpareTransfer(role: string | null | undefined): boolean {
  return canManageMachinerySpares(role) || role === 'store'
}

export function canUseMachinerySpares(role: string | null | undefined): boolean {
  return canManageMachinerySpares(role) || role === 'technician'
}

export function canAccessMachinerySpareStock(role: string | null | undefined): boolean {
  return canConfirmMachinerySpareTransfer(role) || role === 'technician'
}
