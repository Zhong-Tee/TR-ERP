import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPackingListSession } from './packingListSession'

describe('packing list read sessions', () => {
  let visibility: string
  let events: EventTarget
  let stop: (() => void) | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    events = new EventTarget()
    vi.stubGlobal('document', {
      get visibilityState() { return visibility },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    })
  })
  afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals() })

  it('does not start a second poll while the first request is still running', async () => {
    let finish!: (data: number) => void
    const load = vi.fn(() => new Promise<number>(resolve => { finish = resolve }))
    const onData = vi.fn()
    stop = startPackingListSession({ load, onData, onError: vi.fn(), onSettled: vi.fn(), pollMs: 10_000 })
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(30_000)
    events.dispatchEvent(new Event('visibilitychange'))
    expect(load).toHaveBeenCalledTimes(1)
    finish(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(onData).toHaveBeenCalledWith(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('aborts an old filter/tab request and ignores its late response', async () => {
    let finish!: (data: string) => void
    let signal!: AbortSignal
    const onData = vi.fn()
    stop = startPackingListSession({
      load: async (value) => { signal = value; return new Promise<string>(resolve => { finish = resolve }) },
      onData, onError: vi.fn(), onSettled: vi.fn(), pollMs: 10_000,
    })
    await vi.advanceTimersByTimeAsync(250)
    stop()
    expect(signal.aborted).toBe(true)
    stop = startPackingListSession({ load: async () => 'new', onData, onError: vi.fn(), onSettled: vi.fn() })
    await vi.advanceTimersByTimeAsync(250)
    finish('old')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onData.mock.calls).toEqual([['new']])
  })

  it('coalesces quick filter changes before sending a request', async () => {
    const load = vi.fn(async () => 1)
    stop = startPackingListSession({ load, onData: vi.fn(), onError: vi.fn(), onSettled: vi.fn() })
    await vi.advanceTimersByTimeAsync(100)
    stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(load).not.toHaveBeenCalled()
  })

  it('pauses hidden-tab polls, resumes on visibility, and retries after errors', async () => {
    visibility = 'hidden'
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(2)
    const onError = vi.fn()
    const onData = vi.fn()
    stop = startPackingListSession({ load, onData, onError, onSettled: vi.fn(), pollMs: 10_000 })
    await vi.advanceTimersByTimeAsync(20_250)
    expect(load).not.toHaveBeenCalled()
    visibility = 'visible'
    events.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onData).toHaveBeenCalledWith(2)
  })
})
