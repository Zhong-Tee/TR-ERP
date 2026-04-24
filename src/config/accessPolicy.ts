import { UserRole } from '../types'

export type MaybeRole = UserRole | string | null | undefined

export const SUPERADMIN_ROLE: UserRole = 'superadmin'
export const ADMIN_ROLE: UserRole = 'admin'
export const WMS_MOBILE_SPECIAL_ROLES: UserRole[] = ['picker', 'production_mb', 'manager']

/** มือถือ: เข้า /machinery ได้ (รวม technician = เฉพาะมอนิเตอร์) */
export const MACHINERY_MOBILE_ROLES: UserRole[] = ['production_mb', 'manager', 'technician']

export const TECHNICIAN_ROLE: UserRole = 'technician'
export const DESKTOP_DB_MANAGED_ROLES: UserRole[] = [
  'superadmin',
  'admin',
  'sales-tr',
  'qc_order',
  'sales-pump',
  'qc_staff',
  'packing_staff',
  'account',
  'store',
  'production',
  'hr',
]
export const SALES_TR_ROLE_ALIASES: UserRole[] = ['sales-tr']
export const SALES_PUMP_ROLE_ALIASES: UserRole[] = ['sales-pump']

export function normalizeRole(role: MaybeRole): string {
  if (!role) return ''
  return String(role).trim()
}

export function getRoleLookupCandidates(role: MaybeRole): string[] {
  if (!role) return []
  return [normalizeRole(role)]
}

export function isRoleInAllowedList(role: MaybeRole, allowedRoles?: string[]): boolean {
  if (!role || !allowedRoles || allowedRoles.length === 0) return false
  const candidates = getRoleLookupCandidates(role)
  return candidates.some((candidate) => allowedRoles.includes(candidate))
}

export const DESKTOP_MENU_PATH_ORDER: { key: string; path: string; roles: UserRole[] }[] = [
  { key: 'dashboard', path: '/dashboard', roles: ['superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account'] },
  { key: 'orders', path: '/orders', roles: ['superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account'] },
  { key: 'admin-qc', path: '/admin-qc', roles: ['superadmin', 'admin', 'sales-tr', 'qc_order'] },
  { key: 'plan', path: '/plan', roles: ['superadmin', 'admin', 'sales-tr', 'sales-pump', 'production'] },
  { key: 'machinery', path: '/machinery', roles: ['superadmin', 'admin', 'production'] },
  { key: 'wms', path: '/wms', roles: ['superadmin', 'admin', 'sales-tr', 'store', 'production', 'production_mb', 'manager', 'picker'] },
  { key: 'qc', path: '/qc', roles: ['superadmin', 'admin', 'sales-tr', 'qc_staff'] },
  { key: 'packing', path: '/packing', roles: ['superadmin', 'admin', 'sales-tr', 'packing_staff'] },
  { key: 'transport', path: '/transport', roles: ['superadmin', 'admin', 'sales-tr', 'packing_staff'] },
  { key: 'account', path: '/account', roles: ['superadmin', 'admin', 'sales-tr', 'account'] },
  { key: 'products', path: '/products', roles: ['superadmin', 'admin', 'sales-tr', 'sales-pump'] },
  { key: 'warehouse', path: '/warehouse', roles: ['superadmin', 'admin', 'sales-tr', 'store'] },
  { key: 'sales-reports', path: '/sales-reports', roles: ['superadmin', 'admin', 'sales-tr'] },
  { key: 'kpi', path: '/kpi', roles: ['superadmin', 'admin', 'sales-tr'] },
  { key: 'hr', path: '/hr', roles: ['superadmin', 'admin', 'sales-tr', 'hr'] },
  { key: 'settings', path: '/settings', roles: ['superadmin', 'admin', 'sales-tr'] },
]

const PATH_MENU_PREFIX_MAP: Array<{ prefix: string; key: string }> = [
  { prefix: '/warehouse/sub', key: 'warehouse-sub' },
  { prefix: '/warehouse/audit', key: 'warehouse-audit' },
  { prefix: '/warehouse/adjust', key: 'warehouse-adjust' },
  { prefix: '/warehouse/returns', key: 'warehouse-returns' },
  { prefix: '/warehouse/production', key: 'warehouse-production' },
  { prefix: '/warehouse/roll-calc', key: 'warehouse-roll-calc' },
  { prefix: '/warehouse/sales-list', key: 'warehouse-sales-list' },
  { prefix: '/purchase/pr', key: 'purchase-pr' },
  { prefix: '/purchase/po', key: 'purchase-po' },
  { prefix: '/purchase/gr', key: 'purchase-gr' },
  { prefix: '/purchase/sample', key: 'purchase-sample' },
  { prefix: '/products/inactive', key: 'products-inactive' },
  { prefix: '/hr/leave', key: 'hr-leave' },
  { prefix: '/hr/interview', key: 'hr-interview' },
  { prefix: '/hr/attendance', key: 'hr-attendance' },
  { prefix: '/hr/contracts', key: 'hr-contracts' },
  { prefix: '/hr/documents', key: 'hr-documents' },
  { prefix: '/hr/onboarding', key: 'hr-onboarding' },
  { prefix: '/hr/salary', key: 'hr-salary' },
  { prefix: '/hr/warnings', key: 'hr-warnings' },
  { prefix: '/hr/certificates', key: 'hr-certificates' },
  { prefix: '/hr/assets', key: 'hr-assets' },
  { prefix: '/hr/settings', key: 'hr-settings' },
]

export const PARENT_SUB_PAGES: Record<string, { path: string; key: string }[]> = {
  '/warehouse': [
    { path: '/warehouse/sub', key: 'warehouse-sub' },
    { path: '/warehouse', key: 'warehouse' },
    { path: '/warehouse/audit', key: 'warehouse-audit' },
    { path: '/warehouse/adjust', key: 'warehouse-adjust' },
    { path: '/warehouse/returns', key: 'warehouse-returns' },
    { path: '/warehouse/production', key: 'warehouse-production' },
    { path: '/warehouse/roll-calc', key: 'warehouse-roll-calc' },
    { path: '/warehouse/sales-list', key: 'warehouse-sales-list' },
  ],
  '/hr': [
    { path: '/hr', key: 'hr' },
    { path: '/hr/leave', key: 'hr-leave' },
    { path: '/hr/interview', key: 'hr-interview' },
    { path: '/hr/attendance', key: 'hr-attendance' },
    { path: '/hr/contracts', key: 'hr-contracts' },
    { path: '/hr/documents', key: 'hr-documents' },
    { path: '/hr/onboarding', key: 'hr-onboarding' },
    { path: '/hr/salary', key: 'hr-salary' },
    { path: '/hr/warnings', key: 'hr-warnings' },
    { path: '/hr/certificates', key: 'hr-certificates' },
    { path: '/hr/assets', key: 'hr-assets' },
    { path: '/hr/settings', key: 'hr-settings' },
  ],
  '/purchase': [
    { path: '/purchase/pr', key: 'purchase-pr' },
    { path: '/purchase/po', key: 'purchase-po' },
    { path: '/purchase/gr', key: 'purchase-gr' },
    { path: '/purchase/sample', key: 'purchase-sample' },
  ],
  '/products': [
    { path: '/products', key: 'products' },
    { path: '/products/inactive', key: 'products-inactive' },
  ],
}

const MENU_KEY_ALIASES: Record<string, string[]> = {
  warehouse: ['warehouse-stock'],
  'warehouse-stock': ['warehouse'],
  hr: ['hr-employees'],
  'hr-employees': ['hr'],
  /** แท็บบิลเคลม REQ ใช้สิทธิ์เดียวกับสร้าง/แก้ไข */
  'orders-claim-req': ['orders-create'],
}

const MENU_KEY_PARENT_MAP: Record<string, string> = {
  'warehouse-sub': 'warehouse',
  'products-inactive': 'products',
  'purchase-pr': 'purchase',
  'purchase-po': 'purchase',
  'purchase-gr': 'purchase',
  'purchase-sample': 'purchase',
  'warehouse-stock': 'warehouse',
  'warehouse-audit': 'warehouse',
  'warehouse-adjust': 'warehouse',
  'warehouse-returns': 'warehouse',
  'warehouse-production': 'warehouse',
  'warehouse-roll-calc': 'warehouse',
  'warehouse-sales-list': 'warehouse',
  'hr-employees': 'hr',
  'hr-leave': 'hr',
  'hr-interview': 'hr',
  'hr-attendance': 'hr',
  'hr-contracts': 'hr',
  'hr-documents': 'hr',
  'hr-onboarding': 'hr',
  'hr-salary': 'hr',
  'hr-warnings': 'hr',
  'hr-certificates': 'hr',
  'hr-assets': 'hr',
  'hr-settings': 'hr',
  'settings-users': 'settings',
  'settings-role-settings': 'settings',
  'settings-banks': 'settings',
  'settings-bill-header': 'settings',
  'settings-product-settings': 'settings',
  'settings-bill-channel-map': 'settings',
  'settings-sellers': 'settings',
  'settings-promotions': 'settings',
  'settings-issue-types': 'settings',
  'settings-chat-history': 'settings',
  'settings-easyslip': 'settings',
  'orders-create': 'orders',
  'orders-all': 'orders',
  'orders-waiting': 'orders',
  'orders-data-error': 'orders',
  'orders-complete': 'orders',
  'orders-verified': 'orders',
  'orders-confirm': 'orders',
  'orders-shipped': 'orders',
  'orders-cancelled': 'orders',
  'orders-issue': 'orders',
  'orders-work-orders': 'orders',
  'orders-work-orders-manage': 'orders',
  'orders-claim-req': 'orders',
  'plan-dash': 'plan',
  'plan-dept': 'plan',
  'plan-jobs': 'plan',
  'plan-form': 'plan',
  'plan-set': 'plan',
  'plan-issue': 'plan',
  'machinery-settings': 'machinery',
  'qc-operation': 'qc',
  'qc-reject': 'qc',
  'qc-report': 'qc',
  'qc-history': 'qc',
  'qc-settings': 'qc',
  'packing-new': 'packing',
  'packing-shipped': 'packing',
  'packing-queue': 'packing',
  'packing-tagSearch': 'packing',
  'account-claim-approval': 'account',
  'account-ecommerce': 'account',
}

export function resolveMenuKeyFromPath(pathname: string): string | null {
  const matchedPrefix = PATH_MENU_PREFIX_MAP.find((item) => pathname.startsWith(item.prefix))
  if (matchedPrefix) return matchedPrefix.key
  if (pathname.startsWith('/dashboard')) return 'dashboard'
  if (pathname.startsWith('/orders')) return 'orders'
  if (pathname.startsWith('/admin-qc')) return 'admin-qc'
  if (pathname.startsWith('/account')) return 'account'
  if (pathname.startsWith('/plan')) return 'plan'
  if (pathname.startsWith('/machinery')) return 'machinery'
  if (pathname.startsWith('/wms')) return 'wms'
  if (pathname.startsWith('/qc')) return 'qc'
  if (pathname.startsWith('/packing')) return 'packing'
  if (pathname.startsWith('/transport')) return 'transport'
  if (pathname.startsWith('/products')) return 'products'
  if (pathname.startsWith('/cartoon-patterns')) return 'cartoon-patterns'
  if (pathname.startsWith('/warehouse')) return 'warehouse'
  if (pathname.startsWith('/purchase')) return 'purchase'
  if (pathname.startsWith('/sales-reports')) return 'sales-reports'
  if (pathname.startsWith('/kpi')) return 'kpi'
  if (pathname.startsWith('/hr')) return 'hr'
  if (pathname.startsWith('/settings')) return 'settings'
  return null
}

export function getParentMenuKey(menuKey: string): string | null {
  return MENU_KEY_PARENT_MAP[menuKey] || null
}

export function getMenuAccessCandidates(menuKey: string): string[] {
  const keys: string[] = []
  const pushUnique = (key: string | null) => {
    if (key && !keys.includes(key)) keys.push(key)
  }

  pushUnique(menuKey)
  ;(MENU_KEY_ALIASES[menuKey] || []).forEach(pushUnique)

  const parent = getParentMenuKey(menuKey)
  pushUnique(parent)
  if (parent) (MENU_KEY_ALIASES[parent] || []).forEach(pushUnique)

  return keys
}

export function isRoleAllowedForMenuFallback(menuKey: string, role: MaybeRole): boolean {
  if (!role) return false
  const menu = DESKTOP_MENU_PATH_ORDER.find((item) => item.key === menuKey)
  if (!menu) return false
  return isRoleInAllowedList(role, menu.roles)
}

export function isSuperadmin(role: MaybeRole): boolean {
  return role === SUPERADMIN_ROLE
}

export function isDesktopDbManagedRole(role: MaybeRole): boolean {
  return isRoleInAllowedList(role, DESKTOP_DB_MANAGED_ROLES)
}

export function isAdminOrSuperadmin(role: MaybeRole): boolean {
  return role === SUPERADMIN_ROLE || role === ADMIN_ROLE
}

export function isSalesOwnerScopedRole(role: MaybeRole): boolean {
  return isRoleInAllowedList(role, [...SALES_PUMP_ROLE_ALIASES, ...SALES_TR_ROLE_ALIASES])
}

export function isSalesTrTeamRole(role: MaybeRole): boolean {
  return isRoleInAllowedList(role, SALES_TR_ROLE_ALIASES)
}

export function isSalesPumpOwnerScopedRole(role: MaybeRole): boolean {
  return isRoleInAllowedList(role, SALES_PUMP_ROLE_ALIASES)
}

/** เฉพาะ sales-pump: ค่าที่ใช้ match or_orders.admin_user (บิลของตัวเอง) */
export function resolveSalesPumpOwnerAdminName(
  role: MaybeRole,
  username?: string | null,
  email?: string | null
): string {
  if (!isSalesPumpOwnerScopedRole(role)) return ''
  return username || email || ''
}

/**
 * สำหรับ RPC เช่น get_sidebar_counts: sales-pump ส่ง username/email;
 * sales-tr ส่งค่าว่าง แล้วให้ฝั่ง DB ใช้ทีม sales-tr ทั้งหมด
 */
export function resolveOwnerScopeAdminName(role: MaybeRole, username?: string | null, email?: string | null): string {
  return resolveSalesPumpOwnerAdminName(role, username, email)
}

export function canSeeOfficeChannel(role: MaybeRole): boolean {
  return isAdminOrSuperadmin(role)
}

export function canUseIssueChat(role: MaybeRole): boolean {
  return role === 'superadmin' || role === 'admin' || isSalesOwnerScopedRole(role) || role === 'production'
}

export function canClearAllChats(role: MaybeRole): boolean {
  return isAdminOrSuperadmin(role)
}

export function getIssueVisibilityScope(
  role: MaybeRole
): 'all' | 'ownerOrders' | 'salesTrTeam' | 'creatorOrOwner' | 'none' {
  if (isAdminOrSuperadmin(role)) return 'all'
  if (isSalesTrTeamRole(role)) return 'salesTrTeam'
  if (isSalesPumpOwnerScopedRole(role)) return 'ownerOrders'
  if (role === 'production') return 'creatorOrOwner'
  return 'none'
}

