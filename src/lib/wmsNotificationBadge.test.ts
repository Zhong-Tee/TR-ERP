import { describe, expect, it, vi } from 'vitest'
import { countPendingCancellationNotifications, loadWmsNotificationBadgeCount } from './wmsNotificationBadge'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('./wmsNotificationEnrichment', () => ({
  enrichWmsNotificationsWithOrderDetails: vi.fn(async (_client, rows) => rows),
}))

describe('WMS notification badge', () => {
  it('counts pending actions once per work order and excludes completed history', () => {
    expect(countPendingCancellationNotifications([
      { order_id: 'A', pendingCancelled: 1, awaitingShelf: 2 },
      { order_id: 'A', awaitingShelf: 1 },
      { order_id: 'B', awaitingShelf: 1 },
      { order_id: 'C', pendingCancelled: 0, awaitingShelf: 0 },
    ])).toBe(2)
  })

  it('uses unresolved status instead of read state and does not filter by date', async () => {
    const queries: Array<{ filters: unknown[][] }> = []
    const client = { from: vi.fn(() => {
      const query = { filters: [] as unknown[][] }
      queries.push(query)
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((...args) => { query.filters.push(['eq', ...args]); return builder }),
        neq: vi.fn((...args) => { query.filters.push(['neq', ...args]); return builder }),
        order: vi.fn(() => builder),
        range: vi.fn(async () => ({ data: [
          { order_id: 'old-pending', pendingCancelled: 1 },
          { order_id: 'done', pendingCancelled: 0, awaitingShelf: 0 },
        ], error: null })),
        then: (resolve: (result: unknown) => unknown) => Promise.resolve({ count: 2, error: null }).then(resolve),
      }
      return builder
    }) } as unknown as SupabaseClient
    expect(await loadWmsNotificationBadgeCount(client)).toBe(3)
    expect(queries[0].filters).toEqual([['eq', 'status', 'unread'], ['neq', 'type', 'ยกเลิกบิล']])
    expect(queries[1].filters).toEqual([['eq', 'type', 'ยกเลิกบิล']])
  })
})
