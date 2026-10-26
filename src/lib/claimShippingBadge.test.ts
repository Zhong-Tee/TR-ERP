import { beforeEach, describe, expect, it, vi } from 'vitest'
import { countPendingClaimShipping, loadPendingClaimShippingCount } from './claimShippingBadge'

type Row = Record<string, unknown>
const backend = vi.hoisted(() => ({ requests: [] as Row[], orders: [] as Row[], failTable: '', calls: [] as { table: string; ids: string[] }[] }))
vi.mock('./supabase', () => {
  class Query {
    filters: ((r: Row) => boolean)[] = []
    from = 0
    to = Infinity
    table: string
    constructor(table: string) { this.table = table }
    select() { return this }
    order() { return this }
    eq(k: string, v: unknown) { this.filters.push(r => r[k] === v); return this }
    not(k: string) { this.filters.push(r => r[k] != null); return this }
    in(k: string, values: string[]) { backend.calls.push({ table: this.table, ids: values }); this.filters.push(r => values.includes(String(r[k]))); return this }
    range(from: number, to: number) { this.from = from; this.to = to; return this }
    then(resolve: (r: { data: Row[] | null; error: unknown }) => unknown) {
      if (backend.failTable === this.table) return Promise.resolve(resolve({ data: null, error: new Error('lookup failed') }))
      const rows = this.table === 'or_claim_requests' ? backend.requests : backend.orders
      return Promise.resolve(resolve({ data: rows.filter(r => this.filters.every(f => f(r))).slice(this.from, this.to + 1), error: null }))
    }
  }
  return { supabase: { from: (table: string) => new Query(table) } }
})
const claim = (orderId: string | null, status = 'approved') => ({ status, created_claim_order_id: orderId })
const order = (id: string, status: string | null = 'รอลงข้อมูล', confirmed: string | null = null) => ({ id, status, claim_shipping_confirmed_at: confirmed })
beforeEach(() => { backend.requests = []; backend.orders = []; backend.failTable = ''; backend.calls = [] })

describe('claim shipping pending definition shared by both badges', () => {
  it('excludes cancelled, confirmed, missing and nonapproved requests', () => {
    const requests = [claim('active'), claim('cancelled'), claim('confirmed'), claim('missing'), claim(null), claim('pending', 'pending'), claim('rejected', 'rejected'), claim('draft', 'draft')]
    const orders = { active: order('active'), cancelled: order('cancelled', 'ยกเลิก'), confirmed: order('confirmed', 'รอลงข้อมูล', '2026-10-26'), pending: order('pending'), rejected: order('rejected'), draft: order('draft') }
    expect(countPendingClaimShipping(requests, orders)).toBe(1)
  })
  it('counts each actionable order once even if several requests reference it', () => {
    expect(countPendingClaimShipping([claim('one'), claim('one')], { one: order('one') })).toBe(1)
  })
  it('keeps cancellation excluded regardless of shipping confirmation', () => {
    expect(countPendingClaimShipping([claim('one')], { one: order('one', 'ยกเลิก', '2026-10-26') })).toBe(0)
    expect(countPendingClaimShipping([claim('one')], { one: order('one', 'ยกเลิก') })).toBe(0)
  })
  it('matches SQL IS DISTINCT FROM for a legacy null order status', () => {
    expect(countPendingClaimShipping([claim('one')], { one: order('one', null) })).toBe(1)
  })
})

describe('claim menu badge API loading', () => {
  it('matches the approved subtab count and excludes the cancelled row in the reported scenario', async () => {
    backend.requests = [claim('one'), claim('two')]
    backend.orders = [order('one', 'ยกเลิก'), order('two', 'รอลงข้อมูล', '2026-10-26')]
    expect(await loadPendingClaimShippingCount()).toBe(0)
    expect(countPendingClaimShipping(backend.requests as ReturnType<typeof claim>[], Object.fromEntries(backend.orders.map(r => [r.id, r])) as Record<string, ReturnType<typeof order>>)).toBe(0)
    expect(backend.orders).toHaveLength(2) // History is retained.
  })
  it('retains owner scope and deduplicates related requests', async () => {
    backend.requests = [claim('one'), claim('one'), claim('two'), claim('pending', 'pending')]
    backend.orders = [{ ...order('one'), admin_user: 'Alice' }, { ...order('two'), admin_user: 'Bob' }, { ...order('pending'), admin_user: 'Alice' }]
    expect(await loadPendingClaimShippingCount(' Alice ')).toBe(1)
    expect(await loadPendingClaimShippingCount()).toBe(2)
  })
  it('fetches beyond 200 and 1000 claims and batches order lookups', async () => {
    backend.requests = Array.from({ length: 1205 }, (_, i) => claim(String(i)))
    backend.orders = Array.from({ length: 1205 }, (_, i) => order(String(i)))
    expect(await loadPendingClaimShippingCount()).toBe(1205)
    expect(backend.calls).toHaveLength(13)
    expect(backend.calls.every(c => c.ids.length <= 100)).toBe(true)
  })
  it('reflects cancellation and confirmation on the next refresh', async () => {
    backend.requests = [claim('one'), claim('two')]
    backend.orders = [order('one'), order('two')]
    expect(await loadPendingClaimShippingCount()).toBe(2)
    backend.orders[0].status = 'ยกเลิก'
    expect(await loadPendingClaimShippingCount()).toBe(1)
    backend.orders[1].claim_shipping_confirmed_at = '2026-10-26'
    expect(await loadPendingClaimShippingCount()).toBe(0)
  })
  it('does not query orders when no approved requests exist', async () => {
    expect(await loadPendingClaimShippingCount()).toBe(0)
    expect(backend.calls).toHaveLength(0)
  })
  it.each(['or_claim_requests', 'or_orders'])('propagates %s errors instead of publishing a false zero', async table => {
    backend.requests = [claim('one')]; backend.failTable = table
    await expect(loadPendingClaimShippingCount()).rejects.toThrow('lookup failed')
  })
})
