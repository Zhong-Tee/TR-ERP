import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { startPackingListSession } from '../lib/packingListSession'

/** One request at a time per list. Filters abort old reads; polls wait for completion. */
export function usePackingList<T>(
  active: boolean,
  rpc: string,
  parameters: Record<string, unknown>,
  pollMs?: number,
  userId?: string,
) {
  const key = JSON.stringify(parameters)
  const [revision, setRevision] = useState(0)
  const identity = JSON.stringify([rpc, key, userId, revision])
  const [result, setResult] = useState<{ identity: string; data: T | null; error: string } | null>(null)

  useEffect(() => {
    if (!active) return
    return startPackingListSession<T>({
      pollMs,
      load: async (signal) => {
        const result = await supabase.rpc(rpc, JSON.parse(key)).abortSignal(signal)
        if (result.error) throw result.error
        if (!result.data) throw new Error('ไม่พบข้อมูลตอบกลับจากเซิร์ฟเวอร์')
        return result.data as T
      },
      onData: (data) => {
        setResult({ identity, data, error: '' })
      },
      onError: (cause) => {
        const failure = (cause || {}) as { code?: string; message?: string }
        const error = failure.code === 'PGRST202' || failure.code === '42883'
          ? 'กรุณาติดต่อผู้ดูแลระบบเพื่ออัปเดตบริการรายการแพ็คสินค้า แล้วลองใหม่'
          : failure.message || 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'
        setResult(previous => ({ identity, data: previous?.identity === identity ? previous.data : null, error }))
      },
      onSettled: () => {},
    })
  }, [active, rpc, key, identity, pollMs])

  const current = result?.identity === identity ? result : null
  return {
    data: current?.data || null,
    loading: active && !current,
    error: current?.error || '',
    refresh: () => setRevision(value => value + 1),
  }
}
