import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  getSession: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))

vi.mock('react', () => ({
  useState: () => {
    const setter = vi.fn()
    mocks.setters.push(setter)
    return [null, setter]
  },
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => mocks.effects.push(effect),
}))
vi.mock('../lib/supabase', () => ({
  supabase: { auth: { getSession: mocks.getSession, onAuthStateChange: mocks.subscribe } },
}))
vi.mock('../lib/dailySession', () => ({
  clearSessionDay: vi.fn(), ensureSessionDay: vi.fn(), isSessionExpired: () => false,
  markSessionDay: vi.fn(), readSessionDay: () => null,
}))

import { useAuth } from './useAuth'

describe('auth startup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.effects.length = 0
    mocks.setters.length = 0
    mocks.getSession.mockImplementation(() => new Promise(() => {}))
    mocks.subscribe.mockReturnValue({ data: { subscription: { unsubscribe: mocks.unsubscribe } } })
  })
  afterEach(() => vi.useRealTimers())

  it('does not re-enter the auth lock while handling a session notification', () => {
    useAuth()
    const cleanup = mocks.effects[0]()
    const callback = mocks.subscribe.mock.calls[0][0]
    callback('SIGNED_IN', { user: { id: 'user-1' }, access_token: '' })
    expect(mocks.getSession).toHaveBeenCalledTimes(1)
    vi.runOnlyPendingTimers()
    expect(mocks.getSession).toHaveBeenCalledTimes(2)
    if (cleanup) cleanup()
  })

  it('cancels deferred profile loading when signed out or unmounted', () => {
    useAuth()
    const cleanup = mocks.effects[0]()
    const callback = mocks.subscribe.mock.calls[0][0]
    callback('SIGNED_IN', { user: { id: 'user-1' }, access_token: '' })
    callback('SIGNED_OUT', null)
    vi.runOnlyPendingTimers()
    expect(mocks.getSession).toHaveBeenCalledTimes(1)
    callback('SIGNED_IN', { user: { id: 'user-1' }, access_token: '' })
    if (cleanup) cleanup()
    vi.runOnlyPendingTimers()
    expect(mocks.getSession).toHaveBeenCalledTimes(1)
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })

  it('ends startup loading if reading the saved session rejects', async () => {
    mocks.getSession.mockRejectedValueOnce(new Error('session unavailable'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    useAuth()
    const cleanup = mocks.effects[0]()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.setters[1]).toHaveBeenCalledWith(false)
    if (cleanup) cleanup()
    log.mockRestore()
  })
})
