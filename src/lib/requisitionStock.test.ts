import { describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('./stockReservations', () => ({ fetchReservationStock: mock.fetch }))
import { requisitionStockError, withRequisitionStock } from './requisitionStock'

describe('requisition stock limits', () => {
  const stock = [{ product_code: '990000055', available_qty: 19 }]
  it('allows the exact balance and rejects the reported 2000-unit request', () => {
    expect(requisitionStockError([{ product_code: '990000055', qty: 19 }], stock)).toBeNull()
    expect(requisitionStockError([{ product_code: '990000055', qty: 2000 }], stock)).toContain('19')
  })
  it('sums duplicate lines and rejects absent stock and invalid quantities', () => {
    expect(requisitionStockError([{ product_code: '990000055', qty: 10 }, { product_code: '990000055', qty: 10 }], stock)).toBeTruthy()
    expect(requisitionStockError([{ product_code: 'missing', qty: 1 }], stock)).toBeTruthy()
    for (const qty of [0, -1, NaN, Infinity]) expect(requisitionStockError([{ product_code: '990000055', qty }], stock)).toBeTruthy()
  })
  it('subtracts reservations without subtracting the separate safety pool again', async () => {
    mock.fetch.mockResolvedValue({ data: [{ product_id: 'p', on_hand: 19, reserved: 5, safety_stock: 10 }], error: null })
    expect(await withRequisitionStock([{ id: 'p', product_code: '990000055' }, { id: 'none', product_code: 'none' }])).toEqual([
      { id: 'p', product_code: '990000055', available_qty: 14 }, { id: 'none', product_code: 'none', available_qty: 0 },
    ])
  })
  it('fails closed when the latest stock cannot be loaded', async () => {
    mock.fetch.mockResolvedValue({ data: null, error: { message: 'permission denied' } })
    await expect(withRequisitionStock([{ id: 'p', product_code: '990000055' }])).rejects.toEqual({ message: 'permission denied' })
  })
})
