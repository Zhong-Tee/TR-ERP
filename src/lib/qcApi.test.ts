import { beforeEach, describe, expect, it, vi } from 'vitest'

const { from } = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { from } }))
import { fetchLatestRecordsForWorkOrder, saveQcRecord } from './qcApi'

function query(result: unknown) {
  const builder: any = {}
  for (const method of ['select', 'eq', 'or', 'in', 'order', 'upsert', 'update', 'insert']) {
    builder[method] = vi.fn(() => builder)
  }
  for (const method of ['range', 'single', 'maybeSingle']) {
    builder[method] = vi.fn(async () => ({ data: result, error: null }))
  }
  return builder
}

beforeEach(() => from.mockReset())

describe('QC stable identity', () => {
  it('retains different units sharing a UID and merges a unit whose UID changed', async () => {
    const first = { id: 'a', item_uid: 'B-5', order_item_id: 'crystal', unit_index: 1, last_result_at: '2026-10-07T04:00:00Z' }
    const panda = { ...first, id: 'b', order_item_id: 'panda' }
    const renamed = { ...first, id: 'c', item_uid: 'B-4', last_result_at: '2026-10-07T04:01:00Z' }
    from.mockReturnValueOnce(query([{ id: 'session' }]))
      .mockReturnValueOnce(query([first, panda, renamed]))
    expect(await fetchLatestRecordsForWorkOrder('WO')).toEqual([renamed, panda])
  })

  it('saves a stable unit using its identity rather than the occupied display UID', async () => {
    const records = query({ id: 'panda-result' })
    from.mockReturnValueOnce(records).mockReturnValueOnce(query({ start_time: '2026-10-07T04:00:00Z' }))
      .mockReturnValueOnce(query(null))
    await saveQcRecord('session', { uid: 'B-5', source_order_item_id: 'panda', unit_index: 1, status: 'pass' }, 'staff')
    expect(records.upsert).toHaveBeenCalledWith(expect.objectContaining({ item_uid: 'B-5', order_item_id: 'panda' }), {
      onConflict: 'session_id,order_item_id,unit_index',
    })
  })

  it('restricts legacy lookup so a shared UID cannot overwrite a stable result', async () => {
    const lookup = query({ id: 'legacy' })
    const update = query({ id: 'legacy' })
    from.mockReturnValueOnce(lookup).mockReturnValueOnce(update)
    await saveQcRecord('session', { uid: 'B-5', status: 'pending' }, 'staff')
    expect(lookup.or).toHaveBeenCalledWith('order_item_id.is.null,unit_index.is.null')
    expect(update.eq).toHaveBeenCalledWith('id', 'legacy')
  })
})
