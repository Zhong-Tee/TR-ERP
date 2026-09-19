import { describe, expect, it } from 'vitest'
import { getMarketplaceImportErrorMessage } from './marketplaceImportError'

describe('getMarketplaceImportErrorMessage', () => {
  it('does not expose a unique constraint name', () => {
    const result = getMarketplaceImportErrorMessage({
      code: '23505',
      message: 'duplicate key value violates unique constraint "mp_orders_channel_code_marketplace_order_no_key"',
    })

    expect(result).toContain('เคยนำเข้าแล้ว')
    expect(result).not.toContain('constraint')
    expect(result).not.toContain('mp_orders')
  })

  it('returns intentional Thai errors from the import RPC', () => {
    expect(getMarketplaceImportErrorMessage({
      code: '42501',
      message: 'คุณไม่มีสิทธิ์นำเข้างาน Marketplace',
    })).toBe('คุณไม่มีสิทธิ์นำเข้างาน Marketplace')
  })

  it('keeps a useful Thai workbook validation message', () => {
    expect(getMarketplaceImportErrorMessage(new Error('ไม่พบแผ่นงานในไฟล์'))).toBe('ไม่พบแผ่นงานในไฟล์')
  })

  it('uses a safe generic message for unknown technical errors', () => {
    const result = getMarketplaceImportErrorMessage(new Error('unexpected internal error'))

    expect(result).toContain('ไม่สามารถนำเข้าออเดอร์ได้')
    expect(result).not.toContain('unexpected internal error')
  })
})
