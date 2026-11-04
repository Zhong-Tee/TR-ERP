import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { rpc: mock.rpc } }))
import { assignPackingTags } from './packingTags'

beforeEach(() => { mock.rpc.mockReset() })
describe('committed packing tags', () => {
  it('uses one request per 200 bills instead of one per bill', async () => {
    mock.rpc.mockImplementation(async (_, { p_tags }) => ({
      data: Object.fromEntries(p_tags.map((t: { order_id: string; tag: number }) => [t.order_id, t.tag])), error: null,
    }))
    const tags = Array.from({ length: 401 }, (_, i) => ({ order_id: `o${i}`, tag: i + 1 }))
    const result = await assignPackingTags(tags)
    expect(mock.rpc.mock.calls.map(call => call[1].p_tags.length)).toEqual([200, 200, 1])
    expect(Object.keys(result)).toHaveLength(401)
  })
  it('displays the existing tag another station saved first', async () => {
    mock.rpc.mockResolvedValue({ data: { order: 84 }, error: null })
    expect(await assignPackingTags([{ order_id: 'order', tag: 12 }])).toEqual({ order: 84 })
  })
  it('does not silently treat failed or incomplete saves as success', async () => {
    mock.rpc.mockResolvedValueOnce({ data: null, error: new Error('denied') })
    await expect(assignPackingTags([{ order_id: 'o', tag: 1 }])).rejects.toThrow('denied')
    mock.rpc.mockResolvedValueOnce({ data: {}, error: null })
    await expect(assignPackingTags([{ order_id: 'o', tag: 1 }])).rejects.toThrow('บันทึก Tag แพ็คไม่ครบ')
  })
  it('performs no write for an empty batch (view-only/already-tagged)', async () => {
    expect(await assignPackingTags([])).toEqual({})
    expect(mock.rpc).not.toHaveBeenCalled()
  })
})
