import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '../../lib/supabase'
import { fetchWorkOrderNamesWithWmsAssigned, isWmsPickableProduct } from './wmsUtils'

vi.mock('../../lib/supabase', () => ({
  supabase: { from: vi.fn() },
}))

describe('isWmsPickableProduct', () => {
  const nonPicker = new Set(['PACKAGING'])
  const subWarehouse = new Set(['sub-product'])

  it('sends a normal unconfigured product to the Picker', () => {
    expect(isWmsPickableProduct('main-product', 'STAMP', nonPicker, subWarehouse)).toBe(true)
  })

  it('skips a configured non-Picker category', () => {
    expect(isWmsPickableProduct('main-product', ' packaging ', nonPicker, subWarehouse)).toBe(false)
  })

  it('skips Picker for a product assigned to an active sub warehouse', () => {
    expect(isWmsPickableProduct('sub-product', 'STAMP', nonPicker, subWarehouse)).toBe(false)
  })

  it('does not send a product with no category to the Picker', () => {
    expect(isWmsPickableProduct('main-product', null, nonPicker, subWarehouse)).toBe(false)
  })
})

describe('fetchWorkOrderNamesWithWmsAssigned', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads past the Supabase 1,000-row limit and includes legacy work-order names', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      work_order_id: 'old-work-order-id',
      order_id: `OLD-${index}`,
    }))
    const secondPage = [
      { work_order_id: 'target-work-order-id', order_id: 'PUMP-100969-R1' },
      { work_order_id: null, order_id: 'LEGACY-100969-R1' },
    ]
    const range = vi
      .fn()
      .mockResolvedValueOnce({ data: firstPage, error: null })
      .mockResolvedValueOnce({ data: secondPage, error: null })
    const wmsQuery = {
      select: vi.fn(),
      or: vi.fn(),
      neq: vi.fn(),
      order: vi.fn(),
      range,
    }
    wmsQuery.select.mockReturnValue(wmsQuery)
    wmsQuery.or.mockReturnValue(wmsQuery)
    wmsQuery.neq.mockReturnValue(wmsQuery)
    wmsQuery.order.mockReturnValue(wmsQuery)
    const workOrderQuery = {
      select: vi.fn(),
      in: vi.fn().mockResolvedValue({
        data: [
          { work_order_name: 'OLD-WORK-ORDER' },
          { work_order_name: 'PUMP-100969-R1' },
        ],
        error: null,
      }),
    }
    workOrderQuery.select.mockReturnValue(workOrderQuery)
    vi.mocked(supabase.from).mockImplementation((table) => {
      if (table === 'wms_orders') return wmsQuery as unknown as ReturnType<typeof supabase.from>
      if (table === 'or_work_orders') return workOrderQuery as unknown as ReturnType<typeof supabase.from>
      throw new Error(`Unexpected table: ${table}`)
    })

    const names = await fetchWorkOrderNamesWithWmsAssigned()

    expect(range).toHaveBeenNthCalledWith(1, 0, 999)
    expect(range).toHaveBeenNthCalledWith(2, 1000, 1999)
    expect(names).toContain('PUMP-100969-R1')
    expect(names).toContain('LEGACY-100969-R1')
  })
})
