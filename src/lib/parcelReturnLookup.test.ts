import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findShippedOrderByTracking, normalizeParcelTracking } from './parcelReturnLookup'

const { rpc, select } = vi.hoisted(() => ({ rpc: vi.fn(), select: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { rpc } }))

describe('parcel return tracking lookup', () => {
  beforeEach(() => {
    rpc.mockReset()
    select.mockReset()
    rpc.mockReturnValue({ select })
  })

  it.each([
    'TH2693957376105',
    'TH2 693 957 376 105',
    '  th2\t693\n957 376 105  ',
    'TH2\u00a0693\u00a0957 376 105',
  ])('uses the same lookup key for %j', async (tracking) => {
    const order = {
      bill_no: 'SPTR26091879',
      tracking_number: 'TH2 693 957 376 105',
      status: 'จัดส่งแล้ว',
      or_order_items: [{ product_id: 'product-a', quantity: 2 }],
    }
    select.mockResolvedValue({ data: [order], error: null })

    expect(normalizeParcelTracking(tracking)).toBe('TH2693957376105')
    expect(await findShippedOrderByTracking(tracking)).toEqual(order)
    expect(rpc).toHaveBeenCalledWith('find_shipped_order_for_parcel_return', {
      p_tracking: 'TH2693957376105',
    })
    expect(select).toHaveBeenCalledWith(
      'bill_no, tracking_number, recipient_name, status, or_order_items(product_id, quantity)',
    )
  })

  it('preserves non-whitespace characters so distinct parcel numbers remain distinct', () => {
    expect(normalizeParcelTracking(' SPX-123 45 ')).toBe('SPX-12345')
    expect(normalizeParcelTracking('SPX12345')).not.toBe('SPX-12345')
  })

  it('does not query for a whitespace-only barcode', async () => {
    expect(await findShippedOrderByTracking(' \t\n ')).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns no match when the server finds no shipped order', async () => {
    select.mockResolvedValue({ data: [], error: null })
    expect(await findShippedOrderByTracking('TH2693957376105')).toBeNull()
  })

  it('surfaces database errors instead of reporting a parcel as missing', async () => {
    const error = { message: 'permission denied' }
    select.mockResolvedValue({ data: null, error })
    await expect(findShippedOrderByTracking('TH2693957376105')).rejects.toEqual(error)
  })
})
