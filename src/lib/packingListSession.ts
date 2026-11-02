/** A tab-scoped read session. Never overlap polls or publish an obsolete response. */
export function startPackingListSession<T>(options: {
  load: (signal: AbortSignal) => Promise<T>
  onData: (data: T) => void
  onError: (cause: unknown) => void
  onSettled: () => void
  pollMs?: number
}) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  let running = false

  async function load() {
    if (controller.signal.aborted || running) return
    if (document.visibilityState === 'hidden') {
      if (options.pollMs) timer = setTimeout(load, options.pollMs)
      return
    }
    running = true
    try {
      const data = await options.load(controller.signal)
      if (!controller.signal.aborted) options.onData(data)
    } catch (cause) {
      if (!controller.signal.aborted) options.onError(cause)
    } finally {
      running = false
      if (!controller.signal.aborted) {
        options.onSettled()
        if (options.pollMs) timer = setTimeout(load, options.pollMs)
      }
    }
  }

  function onVisible() {
    if (document.visibilityState !== 'visible' || running) return
    clearTimeout(timer)
    void load()
  }
  timer = setTimeout(load, 250)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    controller.abort()
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
