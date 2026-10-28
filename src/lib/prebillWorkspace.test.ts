import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPreBillCounts, loadPreBillDetail, loadPreBillPage, type PreBillFilters, type PreBillView } from './prebillWorkspace'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('./supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  return { supabase: createClient('https://example.supabase.co', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchMock },
  }) }
})

const filters: PreBillFilters = {
  documentType: 'production_confirmation', dateFrom: '2026-10-01', dateTo: '2026-10-31',
  ownerId: 'owner-id', today: '2026-10-28',
}
const requestUrl = (index = 0) => new URL(String(fetchMock.mock.calls[index][0]))
const respond = (data: unknown = [], total = 63) => new Response(JSON.stringify(data), {
  status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': `0-24/${total}` },
})

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => respond())
})

describe('prebill workspace reads', () => {
  it('loads only one stable page of summaries, including every fraction of the last day', async () => {
    const result = await loadPreBillPage(filters, 'mine', 2, '')
    const params = requestUrl().searchParams
    expect(params.get('offset')).toBe('25')
    expect(params.get('limit')).toBe('25')
    expect(params.get('order')).toBe('created_at.desc,id.desc')
    expect(params.get('document_type')).toBe('eq.production_confirmation')
    expect(params.get('owner_id')).toBe('eq.owner-id')
    expect(params.getAll('created_at')).toEqual(['gte.2026-10-01T00:00:00+07:00', 'lt.2026-11-01T00:00:00+07:00'])
    expect(params.get('select')).not.toContain('*')
    expect(params.get('select')).not.toContain('or_prebill_items')
    expect(result.total).toBe(63)
  })

  it.each<[PreBillView, string, string | null]>([
    ['mine', 'in.(draft,active,rejected)', 'gte.2026-10-28'],
    ['draft', 'eq.draft', 'gte.2026-10-28'],
    ['pending', 'eq.pending_discount', 'gte.2026-10-28'],
    ['approved', 'eq.approved', 'gte.2026-10-28'],
    ['expired', 'not.in.(converted,cancelled)', 'lt.2026-10-28'],
    ['converted', 'eq.converted', null],
    ['cancelled', 'eq.cancelled', null],
  ])('filters %s in the database and keeps converted/cancelled documents after expiry', async (view, status, validUntil) => {
    await loadPreBillPage(filters, view, 1, '')
    expect(requestUrl().searchParams.get('status')).toBe(status)
    expect(requestUrl().searchParams.get('valid_until')).toBe(validUntil)
  })

  it('searches headers OR product names before pagination without fetching product details', async () => {
    await loadPreBillPage(filters, 'mine', 1, 'สินค้า (A), "พิเศษ"')
    const params = requestUrl().searchParams
    expect(params.get('select')).toContain('product_search:or_prebill_items()')
    expect(params.get('product_search.product_name')).toBe('imatch.สินค้า \\(A\\), "พิเศษ"')
    const or = params.get('or')!
    expect(or).toContain('document_no.imatch.')
    expect(or).toContain('\\\\(A\\\\)')
    expect(or).toContain('\\"พิเศษ\\"')
    expect(or).toContain('product_search.not.is.null')
    expect(params.get('limit')).toBe('25')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('counts each tab without downloading documents or their items', async () => {
    const counts = await loadPreBillCounts(filters)
    expect(counts.mine).toBe(63)
    expect(counts.expired).toBe(63)
    expect(fetchMock).toHaveBeenCalledTimes(7)
    for (const [input, init] of fetchMock.mock.calls) {
      expect(init.method).toBe('HEAD')
      expect(new URL(String(input)).searchParams.get('select')).toBe('id')
    }
  })

  it('treats wildcard and regex characters as literal search text', async () => {
    await loadPreBillPage(filters, 'mine', 1, '50%_*(A)+')
    expect(requestUrl().searchParams.get('product_search.product_name')).toBe('imatch.50%_\\*\\(A\\)\\+')
  })

  it('allows superseded page requests to be aborted when filters change', async () => {
    const controller = new AbortController()
    await loadPreBillPage(filters, 'mine', 1, '', controller.signal)
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal)
  })

  it('fetches fresh complete details for one document and sorts its items', async () => {
    fetchMock.mockResolvedValueOnce(respond({ id: 'doc-id', or_prebill_items: [{ sort_order: 2 }, { sort_order: 0 }] }))
    const detail = await loadPreBillDetail('doc-id')
    const params = requestUrl().searchParams
    expect(params.get('id')).toBe('eq.doc-id')
    expect(params.get('select')).toBe('*,or_prebill_items(*)')
    expect(detail.or_prebill_items?.map(item => item.sort_order)).toEqual([0, 2])
  })

  it('reports a failed detail fetch instead of opening an empty editable form', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'statement timeout', code: '57014' }), { status: 500 }))
    await expect(loadPreBillDetail('doc-id')).rejects.toMatchObject({ message: 'statement timeout' })
  })
})
