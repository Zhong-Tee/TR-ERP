import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { createRefreshBatch } from '../lib/readRefresh'
import { planMetricsEventAffects, type PlanWorkOrderMetrics } from '../lib/planReadMetrics'

const EMPTY_METRICS: PlanWorkOrderMetrics = {}

export function usePlanReadMetrics(idsKey: string, scope: string) {
  const [revision, setRevision] = useState(0)
  const identity = `${scope}:${idsKey}`
  const [result, setResult] = useState<{ identity: string; scope: string; metrics: PlanWorkOrderMetrics; error: string } | null>(null)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    if (!scope) return
    const ids = JSON.parse(idsKey) as string[]
    const controller = new AbortController()
    const batch = createRefreshBatch<'metrics'>({
      delayMs: 500,
      isVisible: () => document.visibilityState === 'visible',
      load: async () => {
        const metrics: PlanWorkOrderMetrics = {}
        for (let start = 0; start < ids.length; start += 200) {
          const { data, error } = await supabase.rpc('rpc_plan_work_order_metrics', {
            p_work_order_ids: ids.slice(start, start + 200),
          }).abortSignal(controller.signal)
          if (error) throw error
          if (controller.signal.aborted) return
          Object.assign(metrics, data)
        }
        if (!controller.signal.aborted) setResult({ identity, scope, metrics, error: '' })
      },
      onError: error => {
        if (controller.signal.aborted) return
        console.error('Plan summary read:', error)
        setResult(previous => ({ identity, scope, metrics: previous?.scope === scope ? previous.metrics : {},
          error: 'โหลดจำนวนบิลและสินค้าไม่สำเร็จ กรุณาลองใหม่ หรือติดต่อผู้ดูแลระบบ' }))
      },
    })
    batch.request(['metrics'])
    let channel = supabase.channel('plan-work-order-metrics')
    for (const table of ['or_orders', 'or_order_items', 'pr_products']) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, payload => {
        if (planMetricsEventAffects(table, payload, ids)) batch.request(['metrics'])
      })
    }
    channel.subscribe()
    const onVisible = () => { if (document.visibilityState === 'visible') batch.request(['metrics']) }
    const timer = window.setInterval(onVisible, 60_000)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      controller.abort(); batch.dispose(); window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      void supabase.removeChannel(channel)
    }
  }, [identity, idsKey, scope, revision])
  // Retain valid totals for existing WOs while a membership change loads. Never
  // carry results across identities/roles/temporary Store access.
  const current = result?.scope === scope ? result : null
  return { metrics: current?.metrics || EMPTY_METRICS, error: current?.error || '', refresh }
}
