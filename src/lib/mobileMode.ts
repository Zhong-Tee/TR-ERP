import type { User } from '../types'

/**
 * โหมดมือถือ: ให้ user เดสก์ท็อป (เช่น superadmin) สวม role มือถือได้หลายตัว
 * โดยไม่ต้อง login หลาย user — สิทธิ์เก็บใน us_users.mobile_access (JSONB array)
 * โหมดที่เลือกอยู่เก็บใน localStorage และตรวจกับสิทธิ์ทุกครั้งที่อ่าน
 */

export const MOBILE_MODE_ROLES = ['production_mb', 'manager', 'technician', 'picker', 'auditor'] as const
export type MobileMode = (typeof MOBILE_MODE_ROLES)[number]

export const MOBILE_MODE_INFO: Record<MobileMode, { label: string; description: string; emoji: string; path: string }> = {
  production_mb: { label: 'WMS ฝ่ายผลิต', description: 'เบิกวัตถุดิบ/รับงานฝ่ายผลิต', emoji: '🏭', path: '/wms' },
  manager: { label: 'อนุมัติใบเบิก', description: 'อนุมัติใบเบิก/ใบคืนคลัง', emoji: '✅', path: '/wms' },
  technician: { label: 'ช่างเทคนิค', description: 'งานซ่อมบำรุงเครื่องจักร', emoji: '🔧', path: '/technician' },
  picker: { label: 'หยิบสินค้า', description: 'หยิบสินค้าตามใบเบิก', emoji: '🛒', path: '/wms' },
  auditor: { label: 'ตรวจนับสต๊อก', description: 'ตรวจนับสินค้าคงคลัง', emoji: '📋', path: '/warehouse/audit' },
}

const MODE_KEY = 'tr-erp:mobile-mode'
const DESKTOP_KEY = 'tr-erp:desktop-override'

/** รายชื่อโหมดที่ user นี้เปิดสิทธิ์ไว้ (กรองเฉพาะค่าที่ระบบรู้จัก) */
export function getMobileAccess(user: User | null | undefined): MobileMode[] {
  const raw = user?.mobile_access
  if (!Array.isArray(raw)) return []
  return MOBILE_MODE_ROLES.filter((m) => raw.includes(m))
}

/** โหมดที่ผู้ใช้เลือกใช้งานได้ รวม role มือถือหลักของบัญชีด้วย */
export function getSelectableMobileModes(user: User | null | undefined): MobileMode[] {
  const modes = new Set<MobileMode>(getMobileAccess(user))
  if (user && MOBILE_MODE_ROLES.includes(user.role as MobileMode)) {
    modes.add(user.role as MobileMode)
  }
  return MOBILE_MODE_ROLES.filter((mode) => modes.has(mode))
}

/** โหมดที่กำลังสวมอยู่ — คืน null ถ้าไม่ได้เลือกหรือสิทธิ์ถูกถอนไปแล้ว */
export function getActiveMobileMode(user: User | null | undefined): MobileMode | null {
  try {
    const m = localStorage.getItem(MODE_KEY) as MobileMode | null
    if (!m) return null
    return getMobileAccess(user).includes(m) ? m : null
  } catch {
    return null
  }
}

export function setActiveMobileMode(mode: MobileMode | null) {
  try {
    if (mode) {
      localStorage.setItem(MODE_KEY, mode)
      sessionStorage.removeItem(DESKTOP_KEY)
    } else {
      localStorage.removeItem(MODE_KEY)
    }
  } catch {
    /* storage ไม่พร้อมใช้งาน — ข้าม */
  }
}

/** กด "โหมด PC Desktop" — จำไว้ทั้ง session เพื่อไม่ให้ SmartRedirect เด้งกลับ /mode */
export function setDesktopOverride() {
  try {
    sessionStorage.setItem(DESKTOP_KEY, '1')
    localStorage.removeItem(MODE_KEY)
  } catch {
    /* ข้าม */
  }
}

/** ล้างสถานะโหมดมือถือ/PC Desktop ทั้งหมด — เรียกตอน logout เพื่อให้ login ใหม่เริ่มจากหน้าเลือกโหมดเสมอ */
export function clearMobileModeStorage() {
  try {
    localStorage.removeItem(MODE_KEY)
    sessionStorage.removeItem(DESKTOP_KEY)
  } catch {
    /* ข้าม */
  }
}

export function hasDesktopOverride(): boolean {
  try {
    return sessionStorage.getItem(DESKTOP_KEY) === '1'
  } catch {
    return false
  }
}

/** path ที่โหมดนั้นเข้าได้ (ใช้ใน ProtectedRoute) */
export function modeAllowsPath(mode: MobileMode, pathname: string): boolean {
  switch (mode) {
    case 'picker':
      return pathname.startsWith('/wms')
    case 'production_mb':
    case 'manager':
      return pathname.startsWith('/wms') || pathname.startsWith('/machinery')
    case 'technician':
      return pathname.startsWith('/technician') || pathname.startsWith('/machinery')
    case 'auditor':
      return pathname.startsWith('/warehouse/audit')
    default:
      return false
  }
}
