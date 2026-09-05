import { describe, expect, it } from 'vitest'
import { wmsStoreBackupMenuDecision } from './wmsStoreBackup'

describe('WMS Store backup menu scope', () => {
  it('เปิดเฉพาะเมนูหลัก ใบงานใหม่ และตรวจสินค้า', () => {
    expect(wmsStoreBackupMenuDecision('wms')).toBe(true)
    expect(wmsStoreBackupMenuDecision('wms-new-orders')).toBe(true)
    expect(wmsStoreBackupMenuDecision('wms-review')).toBe(true)
  })

  it('ปิดเมนูย่อย WMS อื่นทั้งหมด', () => {
    expect(wmsStoreBackupMenuDecision('wms-upload')).toBe(false)
    expect(wmsStoreBackupMenuDecision('wms-kpi')).toBe(false)
    expect(wmsStoreBackupMenuDecision('wms-settings')).toBe(false)
  })

  it('ไม่เปลี่ยนสิทธิ์เมนูนอก WMS', () => {
    expect(wmsStoreBackupMenuDecision('qc')).toBeNull()
    expect(wmsStoreBackupMenuDecision('packing')).toBeNull()
  })
})
