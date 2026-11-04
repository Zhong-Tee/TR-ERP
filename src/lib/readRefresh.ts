/** Small scoped cache: share concurrent reads without mixing identities or caching failures. */
export function createReadCache(ttlMs = 10_000) {
  type Entry = { value?: unknown; ready: boolean; expires: number; generation: number; pendingGeneration?: number; pending?: Promise<unknown> }
  const entries = new Map<string, Entry>()
  function entryFor(key: string) {
    let entry = entries.get(key)
    if (!entry) {
      if (entries.size >= 64) {
        const oldest = [...entries].find(([, item]) => !item.pending)
        if (oldest) entries.delete(oldest[0])
      }
      entry = { ready: false, expires: 0, generation: 0 }
      entries.set(key, entry)
    }
    return entry
  }
  return {
    invalidate(key: string) {
      const entry = entryFor(key)
      entry.generation++
      entry.expires = 0
    },
    async read<T>(key: string, load: () => Promise<T>): Promise<T> {
      const entry = entryFor(key)
      if (entry.pending) {
        const generation = entry.pendingGeneration
        const value = await entry.pending as T
        // A caller asking after invalidation needs a read begun after that event.
        if (generation !== entry.generation) return this.read(key, load)
        return value
      }
      if (entry.ready && entry.expires > Date.now()) return entry.value as T
      const generation = entry.generation
      const pending = Promise.resolve().then(load).then(value => {
        entry.value = value
        entry.ready = true
        entry.expires = generation === entry.generation ? Date.now() + ttlMs : 0
        return value
      }).finally(() => { entry.pending = undefined })
      entry.pending = pending
      entry.pendingGeneration = generation
      return pending
    },
  }
}

/** Debounce bursts, serialize requests, and retain a trailing refresh during a read. */
export function createRefreshBatch<K extends string>(options: {
  load: (keys: K[]) => Promise<void>
  onError: (error: unknown) => void
  isVisible?: () => boolean
  delayMs?: number
}) {
  const pending = new Set<K>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let disposed = false
  function schedule() {
    if (disposed || running || timer || !pending.size) return
    timer = setTimeout(run, options.delayMs ?? 300)
  }
  async function run() {
    timer = undefined
    if (disposed || running || !pending.size || options.isVisible?.() === false) return
    const keys = [...pending]
    pending.clear()
    running = true
    try { await options.load(keys) } catch (error) { if (!disposed) options.onError(error) }
    finally { running = false; schedule() }
  }
  return {
    isActive: () => !disposed,
    request(keys: readonly K[]) {
      if (disposed) return
      keys.forEach(key => pending.add(key))
      schedule()
    },
    dispose() { disposed = true; pending.clear(); clearTimeout(timer); timer = undefined },
    resume() { disposed = false; schedule() },
  }
}

export function countReadScope(user: { id: string; role: string; username?: string | null; email?: string | null }, backup = false) {
  return JSON.stringify([user.id, user.role, user.username, user.email, backup])
}

export const operationalCountCache = createReadCache()
