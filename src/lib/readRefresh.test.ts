import { afterEach, describe, expect, it, vi } from 'vitest'
import { countReadScope, createReadCache, createRefreshBatch } from './readRefresh'

afterEach(() => vi.useRealTimers())

describe('scoped count cache', () => {
  it('deduplicates concurrent and recent reads, and respects TTL', async () => {
    vi.useFakeTimers()
    const cache = createReadCache(1_000)
    const load = vi.fn(async () => ({ count: 3 }))
    const values = await Promise.all([cache.read('a', load), cache.read('a', load)])
    expect(load).toHaveBeenCalledTimes(1)
    expect(values[0]).toBe(values[1])
    await cache.read('a', load)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_001)
    await cache.read('a', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('separates identities, roles and temporary Store assignments', async () => {
    const cache = createReadCache()
    const load = vi.fn(async () => 1)
    const a = { id: 'a', role: 'packing_staff', username: 'A' }
    for (const key of [countReadScope(a), countReadScope({ ...a, id: 'b' }),
      countReadScope({ ...a, role: 'admin' }), countReadScope(a, true)]) await cache.read(key, load)
    expect(load).toHaveBeenCalledTimes(4)
  })

  it('does not cache failed reads as zero', async () => {
    const cache = createReadCache()
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(8)
    await expect(cache.read('a', load)).rejects.toThrow('offline')
    expect(await cache.read('a', load)).toBe(8)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a response begun before invalidation for a new caller', async () => {
    const cache = createReadCache()
    let finish!: (value: number) => void
    const load = vi.fn().mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve }))
      .mockResolvedValue(2)
    const first = cache.read('a', load)
    await Promise.resolve()
    cache.invalidate('a')
    const next = cache.read('a', load)
    finish(1)
    expect(await first).toBe(1)
    expect(await next).toBe(2)
    expect(await cache.read('a', load)).toBe(2)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('refresh batches', () => {
  it('merges initial/navigation/event bursts into one request', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => {})
    const reader = createRefreshBatch({ load, onError: vi.fn() })
    reader.request(['core', 'qc'])
    reader.request(['core', 'wms'])
    await vi.advanceTimersByTimeAsync(300)
    expect(load.mock.calls).toEqual([[['core', 'qc', 'wms']]])
    reader.dispose()
  })

  it('serializes slow reads and retains one trailing refresh for all dirty groups', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const load = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
      .mockResolvedValue(undefined)
    const reader = createRefreshBatch({ load, onError: vi.fn() })
    reader.request(['qc'])
    await vi.advanceTimersByTimeAsync(300)
    reader.request(['core'])
    reader.request(['wms', 'core'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(300)
    expect(load.mock.calls).toEqual([[['qc']], [['core', 'wms']]])
    reader.dispose()
  })

  it('retains hidden-tab work until visible and supports StrictMode setup/cleanup/setup', async () => {
    vi.useFakeTimers()
    let visible = false
    const load = vi.fn(async () => {})
    const reader = createRefreshBatch({ load, onError: vi.fn(), isVisible: () => visible })
    reader.request(['core'])
    await vi.advanceTimersByTimeAsync(300)
    expect(load).not.toHaveBeenCalled()
    visible = true
    reader.request([])
    await vi.advanceTimersByTimeAsync(300)
    expect(load).toHaveBeenCalledTimes(1)
    reader.request(['core'])
    reader.dispose()
    reader.resume()
    reader.request(['wms'])
    await vi.advanceTimersByTimeAsync(300)
    expect(load.mock.calls[1]).toEqual([['wms']])
    reader.dispose()
  })
})
