import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadLatestPurchasePrices } from './purchaseApi'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { rpc } }))

describe('PO purchase price references', () => {
  beforeEach(() => rpc.mockReset())

  it('requests unique products for the selected supplier and preserves reference metadata', async () => {
    rpc.mockResolvedValue({ data: [{ product_id: 'product-a', unit_price: '35.50', po_no: 'PO-001', ordered_at: '2026-09-30T00:00:00Z', supplier_id: 'seller-a', supplier_name: 'Seller A' }], error: null })
    const rows = await loadLatestPurchasePrices(['product-a', 'product-a'], 'seller-a')
    expect(rpc).toHaveBeenCalledWith('latest_purchase_prices_for_po', { p_product_ids: ['product-a'], p_supplier_id: 'seller-a' })
    expect(rows[0]).toMatchObject({ unit_price: 35.5, po_no: 'PO-001', supplier_name: 'Seller A' })
  })

  it('requests the latest purchase across suppliers when none is selected', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    expect(await loadLatestPurchasePrices(['product-a'])).toEqual([])
    expect(rpc).toHaveBeenCalledWith('latest_purchase_prices_for_po', { p_product_ids: ['product-a'], p_supplier_id: null })
  })

  it('reports denied or failed reads instead of treating them as no purchase history', async () => {
    const error = { message: 'ไม่มีสิทธิ์ดูราคาซื้อ' }
    rpc.mockResolvedValue({ data: null, error })
    await expect(loadLatestPurchasePrices(['product-a'])).rejects.toEqual(error)
  })

  it('does not request data for an empty product list', async () => {
    expect(await loadLatestPurchasePrices([])).toEqual([])
    expect(rpc).not.toHaveBeenCalled()
  })
})
