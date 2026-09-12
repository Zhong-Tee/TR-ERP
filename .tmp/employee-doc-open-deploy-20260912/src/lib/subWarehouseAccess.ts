const STOCK_MANAGER_ROLES = new Set(['superadmin', 'admin', 'store'])
const STOCK_REQUESTER_ROLES = new Set(['production', 'qc_staff', 'packing_staff'])

export function canManageSubWarehouseStock(role: string | null | undefined, isStoreBackup: boolean): boolean {
  return Boolean(role && (STOCK_MANAGER_ROLES.has(role) || isStoreBackup))
}

export function canRequestSubWarehouseStock(role: string | null | undefined, isStoreBackup: boolean): boolean {
  return Boolean(role && STOCK_REQUESTER_ROLES.has(role) && !isStoreBackup)
}
