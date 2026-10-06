import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: mock }))
import { isMissingReservationRpc, reservationBreakdown, reservationTotals, saveReservationOrderItems, saveReservationPrebill } from './stockReservations'

describe('reservation stock and deployment compatibility', () => {
  beforeEach(() => { vi.resetAllMocks() })
  it('keeps shortages visible instead of hiding a negative sellable balance', () => {
    expect(reservationTotals(10, 12)).toEqual({ reserved: 12, available: -2 })
  })
  it('does not interpret stock shortage or permissions as an absent migration', () => {
    expect(isMissingReservationRpc({ code: 'P0001' })).toBe(false)
    expect(isMissingReservationRpc({ code: '42501' })).toBe(false)
    expect(isMissingReservationRpc({ code: 'PGRST202' })).toBe(true)
  })
  it('never retries a failed atomic write using delete/insert', async () => {
    const error = { code: 'P0001', message: 'stock shortage' }
    mock.rpc.mockResolvedValue({ data: null, error })
    expect((await saveReservationOrderItems('order', [])).error).toBe(error)
    expect((await saveReservationPrebill(null, {}, [])).error).toBe(error)
    expect(mock.from).not.toHaveBeenCalled()
  })
  it('does not bypass the ledger if the migration exists but the RPC cache is stale', async () => {
    const error = { code: 'PGRST202', message: 'schema cache' }
    mock.rpc.mockResolvedValue({ data: null, error })
    const limit = vi.fn().mockResolvedValue({ data: [], error: null })
    mock.from.mockReturnValue({ select: vi.fn().mockReturnValue({ limit }) })
    expect((await saveReservationOrderItems('order', [])).error).toBe(error)
    expect(mock.from).toHaveBeenCalledTimes(1)
  })
  it('retains legacy saves only after verifying the reservation column is absent', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    const limit = vi.fn().mockResolvedValue({ data: null, error: { code: '42703', message: 'column stock_reservation_enabled does not exist' } })
    const eq = vi.fn().mockResolvedValue({ data: null, error: null })
    mock.from.mockImplementation((table: string) => table === 'or_orders'
      ? { select: vi.fn().mockReturnValue({ limit }) }
      : { delete: vi.fn().mockReturnValue({ eq }) })
    expect((await saveReservationOrderItems('order', [])).error).toBeNull()
    expect(eq).toHaveBeenCalledWith('order_id', 'order')
  })
})

describe('unlinked legacy reservation display', () => {
  it('keeps the real stock hold visible when there are no linked documents', () => {
    expect(reservationBreakdown(1,0)).toEqual({ total: 1, linked: 0, unexplained: 1, underReserved: 0 })
  })
  it('does not add the unexplained part to the stock balance twice', () => {
    expect(reservationBreakdown(10,7)).toEqual({ total: 10, linked: 7, unexplained: 3, underReserved: 0 })
    expect(reservationTotals(20,10).available).toBe(10)
  })
  it('identifies under-reservation without inventing a negative legacy row', () => {
    expect(reservationBreakdown(2,5)).toEqual({ total: 2, linked: 5, unexplained: 0, underReserved: 3 })
  })
})
