import { describe, expect, it, vi } from 'vitest'
import { fetchAllSupabasePages } from './supabasePagination'

describe('fetchAllSupabasePages', () => {
  it('continues after the 1,000-row PostgREST page', async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ data: Array.from({ length: 1000 }, (_, id) => ({ id })), error: null })
      .mockResolvedValueOnce({ data: [{ id: 1000 }, { id: 1001 }], error: null })

    const rows = await fetchAllSupabasePages<{ id: number }>(loadPage)

    expect(rows).toHaveLength(1002)
    expect(loadPage).toHaveBeenNthCalledWith(1, 0, 999)
    expect(loadPage).toHaveBeenNthCalledWith(2, 1000, 1999)
  })

  it('honours maxRows across multiple server pages', async () => {
    const loadPage = vi.fn(async (from: number, to: number) => ({
      data: Array.from({ length: to - from + 1 }, (_, index) => ({ id: from + index })),
      error: null,
    }))

    const rows = await fetchAllSupabasePages<{ id: number }>(loadPage, { maxRows: 1500 })

    expect(rows).toHaveLength(1500)
    expect(loadPage).toHaveBeenNthCalledWith(2, 1000, 1499)
  })
})
