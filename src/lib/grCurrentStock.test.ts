import { beforeEach, describe, expect, it, vi } from 'vitest'
import { grOrderStockNote, loadGRCurrentStock } from './grCurrentStock'

const api = vi.hoisted(() => ({ from: vi.fn(), select: vi.fn(), in: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { from: api.from } }))
beforeEach(() => {
  vi.resetAllMocks()
  api.from.mockReturnValue({ select: api.select })
  api.select.mockReturnValue({ in: api.in })
})

describe('GR current main stock loading', () => {
  it('uses main on_hand without adding safety or deducting reserved', async () => {
    api.in.mockResolvedValue({ data: [{ product_id: 'one', on_hand: '180.5', safety_stock: 20, reserved: 80 }], error: null })
    expect(await loadGRCurrentStock(['one', 'one', 'zero'])).toEqual({ one: { status: 'loaded', qty: 180.5 }, zero: { status: 'loaded', qty: 0 } })
    expect(api.from).toHaveBeenCalledWith('inv_stock_balances')
    expect(api.select).toHaveBeenCalledWith('product_id, on_hand')
    expect(api.in).toHaveBeenCalledWith('product_id', ['one', 'zero'])
  })
  it('shows a real zero and negative inventory correctly', async () => {
    api.in.mockResolvedValue({ data: [{ product_id: 'zero', on_hand: 0 }, { product_id: 'negative', on_hand: -2 }], error: null })
    expect(await loadGRCurrentStock(['zero', 'negative'])).toEqual({ zero: { status: 'loaded', qty: 0 }, negative: { status: 'loaded', qty: -2 } })
  })
  it('distinguishes query errors from a zero balance', async () => {
    api.in.mockResolvedValue({ data: null, error: { message: 'permission denied' } })
    expect(await loadGRCurrentStock(['one'])).toEqual({ one: { status: 'error' } })
    api.in.mockRejectedValue(new Error('offline'))
    expect(await loadGRCurrentStock(['one'])).toEqual({ one: { status: 'error' } })
  })
  it('does not treat malformed balances as zero', async () => {
    api.in.mockResolvedValue({ data: [{ product_id: 'one', on_hand: null }, { product_id: 'two', on_hand: 'bad' }], error: null })
    expect(await loadGRCurrentStock(['one', 'two'])).toEqual({ one: { status: 'error' }, two: { status: 'error' } })
  })
  it('batches requests and preserves successful batches when another batch fails', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i))
    api.in.mockResolvedValueOnce({ data: [{ product_id: '0', on_hand: 5 }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'failed' } })
    const result = await loadGRCurrentStock(ids)
    expect(api.in.mock.calls[0][1]).toHaveLength(100)
    expect(api.in.mock.calls[1][1]).toEqual(['100'])
    expect(result['0']).toEqual({ status: 'loaded', qty: 5 })
    expect(result['100']).toEqual({ status: 'error' })
  })
  it('loads a fresh value each time the form opens', async () => {
    api.in.mockResolvedValueOnce({ data: [{ product_id: 'one', on_hand: 180 }], error: null })
      .mockResolvedValueOnce({ data: [{ product_id: 'one', on_hand: 195 }], error: null })
    expect((await loadGRCurrentStock(['one'])).one).toEqual({ status: 'loaded', qty: 180 })
    expect((await loadGRCurrentStock(['one'])).one).toEqual({ status: 'loaded', qty: 195 })
  })
  it('makes no request without product IDs', async () => {
    expect(await loadGRCurrentStock([])).toEqual({})
    expect(api.from).not.toHaveBeenCalled()
  })
})

describe('historical stock label', () => {
  it('renames generated stock notes while preserving quantities and order point', () => {
    expect(grOrderStockNote('คงเหลือ 232 / จุดสั่งซื้อ 300')).toBe('คงเหลือตอนสั่งซื้อ 232 / จุดสั่งซื้อ 300')
    expect(grOrderStockNote('คงเหลือ 0 / จุดสั่งซื้อ 50')).toBe('คงเหลือตอนสั่งซื้อ 0 / จุดสั่งซื้อ 50')
  })
  it('preserves unrelated notes and already renamed history', () => {
    expect(grOrderStockNote('ตรวจสอบจำนวนคงเหลือก่อนรับ')).toBe('ตรวจสอบจำนวนคงเหลือก่อนรับ')
    expect(grOrderStockNote('คงเหลือตอนสั่งซื้อ 232 / จุดสั่งซื้อ 300')).toBe('คงเหลือตอนสั่งซื้อ 232 / จุดสั่งซื้อ 300')
  })
})
