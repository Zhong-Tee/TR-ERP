export const WAREHOUSE_TRANSFER_ROLES = ['superadmin', 'admin', 'account', 'store'] as const

export function canManageWarehouseTransfers(role: string | null | undefined): boolean {
  return WAREHOUSE_TRANSFER_ROLES.some((allowedRole) => allowedRole === role)
}
