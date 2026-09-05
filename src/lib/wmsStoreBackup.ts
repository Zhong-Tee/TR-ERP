export const WMS_STORE_BACKUP_MENU_KEYS = ['wms-new-orders', 'wms-review'] as const

/**
 * คืนค่าเฉพาะเมื่อ menuKey อยู่ในขอบเขต WMS:
 * - true = Store สำรองเข้าได้
 * - false = Store สำรองต้องถูกปิด
 * - null = ไม่ใช่เมนู WMS ให้ใช้สิทธิ์ role เดิม
 */
export function wmsStoreBackupMenuDecision(menuKey: string): boolean | null {
  if (menuKey === 'wms') return true
  if ((WMS_STORE_BACKUP_MENU_KEYS as readonly string[]).includes(menuKey)) return true
  if (menuKey.startsWith('wms-')) return false
  return null
}
